/**
 * Alarm intelligent analysis module
 *
 * Core mapping: appname → analyzer (model + prompt) + context
 * Falls back to statistical analysis when no match
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { type AnalysisConfig, type AnalysisModelConfig, type AnalysisAnalyzerConfig, type FieldFilterConfig, type SummaryConfig } from "./config.js";
import type { PrometheusConfig } from "./promClient.js";
import type { ExportData } from "./exporter.js";
import { type LogEntry, findField, findTraceId } from "./query.js";
import type { JaegerSpan, TraceStats } from "./traceAnalyzer.js";
import { queryAlarmMetrics, formatMetricsResults, type MetricsQueryParams, type MetricQueryResult } from "./promClient.js";
import { loadPromptFile } from "./promptLoader.js";

import { debug } from "./utils/logger.js";

// ─── Type definitions ───

/** Analysis result */
export interface AnalysisResult {
  /** Analysis type: llm or statistics */
  type: "llm" | "statistics";
  /** appname (used for mapping match) */
  appname: string | null;
  /** analyzer name (has value in llm mode) */
  analyzerName?: string;
  /** context name (has value in llm mode) */
  contextName?: string;
  /** LLM analysis result text (has value in llm mode) */
  analysisText?: string;
  /** Full prompt content sent to LLM (has value in llm mode) */
  llmInput?: string;
  /** Statistical summary (has value in statistics mode) */
  statistics?: StatisticsSummary;
}

/** Statistical analysis summary */
export interface StatisticsSummary {
  /** Total log count */
  totalLogs: number;
  /** Log level distribution */
  levelDistribution: Record<string, number>;
  /** Error Top N patterns */
  errorPatterns: ErrorPattern[];
  /** Trace error statistics */
  traceErrors: TraceError[];
  /** Slow call detection */
  slowCalls: SlowCall[];
}

export interface ErrorPattern {
  pattern: string;
  count: number;
}

export interface TraceError {
  from: string;
  to: string;
  errorCount: number;
  totalCount: number;
}

export interface SlowCall {
  from: string;
  to: string;
  avgDurationMs: number;
  p99DurationMs: number;
}

// ─── Mapping resolution ───

interface ResolvedMapping {
  analyzerConfig: AnalysisAnalyzerConfig;
  modelConfig: AnalysisModelConfig;
  contextName?: string;
  analyzerName: string;
}

/**
 * Find mapping by appname, return resolved analyzer + model config
 */
export function resolveMapping(
  analysisConfig: AnalysisConfig,
  appname: string
): ResolvedMapping | null {
  debug(`\n${"=".repeat(60)}\n[analyze] Step 1: Mapping match\n${"=".repeat(60)}\n`);
  debug(`[analyze] appname: ${appname}\n`);
  debug(`[analyze] mappings config: ${analysisConfig.mappings ? `${analysisConfig.mappings.length} entries` : "not configured"}\n`);

  // Iterate mappings to find appname
  for (const mapping of analysisConfig.mappings ?? []) {
    if (mapping.apps.includes(appname)) {
      const analyzerConfig = analysisConfig.analyzers[mapping.analyzer];
      if (!analyzerConfig) {
        debug(`[analyze] analyzer "${mapping.analyzer}" not defined, skipping\n`);
        debug(`[analyze] mapping matched apps containing "${appname}", but analyzer "${mapping.analyzer}" not defined, skipping\n`);
        continue;
      }

      const modelConfig = analysisConfig.models[analyzerConfig.model];
      if (!modelConfig) {
        debug(`[analyze] model "${analyzerConfig.model}" not defined, skipping\n`);
        debug(`[analyze] mapping matched apps containing "${appname}", but model "${analyzerConfig.model}" not defined, skipping\n`);
        continue;
      }

      debug(`[analyze] match successful → analyzer: "${mapping.analyzer}", model: "${analyzerConfig.model}", prompt: "${analyzerConfig.prompt || "sre-deep(built-in)"}", context: "${mapping.context || "none"}"\n`);
      return {
        analyzerConfig,
        modelConfig,
        contextName: mapping.context,
        analyzerName: mapping.analyzer,
      };
    }
  }

  debug(`[analyze] no mapping match\n`);
  return null;
}

// ─── Data filtering and truncation ───

/** Default max data character limit */
const DEFAULT_MAX_DATA_CHARS = 80000;

/** Default max log message characters (used in default filter mode) */
const MAX_LOG_MSG_CHARS = 500;

/**
 * Log field filtering (shared function, reused by agentTools.ts)
 *
 * Filter single log entry fields based on fieldFilter config:
 * - logFields not configured → default extracts 5 fields, message truncated to MAX_LOG_MSG_CHARS
 * - logFields = ["*"] → keep all fields, no truncation
 * - logFields = specific field list → extract by list, no truncation
 *
 * Regardless of mode, traceId field is guaranteed to exist (extracted from log, empty string if not found).
 */
export function filterLogEntry(log: LogEntry, fieldFilter?: FieldFilterConfig, traceIdField: string = "traceId"): Record<string, unknown> {
  const logFields = fieldFilter?.logFields;
  let result: Record<string, unknown>;
  if (isWildcard(logFields)) {
    result = log as Record<string, unknown>;
  } else if (logFields && logFields.length > 0) {
    result = filterLogFields(log, logFields);
  } else {
    result = summarizeLog(log);
  }
  // Ensure traceId always exists (custom field list may not include traceId)
  if (!result.traceId) {
    const tid = findTraceId(log, traceIdField);
    if (tid) result.traceId = tid;
  }
  return result;
}

/** Default log filtering (backwards compatible): extract key fields and merge synonymous fields */
function summarizeLog(log: LogEntry): Record<string, unknown> {
  const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
  const level = findField(log, "level") || findField(log, "severity") || "";
  const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
  const appname = findField(log, "appname") || findField(log, "application") || "";
  const traceId = findField(log, "traceId") || findField(log, "trace_id") || "";

  const result: Record<string, unknown> = {};
  if (ts) result.timestamp = ts;
  if (level) result.level = level;
  if (appname) result.appname = appname;
  if (traceId) result.traceId = traceId;
  result.message = msg.length > MAX_LOG_MSG_CHARS ? msg.slice(0, MAX_LOG_MSG_CHARS) + "..." : msg;
  return result;
}

/** Default span filtering (backwards compatible): extract key fields */
function summarizeSpan(span: JaegerSpan): Record<string, unknown> {
  return {
    operationName: span.operationName,
    serviceName: span.serviceName,
    durationMs: span.durationMs ?? span.duration,
    hasError: span.hasError,
  };
}

/** Extract specified fields from log entry (custom field list mode) */
function filterLogFields(log: LogEntry, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value = findField(log, field);
    if (value) result[field] = value;
  }
  return result;
}

/** Extract specified fields from span (custom field list mode) */
function filterSpanFields(span: JaegerSpan, fields: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in span) {
      result[field] = span[field as keyof JaegerSpan];
    }
  }
  return result;
}

/** Check if field list is the "keep all" wildcard */
function isWildcard(fields: string[] | undefined): boolean {
  return !!fields && fields.length === 1 && fields[0] === "*";
}

/**
 * Field filtering (without truncation)
 *
 * - logFields/spanFields not configured → use summarizeLog/summarizeSpan default filtering
 * - logFields/spanFields = ["*"] → keep all fields
 * - logFields/spanFields = specific field list → extract by list
 */
function filterFields(data: ExportData, fieldFilter?: FieldFilterConfig): Record<string, unknown> {
  debug(`\n${"=".repeat(60)}\n[analyze] Step 2: Field filtering\n${"=".repeat(60)}\n`);

  const results = data.results as Record<string, unknown>;

  const logFields = fieldFilter?.logFields;
  const spanFields = fieldFilter?.spanFields;

  // Log field mode
  const logMode = isWildcard(logFields) ? "keep all(*)" : (logFields && logFields.length > 0) ? `custom(${logFields.length} fields)` : "default filter(summarizeLog)";
  const spanMode = isWildcard(spanFields) ? "keep all(*)" : (spanFields && spanFields.length > 0) ? `custom(${spanFields.length} fields)` : "default filter(summarizeSpan)";
  debug(`[analyze] fieldFilter config: logFields=${logMode}, spanFields=${spanMode}, maxDataChars=${fieldFilter?.maxDataChars ?? DEFAULT_MAX_DATA_CHARS}\n`);

  if (logFields && logFields.length > 0 && !isWildcard(logFields)) {
    debug(`[analyze] logFields list: ${JSON.stringify(logFields)}\n`);
  }
  if (spanFields && spanFields.length > 0 && !isWildcard(spanFields)) {
    debug(`[analyze] spanFields list: ${JSON.stringify(spanFields)}\n`);
  }

  // Process logs
  const rawLogs = (results.logs ?? []) as LogEntry[];
  const totalLogs = rawLogs.length;

  let filteredLogs: unknown[];
  if (isWildcard(logFields)) {
    filteredLogs = rawLogs;
  } else if (logFields && logFields.length > 0) {
    filteredLogs = rawLogs.map((log) => filterLogFields(log, logFields));
  } else {
    filteredLogs = rawLogs.map(summarizeLog);
  }

  // Process traces
  const rawTraces = (results.traces ?? []) as Array<{
    traceId: string;
    spans: JaegerSpan[];
    stats: TraceStats | null;
    logs: LogEntry[];
  }>;

  const filteredTraces = rawTraces.map((t) => {
    let filteredSpans: unknown[];
    if (isWildcard(spanFields)) {
      filteredSpans = t.spans;
    } else if (spanFields && spanFields.length > 0) {
      filteredSpans = t.spans.map((span) => filterSpanFields(span, spanFields));
    } else {
      filteredSpans = t.spans.map(summarizeSpan);
    }

    let filteredTraceLogs: unknown[];
    if (isWildcard(logFields)) {
      filteredTraceLogs = t.logs;
    } else if (logFields && logFields.length > 0) {
      filteredTraceLogs = t.logs.map((log) => filterLogFields(log, logFields));
    } else {
      filteredTraceLogs = t.logs.map(summarizeLog);
    }

    return {
      traceId: t.traceId,
      stats: t.stats,
      spans: filteredSpans,
      totalSpans: t.spans.length,
      logs: filteredTraceLogs,
      totalLogs: t.logs.length,
    };
  });

  // Debug: print first span and first log sample for each filtered trace
  for (let i = 0; i < filteredTraces.length; i++) {
    const t = filteredTraces[i] as { traceId: string; spans: unknown[]; logs: unknown[] };
    debug(`[analyze]   trace[${i}] "${t.traceId}": spans=${t.spans.length}, logs=${t.logs.length}`);
    if (t.spans.length > 0) {
      debug(`[analyze]     span sample: ${JSON.stringify(t.spans[0])}`);
    }
    if (t.logs.length > 0) {
      debug(`[analyze]     log sample: ${JSON.stringify(t.logs[0])}`);
    }
  }

  const result = {
    results: {
      traces: filteredTraces,
    },
  };

  const totalSpans = filteredTraces.reduce((s, t) => s + (t.totalSpans as number), 0);
  const totalTraceLogs = filteredTraces.reduce((s, t) => s + (t.totalLogs as number), 0);
  const resultSize = JSON.stringify(result, null, 2).length;

  // Debug: print character proportion of each part
  {
    const eventSize = JSON.stringify(results.event, null, 2).length;
    const tracesSize = JSON.stringify(filteredTraces, null, 2).length;
    debug(`[analyze] filter results: traces ${filteredTraces.length} entries, spans ${totalSpans} items, associated logs ${totalTraceLogs} entries, serialized ${resultSize} chars`);
    debug(`[analyze]   proportion breakdown: event=${eventSize} chars, traces=${tracesSize} chars`);
  }

  return result;
}

/**
 * Truncate data by character limit, ensuring no incomplete entries
 * Truncation order: logs first, then spans
 */
function truncateByCharLimit(data: Record<string, unknown>, maxChars: number): Record<string, unknown> {
  let json = JSON.stringify(data, null, 2);
  if (json.length <= maxChars) {
    debug(`[analyze] truncation check: ${json.length} chars ≤ ${maxChars}, no truncation needed\n`);
    return data;
  }

  debug(`[analyze] truncation check: ${json.length} chars > ${maxChars}, starting entry-level truncation\n`);

  const results = data.results as Record<string, unknown>;

  // Gradually reduce log count
  const logs = (results.logs ?? []) as unknown[];
  const traces = (results.traces ?? []) as Array<{ spans?: unknown[]; logs?: unknown[] }>;

  // Start trying from current log count
  for (let logCount = logs.length; logCount >= 0; logCount--) {
    const trial = {
      ...data,
      results: {
        ...results,
        logs: logs.slice(0, logCount),
        logsTruncated: logs.length > logCount,
      },
    };
    json = JSON.stringify(trial, null, 2);
    if (json.length <= maxChars) {
      debug(`[analyze] truncation result: logs kept ${logCount}/${logs.length} entries, final ${json.length} chars\n`);
      return trial;
    }
  }

  // Still over limit with all logs removed, continue reducing spans
  debug(`[analyze] still over limit with all logs removed, starting span truncation\n`);
  for (let spanCount = Math.max(...traces.map((t) => t.spans?.length ?? 0), 0); spanCount >= 0; spanCount--) {
    const trial = {
      ...data,
      results: {
        ...results,
        logs: [],
        logsTruncated: true,
        traces: traces.map((t) => ({
          ...t,
          spans: t.spans?.slice(0, spanCount),
          spansTruncated: (t.spans?.length ?? 0) > spanCount,
        })),
      },
    };
    json = JSON.stringify(trial, null, 2);
    if (json.length <= maxChars) {
      debug(`[analyze] truncation result: spans kept ${spanCount}, final ${json.length} chars\n`);
      return trial;
    }
  }

  // All spans removed too, only keep metadata
  debug(`[analyze] truncation result: logs and spans all truncated, only metadata retained\n`);
  return {
    command: data.command,
    timestamp: data.timestamp,
    params: data.params,
    results: {
      queryInfo: results.queryInfo,
      event: results.event,
      extractedParams: results.extractedParams,
      logs: [],
      logsTruncated: true,
      traces: [],
    },
  };
}

// ─── LLM incremental summarization ───

/** Default max characters per chunk */
const DEFAULT_CHUNK_SIZE = 20000;
/** Default summary target characters */
const DEFAULT_TARGET_SIZE = 4000;

// ─── Metrics-specific summarization ───

/**
 * Metrics-specific LLM incremental summarization
 * Same mechanism as summarizeByLLM, but uses independent system prompt
 */
async function summarizeMetricsByLLM(
  dataText: string,
  modelConfig: AnalysisModelConfig,
  summaryConfig: SummaryConfig,
  onProgress?: (msg: string) => void
): Promise<string> {
  const chunkSize = summaryConfig.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const targetSize = summaryConfig.targetSize ?? DEFAULT_TARGET_SIZE;

  // Load metrics summary prompts
  const metricsUserTemplate = loadPromptFile("metrics-summary-user");
  const metricsRefineTemplate = loadPromptFile("metrics-summary-refine");
  let metricsSystemPrompt = loadPromptFile("metrics-summary-system");
  if (summaryConfig.metricsPrompt) {
    try {
      metricsSystemPrompt = loadPromptFile(summaryConfig.metricsPrompt);
    } catch {
      // Custom prompt file does not exist, use default
    }
  }

  const chunks: string[] = [];
  for (let i = 0; i < dataText.length; i += chunkSize) {
    chunks.push(dataText.slice(i, i + chunkSize));
  }

  debug(`[metrics-summary] total data length ${dataText.length} chars, split into ${chunks.length} chunks\n`);
  onProgress?.(`Metrics data ${dataText.length} chars, summarizing in ${chunks.length} chunks`);

  let currentSummary = "";

  for (let i = 0; i < chunks.length; i++) {
    const userContent = metricsUserTemplate
      .replace(/\{\{previousSummary}}/g, currentSummary || "(none)")
      .replace(/\{\{chunk}}/g, chunks[i]);

    debug(`[metrics-summary] processing chunk ${i + 1}/${chunks.length}...\n`);
    onProgress?.(`Metrics summary chunk ${i + 1}/${chunks.length}...`);

    const url = `${modelConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const requestBody = {
      model: modelConfig.model,
      messages: [
        { role: "system", content: metricsSystemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: modelConfig.temperature ?? 0.3,
      max_tokens: modelConfig.maxTokens ?? 4096,
    };

    const startTime = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelConfig.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    const elapsed = Date.now() - startTime;
    debug(`[metrics-summary] response status: ${response.status}  elapsed: ${elapsed}ms\n`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Metrics summary LLM call failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Metrics summary LLM returned empty content");
    }

    currentSummary = content;
  }

  // Refine if over limit
  if (currentSummary.length > targetSize) {
    debug(`[metrics-summary] summary result ${currentSummary.length} chars exceeds target ${targetSize}, doing second round summary\n`);

    const refineUserContent = metricsRefineTemplate
      .replace(/\{\{currentSummary}}/g, currentSummary)
      .replace(/\{\{targetSize}}/g, String(targetSize));

    const url = `${modelConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const requestBody = {
      model: modelConfig.model,
      messages: [
        { role: "system", content: metricsSystemPrompt },
        { role: "user", content: refineUserContent },
      ],
      temperature: modelConfig.temperature ?? 0.3,
      max_tokens: modelConfig.maxTokens ?? 4096,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelConfig.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Metrics summary LLM second round call failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const refined = json.choices?.[0]?.message?.content;
    if (refined) {
      currentSummary = refined;
    }
  }

  debug(`[metrics-summary] ── Final metrics summary result (${currentSummary.length} chars) ──\n`);

  return currentSummary;
}

/**
 * LLM incremental summarization
 *
 * Split data into chunks by chunkSize, send each chunk to the summary model,
 * carrying the previous summary result as context each time, and output the merged summary.
 * If the merged result still exceeds targetSize, do another round of summarization.
 */
async function summarizeByLLM(
  dataText: string,
  modelConfig: AnalysisModelConfig,
  summaryConfig: SummaryConfig,
  onProgress?: (msg: string) => void
): Promise<string> {
  const chunkSize = summaryConfig.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const targetSize = summaryConfig.targetSize ?? DEFAULT_TARGET_SIZE;

  // Load summary prompts
  const summarySystemPrompt = loadPromptFile("summary-system");
  const summaryUserTemplate = loadPromptFile("summary-user");
  const summaryRefineTemplate = loadPromptFile("summary-refine");

  // Split into chunks
  const chunks: string[] = [];
  for (let i = 0; i < dataText.length; i += chunkSize) {
    chunks.push(dataText.slice(i, i + chunkSize));
  }

  debug(`[summary] total data length ${dataText.length} chars, split into ${chunks.length} chunks\n`);
  onProgress?.(`Data ${dataText.length} chars, summarizing in ${chunks.length} chunks`);

  let currentSummary = "";

  for (let i = 0; i < chunks.length; i++) {
    const userContent = summaryUserTemplate
      .replace(/\{\{previousSummary}}/g, currentSummary || "(none)")
      .replace(/\{\{chunk}}/g, chunks[i]);

    debug(`[summary] processing chunk ${i + 1}/${chunks.length}...\n`);
    onProgress?.(`Summary chunk ${i + 1}/${chunks.length}...`);

    const url = `${modelConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const requestBody = {
      model: modelConfig.model,
      messages: [
        { role: "system", content: summarySystemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: modelConfig.temperature ?? 0.3,
      max_tokens: modelConfig.maxTokens ?? 4096,
    };

    {
      const requestDebug = {
        url,
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${modelConfig.token.slice(0, 4)}****${modelConfig.token.slice(-4)}`,
        },
        body: { ...requestBody, messages: requestBody.messages.map((m) => ({ role: m.role, content: `[${m.content.length} chars]` })) },
      };
      debug(`[summary] request params:\n${JSON.stringify(requestDebug, null, 2)}`);
    }

    const startTime = Date.now();
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelConfig.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    const elapsed = Date.now() - startTime;
    debug(`[summary] response status: ${response.status}  elapsed: ${elapsed}ms\n`);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Summary LLM call failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    debug(`[summary] token usage: ${JSON.stringify(json.usage)}\n`);

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error("Summary LLM returned empty content");
    }

    currentSummary = content;
  }

  // If merged result still exceeds targetSize, do another round of summarization
  if (currentSummary.length > targetSize) {
    debug(`[summary] summary result ${currentSummary.length} chars exceeds target ${targetSize}, doing second round summary\n`);

    const refineUserContent = summaryRefineTemplate
      .replace(/\{\{currentSummary}}/g, currentSummary)
      .replace(/\{\{targetSize}}/g, String(targetSize));

    const url = `${modelConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const requestBody = {
      model: modelConfig.model,
      messages: [
        { role: "system", content: summarySystemPrompt },
        { role: "user", content: refineUserContent },
      ],
      temperature: modelConfig.temperature ?? 0.3,
      max_tokens: modelConfig.maxTokens ?? 4096,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelConfig.token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Summary LLM second round call failed (${response.status}): ${errorText}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const refined = json.choices?.[0]?.message?.content;
    if (refined) {
      currentSummary = refined;
    }
  }

  debug(`[summary] ── Final summary result start ──\n`);
  debug(currentSummary);
  debug(`\n[summary] ── Final summary result end (${currentSummary.length} chars) ──\n`);

  return currentSummary;
}

// ─── Prompt template loading ───

/** Default prompt name */
const DEFAULT_PROMPT_NAME = "sre-deep";

const CONTEXTS_DIR = join(homedir(), ".omc", "contexts");

/**
 * Read prompt template file, inject {{data}} and {{context}} variables
 *
 * Load priority (handled by loadPromptFile):
 * 1. User directory ~/.omc/prompts/<name>.md
 * 2. Project built-in prompts/<name>.md
 *
 * @param promptName prompt file name (without .md), uses sre-deep if not configured
 * @param dataString processed data string (JSON or summary text)
 * @param contextName optional context file name
 */
export function loadPromptTemplate(
  promptName: string | undefined,
  dataString: string,
  contextName?: string
): string {
  const name = promptName || DEFAULT_PROMPT_NAME;
  const template = loadPromptFile(name);

  // Inject context
  let contextContent = "";
  if (contextName) {
    try {
      const contextPath = join(CONTEXTS_DIR, `${contextName}.md`);
      contextContent = readFileSync(contextPath, "utf-8");
    } catch {
      debug(`[analyze] context file "${contextName}.md" does not exist, ignoring\n`);
    }
  }

  return template
    .replace(/\{\{data}}/g, dataString)
    .replace(/\{\{context}}/g, contextContent);
}

// ─── LLM call ───

/**
 * Call analysis LLM, return analysis result text
 */
export async function callAnalysisLLM(
  modelConfig: AnalysisModelConfig,
  analyzerConfig: AnalysisAnalyzerConfig,
  promptContent: string
): Promise<string> {
  const url = `${modelConfig.baseUrl.replace(/\/+$/, "")}/chat/completions`;

  const temperature = analyzerConfig.temperature ?? modelConfig.temperature ?? 0.3;
  const maxTokens = modelConfig.maxTokens ?? 4096;

  const requestBody = {
    model: modelConfig.model,
    messages: [
      { role: "user", content: promptContent },
    ],
    temperature,
    max_tokens: maxTokens,
  };

  {
    const requestDebug = {
      url,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${modelConfig.token.slice(0, 4)}****${modelConfig.token.slice(-4)}`,
      },
      body: { ...requestBody, messages: [{ role: "user", content: `[${promptContent.length} chars]` }] },
    };
    debug(`[analyze] request params:\n${JSON.stringify(requestDebug, null, 2)}`);
  }

  const startTime = Date.now();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${modelConfig.token}`,
    },
    body: JSON.stringify(requestBody),
  });

  const elapsed = Date.now() - startTime;
  debug(`[analyze] response status: ${response.status}  elapsed: ${elapsed}ms\n`);

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Analysis LLM call failed (${response.status}): ${errorText}`);
  }

  const json = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  debug(`[analyze] token usage: ${JSON.stringify(json.usage)}\n`);

  const content = json.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Analysis LLM returned empty content");
  }

  return content;
}

// ─── Fallback statistical analysis ───

/**
 * Generate statistical analysis summary (fallback mode)
 */
export function generateStatistics(exportData: ExportData): StatisticsSummary {
  const results = exportData.results;
  const summary: StatisticsSummary = {
    totalLogs: 0,
    levelDistribution: {},
    errorPatterns: [],
    traceErrors: [],
    slowCalls: [],
  };

  // Get log list
  const logs = (results.logs ?? []) as LogEntry[];
  summary.totalLogs = logs.length;

  // Log level distribution
  for (const log of logs) {
    const level = (findField(log, "level") || findField(log, "severity") || "INFO").toUpperCase();
    summary.levelDistribution[level] = (summary.levelDistribution[level] || 0) + 1;
  }

  // Error log pattern clustering (group by message prefix and count)
  const errorLogs = logs.filter((log) => {
    const level = (findField(log, "level") || findField(log, "severity") || "").toUpperCase();
    return level === "ERROR" || level === "FATAL";
  });

  const patternCount = new Map<string, number>();
  for (const log of errorLogs) {
    const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
    // Take first 80 characters as pattern
    const pattern = msg.slice(0, 80) || "(empty message)";
    patternCount.set(pattern, (patternCount.get(pattern) || 0) + 1);
  }

  summary.errorPatterns = [...patternCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([pattern, count]) => ({ pattern, count }));

  // Trace error statistics
  const traces = (results.traces ?? []) as Array<{
    traceId: string;
    spans: JaegerSpan[];
    stats: TraceStats | null;
    logs: LogEntry[];
  }>;

  if (traces.length > 0) {
    // Count call pairs with errors
    const errorPairCount = new Map<string, { errorCount: number; totalCount: number }>();

    for (const trace of traces) {
      if (!trace.spans) continue;
      for (const span of trace.spans) {
        const key = `${span.serviceName} → ${span.operationName}`;
        if (!errorPairCount.has(key)) {
          errorPairCount.set(key, { errorCount: 0, totalCount: 0 });
        }
        const entry = errorPairCount.get(key)!;
        entry.totalCount++;
        if (span.hasError) entry.errorCount++;
      }
    }

    summary.traceErrors = [...errorPairCount.entries()]
      .filter(([, v]) => v.errorCount > 0)
      .sort((a, b) => b[1].errorCount - a[1].errorCount)
      .slice(0, 5)
      .map(([key, v]) => {
        const [from, to] = key.split(" → ");
        return { from, to, errorCount: v.errorCount, totalCount: v.totalCount };
      });

    // Slow call detection
    const durationMap = new Map<string, number[]>();
    for (const trace of traces) {
      if (!trace.spans) continue;
      for (const span of trace.spans) {
        if (!span.serviceName || !span.operationName) continue;
        const key = `${span.serviceName} → ${span.operationName}`;
        if (!durationMap.has(key)) durationMap.set(key, []);
        const dur = span.durationMs ?? span.duration;
        durationMap.get(key)!.push(dur);
      }
    }

    summary.slowCalls = [...durationMap.entries()]
      .map(([key, durations]) => {
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const sorted = [...durations].sort((a, b) => a - b);
        const p99Idx = Math.min(Math.floor(durations.length * 0.99), durations.length - 1);
        const p99 = sorted[p99Idx];
        const [from, to] = key.split(" → ");
        return { from, to, avgDurationMs: Math.round(avg), p99DurationMs: Math.round(p99) };
      })
      .filter((c) => c.p99DurationMs > 1000) // P99 > 1s considered slow call
      .sort((a, b) => b.p99DurationMs - a.p99DurationMs)
      .slice(0, 5);
  }

  return summary;
}

// ─── Shared analysis entry point ───

/**
 * Extract appname from export data
 * Priority: command args → first log entry → null
 */
export function extractAppnameFromData(exportData: ExportData): string | null {
  // 1. Extract from command params
  const params = exportData.params as Record<string, unknown>;
  const logOptions = params?.logOptions as Record<string, unknown> | undefined;
  if (logOptions?.appname && typeof logOptions.appname === "string") {
    return logOptions.appname;
  }
  // Also check params directly for appname
  if (params?.appname && typeof params.appname === "string") {
    return params.appname;
  }

  // 2. Get from first log entry
  const logs = (exportData.results?.logs ?? []) as LogEntry[];
  if (logs.length > 0) {
    const appname = findField(logs[0], "appname") || findField(logs[0], "application");
    if (appname) return appname;
  }

  return null;
}

/**
 * Shared analysis entry point
 *
 * @param appname known appname (extracted from drill results in online mode)
 * @param exportData alarm-drill export structured data
 * @param analysisConfig analysis config
 * @param onProgress progress callback (for UI sub-step display)
 * @param promConfig optional Prometheus config (query metrics if available)
 * @param prometheusUrl optional Prometheus remoteRead URL
 * @returns analysis result
 */
export async function analyzeAlarm(
  appname: string | null,
  exportData: ExportData,
  analysisConfig: AnalysisConfig,
  onProgress?: (msg: string) => void,
  promConfig?: PrometheusConfig,
  prometheusUrl?: string
): Promise<AnalysisResult> {
  // Try mapping match
  onProgress?.("Mapping match...");
  let resolved = appname ? resolveMapping(analysisConfig, appname) : null;

  // When no mapping match, try default analyzer
  if (!resolved) {
    const defaultAnalyzer = analysisConfig.analyzers["default"];
    if (defaultAnalyzer) {
      const modelConfig = analysisConfig.models[defaultAnalyzer.model];
      if (modelConfig) {
        resolved = {
          analyzerConfig: defaultAnalyzer,
          modelConfig,
          analyzerName: "default",
        };
        debug(`[analyze] no mapping match, using default analyzer: model="${defaultAnalyzer.model}", prompt="${defaultAnalyzer.prompt || "sre-deep(built-in)"}"\n`);
      }
    }
  }

  // Still no match, fallback to statistical analysis
  if (!resolved) {
    debug(`[analyze] no mapping match and no default analyzer, falling back to statistical analysis\n`);
    return {
      type: "statistics",
      appname,
      statistics: generateStatistics(exportData),
    };
  }

  // ── Step 2: Field filtering (without truncation) ──
  onProgress?.("Field filtering...");
  const fieldFilter = analysisConfig.fieldFilter;
  const filteredData = filterFields(exportData, fieldFilter);

  // ── Step 2.5: Metrics query (if promConfig + prometheusUrl are available) ──
  let metricsResults: MetricQueryResult[] | undefined;
  let metricsFormattedText: string | undefined;
  let metricsSummaryText: string | undefined;

  // Prefer existing metrics data in exportData
  const existingMetrics = (exportData.results as Record<string, unknown>).metrics as MetricQueryResult[] | undefined;
  const extractedStartTime = (exportData.results as Record<string, unknown>).extractedParams
    ? ((exportData.results as Record<string, unknown>).extractedParams as Record<string, unknown>).startTime as number | undefined
    : undefined;

  if (existingMetrics?.length) {
    metricsResults = existingMetrics;
    metricsFormattedText = formatMetricsResults(metricsResults, extractedStartTime ?? 0);
    debug(`[analyze] using existing metrics data: ${metricsResults.length} results, formatted text ${metricsFormattedText.length} chars\n`);
  } else if (promConfig && prometheusUrl) {
    onProgress?.("Querying metrics...");
    debug(`\n${"=".repeat(60)}\n[analyze] Step 2.5: Prometheus metrics query\n${"=".repeat(60)}\n`);

    try {
      debug(`[analyze] prometheusUrl: ${prometheusUrl}\n`);

      // Extract MetricsQueryParams from exportData
      const results = exportData.results as Record<string, unknown>;
      const extractedParams = results.extractedParams as Record<string, unknown> | undefined;

      const startTime = extractedParams?.startTime as number | undefined;
      const endTime = extractedParams?.endTime as number | undefined;

      if (startTime && appname) {
        const metricsParams: MetricsQueryParams = {
          appname,
          podname: (extractedParams?.podname as string) || undefined,
          apiPath: (extractedParams?.apiPath as string) || undefined,
          servicer: (extractedParams?.servicer as string[]) || undefined,
          downstreamApi: (extractedParams?.downstreamApi as string[]) || undefined,
          startTime,
          endTime: endTime || startTime + 1800,
        };

        debug(`[analyze] metricsParams: ${JSON.stringify(metricsParams)}\n`);

        metricsResults = await queryAlarmMetrics(promConfig, prometheusUrl, metricsParams, (msg) => onProgress?.(msg));
        metricsFormattedText = formatMetricsResults(metricsResults, startTime);

        debug(`[analyze] metrics query completed: ${metricsResults.length} results, formatted text ${metricsFormattedText.length} chars\n`);

        // Inject into exportData
        (exportData.results as Record<string, unknown>).metrics = metricsResults;
      } else {
        debug(`[analyze] missing startTime or appname, skipping metrics query\n`);
      }
    } catch (err) {
      debug(`[analyze] metrics query failed: ${err instanceof Error ? err.message : String(err)}\n`);
      // Metrics query failure does not interrupt analysis
    }
  }

  // ── Step 3: Generate data string ──
  const summaryConfig = analysisConfig.summary;
  const maxDataChars = fieldFilter?.maxDataChars ?? DEFAULT_MAX_DATA_CHARS;
  let dataString: string;

  if (summaryConfig?.enabled) {
    onProgress?.("LLM incremental summarization...");
    debug(`\n${"=".repeat(60)}\n[analyze] Step 3: LLM incremental summarization\n${"=".repeat(60)}\n`);
    debug(`[analyze] summary config: model="${summaryConfig.model || "reuse analysis model"}", chunkSize=${summaryConfig.chunkSize ?? DEFAULT_CHUNK_SIZE}, targetSize=${summaryConfig.targetSize ?? DEFAULT_TARGET_SIZE}\n`);

    // Determine summary model config
    let summaryModelConfig = resolved.modelConfig;
    if (summaryConfig.model && analysisConfig.models[summaryConfig.model]) {
      summaryModelConfig = analysisConfig.models[summaryConfig.model];
    }
    debug(`[analyze] summary model: ${summaryModelConfig.model} @ ${summaryModelConfig.baseUrl.replace(/\/+$/, "")}\n`);

    // ── Categorized summarization ──
    const results = exportData.results as Record<string, unknown>;
    const extractedParams = results.extractedParams;

    // 1. Metrics summary (using independent prompt)
    if (metricsFormattedText && metricsFormattedText.length > 0 && metricsFormattedText !== "(no data)") {
      onProgress?.("Metrics summary...");
      debug(`[analyze] metrics data: ${metricsFormattedText.length} chars, sending to metrics summary model\n`);

      try {
        metricsSummaryText = await summarizeMetricsByLLM(metricsFormattedText, summaryModelConfig, summaryConfig, (msg) => onProgress?.(msg));
        debug(`[analyze] metrics summary completed: ${metricsSummaryText.length} chars\n`);
      } catch (err) {
        debug(`[analyze] metrics summary failed: ${err instanceof Error ? err.message : String(err)}\n`);
        metricsSummaryText = metricsFormattedText.slice(0, 4000);
      }
    }

    // 2. Trace/log summary
    onProgress?.("Log/trace summary...");
    const filteredJson = JSON.stringify(filteredData, null, 2);
    debug(`[analyze] filtered data: ${filteredJson.length} chars, sending to summary model\n`);

    // Print data structure overview
    const fd = filteredData as Record<string, unknown>;
    const fdResults = fd.results as Record<string, unknown> | undefined;
    const fdTraces = (fdResults?.traces ?? []) as Array<{ traceId?: string; spans?: unknown[]; logs?: unknown[] }>;
    const fdLogs = (fdResults?.logs ?? []) as unknown[];
    debug(`[analyze] data structure: top-level logs=${fdLogs.length} entries, traces=${fdTraces.length} entries\n`);

    const traceLogSummaryText = await summarizeByLLM(filteredJson, summaryModelConfig, summaryConfig, (msg) => onProgress?.(msg));
    debug(`[analyze] trace/log summary completed: ${traceLogSummaryText.length} chars\n`);

    // 3. Assemble data string
    const dataParts: string[] = [
      "=== Alarm Event ===",
      JSON.stringify(results.event, null, 2),
      "",
      "=== Extracted Parameters ===",
      JSON.stringify(extractedParams, null, 2),
    ];

    if (metricsSummaryText) {
      dataParts.push("", "=== System Metrics ===", metricsSummaryText);
    }

    dataParts.push("", "=== Traces ===", traceLogSummaryText, "", "=== Associated Logs ===", "(already included in the trace summary above)");
    dataString = dataParts.join("\n");

    // Truncation
    if (dataString.length > maxDataChars) {
      debug(`[analyze] still over limit after summarization ${dataString.length} > ${maxDataChars}, truncated\n`);
      dataString = dataString.slice(0, maxDataChars) + "\n... (Data truncated)";
    }
  } else {
    onProgress?.("Truncating data by entry...");
    debug(`\n${"=".repeat(60)}\n[analyze] Step 3: Entry-level truncation (LLM summarization not enabled)\n${"=".repeat(60)}\n`);
    // Non-LLM summary mode: field filter then entry-level truncation
    const truncatedData = truncateByCharLimit(filteredData, maxDataChars);

    // If metrics data exists, append to truncated JSON
    if (metricsFormattedText && metricsFormattedText.length > 0 && metricsFormattedText !== "(no data)") {
      const truncatedJson = JSON.stringify(truncatedData, null, 2);
      dataString = truncatedJson + "\n\n=== System Metrics ===\n" + metricsFormattedText;

      if (dataString.length > maxDataChars) {
        dataString = dataString.slice(0, maxDataChars) + "\n... (Data truncated)";
      }
    } else {
      dataString = JSON.stringify(truncatedData, null, 2);
    }
  }

  debug(`[analyze] final injected {{data}} length: ${dataString.length} chars\n`);

  // ── Step 4: Load prompt template and call analysis LLM ──
  onProgress?.("Calling analysis model...");
  debug(`\n${"=".repeat(60)}\n[analyze] Step 4: Prompt loading & LLM call\n${"=".repeat(60)}\n`);
  const promptContent = loadPromptTemplate(
    resolved.analyzerConfig.prompt,
    dataString,
    resolved.contextName
  );

  debug(`[analyze] prompt total length: ${promptContent.length} chars\n`);
  debug(`[analyze] analysis model: ${resolved.modelConfig.model} @ ${resolved.modelConfig.baseUrl.replace(/\/+$/, "")}\n`);
  debug(`[analyze] analysis params: temperature=${resolved.analyzerConfig.temperature ?? resolved.modelConfig.temperature ?? 0.3}, max_tokens=${resolved.modelConfig.maxTokens ?? 4096}\n`);

  // Print full prompt (for debugging, may be very long)
  debug(`[analyze] ── Full prompt start ──`);
  debug(promptContent);
  debug(`[analyze] ── Full prompt end ──`);

  const analysisText = await callAnalysisLLM(
    resolved.modelConfig,
    resolved.analyzerConfig,
    promptContent
  );

  return {
    type: "llm",
    appname,
    analyzerName: resolved.analyzerName,
    contextName: resolved.contextName,
    analysisText,
    llmInput: promptContent,
  };
}
