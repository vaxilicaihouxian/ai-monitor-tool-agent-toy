/**
 * ANSI output formatting module
 *
 * Renders structured data such as logs, trace, alarm drill-down, alarm analysis,
 * Prometheus metrics, and help text as colored terminal strings, with incremental output support.
 */
import chalk from "chalk";
import { type LogEntry, findField } from "../query.js";
import {
  formatTraceTree,
  buildCallTree,
  calculateDepths,
  type JaegerSpan,
  type TraceStats,
  type ViewType,
  type TraceTreeNode,
} from "../traceAnalyzer.js";
import { type DrillTraceGroup } from "../types.js";
import { type AnalysisResult, type StatisticsSummary } from "../alarmAnalyzer.js";
import { formatMarkdown } from "./markdown.js";

// ─── Log level colors ───

const LEVEL_COLORS: Record<string, (s: string) => string> = {
  ERROR: chalk.red,
  FATAL: chalk.redBright,
  WARN: chalk.yellow,
  INFO: chalk.green,
  DEBUG: chalk.gray,
  TRACE: chalk.gray,
};

function detectLevel(log: LogEntry): string {
  for (const val of Object.values(log)) {
    if (typeof val === "string" && LEVEL_COLORS[val.toUpperCase()]) {
      return val.toUpperCase();
    }
  }
  return "INFO";
}

// ─── Log formatting ───

export function formatLogsOutput(logs: LogEntry[], queryInfo?: string): string {
  if (logs.length === 0) {
    return chalk.yellow("No log data");
  }

  const lines: string[] = [];

  if (queryInfo) {
    lines.push(chalk.cyan.bold("Log query") + chalk.gray(` — ${queryInfo}`));
    lines.push(chalk.gray("─".repeat(60)));
  }

  lines.push(chalk.dim(`${logs.length} logs total`));
  lines.push("");

  for (const log of logs) {
    const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
    const level = detectLevel(log);
    const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
    const shortTs = ts.replace(/\.\d+Z$/, "Z").replace("T", " ");
    const colorFn = LEVEL_COLORS[level] || chalk.white;

    const header = `[${shortTs}] [${colorFn(level)}]`;
    lines.push(`${header} ${chalk.gray("message:")} ${msg}`);
    // Full JSON (indented)
    lines.push(chalk.gray(JSON.stringify(log, null, 2)));
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Trace formatting ───

function formatTraceTreeANSI(spans: JaegerSpan[]): string {
  if (spans.length === 0) return chalk.gray("(no span data)");
  const tree = buildCallTree(spans);
  const totalDuration = Math.max(...spans.map((s) => s.duration || 0));
  return formatTreeNodeANSI(tree, "", totalDuration);
}

function formatTreeNodeANSI(nodes: TraceTreeNode[], prefix: string, totalDuration: number): string {
  const lines: string[] = [];

  nodes.forEach((node, index) => {
    const isLast = index === nodes.length - 1;
    const connector = prefix + (isLast ? "└─ " : "├─ ");
    const statusIcon = node.hasError ? chalk.red("✕") : chalk.green("✓");
    const service = chalk.cyan(node.serviceName || "unknown");
    const operation = node.operationName || "unknown";
    const shortOp = operation.split("/").pop() || operation;
    const duration = node.durationMs ? chalk.yellow(`${node.durationMs}ms`) : "";
    const percent = totalDuration && node.duration
      ? chalk.gray(`(${((node.duration / totalDuration) * 100).toFixed(1)}%)`)
      : "";

    lines.push(`${chalk.gray(connector)}${statusIcon} ${service}${chalk.gray(" → ")}${shortOp}  ${duration} ${percent}`);

    if (node.children && node.children.length > 0) {
      const childPrefix = prefix + (isLast ? "   " : "│  ");
      lines.push(formatTreeNodeANSI(node.children, childPrefix, totalDuration));
    }
  });

  return lines.join("\n");
}

function formatTimelineANSI(spans: JaegerSpan[]): string {
  if (spans.length === 0) return chalk.gray("(no span data)");

  const TERM_BAR_WIDTH = 40;
  const totalDuration = Math.max(...spans.map((s) => s.duration || 0));
  const minStartTime = Math.min(...spans.map((s) => s.startTime || 0));
  const totalRange = Math.max(
    totalDuration,
    Math.max(...spans.map((s) => (s.startTime || 0) + (s.duration || 0))) - minStartTime
  );

  const sortedSpans = [...spans].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const depthMap = calculateDepths(spans);

  const lines: string[] = [];
  lines.push(chalk.cyan("Timeline view") + chalk.gray(` (total duration: ${Math.floor(totalDuration / 1000)}ms)`));
  lines.push(chalk.gray("─".repeat(TERM_BAR_WIDTH + 20)));

  for (const span of sortedSpans) {
    const depth = depthMap[span.spanId] || 0;
    const indent = "  ".repeat(Math.min(depth, 6));
    const offset = span.startTime ? ((span.startTime - minStartTime) / totalRange) * TERM_BAR_WIDTH : 0;
    const width = span.duration ? Math.max((span.duration / totalRange) * TERM_BAR_WIDTH, 2) : 2;
    const service = span.serviceName || "unknown";
    const operation = span.operationName || "unknown";
    const shortOp = operation.split("/").pop() || operation;
    const duration = span.durationMs ? `${span.durationMs}ms` : "N/A";
    const barOffset = " ".repeat(Math.floor(offset));
    const barChar = span.hasError ? "█" : "▓";
    const bar = barChar.repeat(Math.max(Math.floor(width), 1));
    const statusIcon = span.hasError ? chalk.red("✕") : chalk.green("✓");
    const barColored = span.hasError ? chalk.red(barOffset + bar) : chalk.green(barOffset + bar);

    lines.push(`${indent}${statusIcon} ${chalk.yellow(duration.padEnd(8))}${barColored} ${chalk.cyan(service)}${chalk.gray(" → ")}${shortOp}`);
  }

  return lines.join("\n");
}

function formatSimpleANSI(spans: JaegerSpan[]): string {
  if (spans.length === 0) return chalk.gray("(no span data)");

  const sortedSpans = [...spans].sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
  const lines: string[] = [];
  lines.push(chalk.cyan("Span list:"));
  lines.push(chalk.gray("─".repeat(60)));

  sortedSpans.forEach((span, idx) => {
    const service = span.serviceName || "unknown";
    const operation = span.operationName || "unknown";
    const shortOp = operation.split("/").pop() || operation;
    const duration = span.durationMs ? `${span.durationMs}ms` : "N/A";
    const parent = span.parentSpanId ? `← ${span.parentSpanId.substring(0, 8)}` : "(root)";
    const statusIcon = span.hasError ? chalk.red("✕") : chalk.green("✓");

    lines.push(`${statusIcon} ${chalk.gray(`[${String(idx + 1).padStart(2)}]`)} ${chalk.yellow(duration.padEnd(10))}${chalk.gray(parent.padEnd(12))}${chalk.cyan(service)}${chalk.gray(" → ")}${shortOp}`);
  });

  return lines.join("\n");
}

export function formatTraceOutput(
  spans: JaegerSpan[],
  stats: TraceStats | null,
  logs: LogEntry[],
  viewType: ViewType,
  queryInfo?: string,
  logSource?: string,
): string {
  const lines: string[] = [];

  if (queryInfo) {
    lines.push(chalk.cyan.bold("Trace") + chalk.gray(` — ${queryInfo}`));
    lines.push(chalk.gray("─".repeat(60)));
  }

  if (stats) {
    lines.push(chalk.dim(`Spans: ${stats.spanCount}  Duration: ${stats.totalDurationMs}ms  Errors: ${stats.errorCount}  Services: ${stats.services.join(", ")}`));
    if (stats.rootOperation) {
      lines.push(chalk.dim(`Root call: ${stats.rootOperation}`));
    }
    lines.push("");
  }

  // Trace view
  switch (viewType) {
    case "timeline":
      lines.push(formatTimelineANSI(spans));
      break;
    case "simple":
      lines.push(formatSimpleANSI(spans));
      break;
    default:
      lines.push(formatTraceTreeANSI(spans));
  }

  // Associated logs
  if (logs.length > 0) {
    lines.push("");
    lines.push(chalk.cyan.bold(`── Associated logs (${logs.length}) ──`));
    for (const log of logs) {
      const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
      const level = detectLevel(log);
      const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
      const shortTs = ts.replace(/\.\d+Z$/, "Z").replace("T", " ");
      const colorFn = LEVEL_COLORS[level] || chalk.white;
      lines.push(`[${shortTs}] [${colorFn(level)}] ${chalk.gray("message:")} ${msg}`);
    }
  }

  return lines.join("\n");
}

// ─── Alarm Drill formatting ───

export function formatAlarmDrillOutput(
  traces: DrillTraceGroup[],
  extractedInfo: string,
  queryInfo: string,
  metricsText?: string,
): string {
  const lines: string[] = [];

  lines.push(chalk.cyan.bold("Alarm Drill") + chalk.gray(` — ${queryInfo} | ${traces.reduce((s, t) => s + 1, 0)} traces`));
  lines.push(chalk.gray("═".repeat(70)));

  if (extractedInfo) {
    lines.push(chalk.dim(`Extracted conditions: ${extractedInfo}`));
    lines.push("");
  }

  // Metrics section
  if (metricsText) {
    lines.push(chalk.cyan("═".repeat(70)));
    lines.push(chalk.cyan("Metrics overview"));
    lines.push(chalk.cyan("═".repeat(70)));
    lines.push(metricsText);
    lines.push("");
  }

  for (let i = 0; i < traces.length; i++) {
    const { traceId, spans, stats, logs } = traces[i];

    if (i > 0) lines.push("");
    lines.push(chalk.cyan("═".repeat(70)));
    lines.push(chalk.yellow.bold(`[${i + 1}/${traces.length}] TraceId: ${traceId}`));
    lines.push(chalk.cyan("═".repeat(70)));

    if (stats) {
      lines.push(chalk.gray(`  Spans: ${stats.spanCount}  Duration: ${stats.totalDurationMs}ms  Errors: ${stats.errorCount}  Services: ${stats.services.join(", ")}`));
      if (stats.rootOperation) lines.push(chalk.gray(`  Root call: ${stats.rootOperation}`));
    } else {
      lines.push(chalk.gray("  (No trace data)"));
    }

    if (spans.length > 0) {
      lines.push("");
      lines.push(chalk.cyan.bold("── Call chain ──"));
      lines.push(formatTraceTreeANSI(spans));
    }

    if (logs.length > 0) {
      lines.push("");
      lines.push(chalk.cyan.bold(`── Associated logs (${logs.length}) ──`));
      for (const log of logs) {
        const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
        const level = detectLevel(log);
        const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
        const shortTs = ts.replace(/\.\d+Z$/, "Z").replace("T", " ");
        const colorFn = LEVEL_COLORS[level] || chalk.white;
        lines.push(`[${shortTs}] [${colorFn(level)}] ${chalk.gray("message:")} ${msg}`);
      }
    }
  }

  return lines.join("\n");
}

// ─── Alarm Analyze formatting ───

function formatStatisticsANSI(stats: StatisticsSummary): string {
  const lines: string[] = [];

  lines.push(chalk.cyan.bold("=== Statistical summary ==="));
  lines.push(`Total logs: ${stats.totalLogs}`);

  const levelParts = Object.entries(stats.levelDistribution)
    .sort((a, b) => {
      const order = ["ERROR", "FATAL", "WARN", "INFO", "DEBUG"];
      return order.indexOf(a[0]) - order.indexOf(b[0]);
    })
    .map(([level, count]) => `${LEVEL_COLORS[level]?.(level) || level}: ${count}`);
  if (levelParts.length > 0) {
    lines.push(`  ${levelParts.join("  ")}`);
  }

  if (stats.errorPatterns.length > 0) {
    lines.push("");
    lines.push(`Error Top ${stats.errorPatterns.length} patterns:`);
    for (let i = 0; i < stats.errorPatterns.length; i++) {
      const p = stats.errorPatterns[i];
      lines.push(`  ${i + 1}. [${chalk.red(`${p.count}`)}] ${p.pattern}`);
    }
  }

  if (stats.traceErrors.length > 0) {
    lines.push("");
    lines.push("Trace anomalies:");
    for (const e of stats.traceErrors) {
      const rate = e.totalCount > 0 ? Math.round((e.errorCount / e.totalCount) * 100) : 0;
      lines.push(chalk.yellow(`  - ${e.from} → ${e.to}: Error rate ${rate}%`));
    }
  }

  if (stats.slowCalls.length > 0) {
    lines.push("");
    lines.push("Duration anomalies:");
    for (const c of stats.slowCalls) {
      lines.push(chalk.yellow(`  - ${c.from} → ${c.to}: avg ${c.avgDurationMs}ms (P99: ${c.p99DurationMs}ms)`));
    }
  }

  return lines.join("\n");
}

export function formatAlarmAnalyzeOutput(
  result: AnalysisResult,
  queryInfo: string,
): string {
  const lines: string[] = [];

  lines.push(chalk.cyan.bold("Alarm Analyze") + chalk.gray(` — ${queryInfo}`));
  lines.push(chalk.gray("─".repeat(60)));

  if (result.type === "llm") {
    lines.push(chalk.yellow(`Analysis mode: LLM (analyzer: ${result.analyzerName}${result.contextName ? `, context: ${result.contextName}` : ""})`));
  } else {
    lines.push(chalk.yellow("Analysis mode: Statistical (no LLM mapping, fallback to statistical summary)"));
  }

  if (result.appname) {
    lines.push(chalk.green(`App: ${result.appname}`));
  }

  lines.push("");

  if (result.type === "llm" && result.analysisText) {
    // Render LLM analysis result as Markdown
    lines.push(formatMarkdown(result.analysisText));
  } else if (result.statistics) {
    lines.push(formatStatisticsANSI(result.statistics));
  }

  return lines.join("\n");
}

// ─── Metrics formatting ───

import { type PromQueryResult } from "../promClient.js";

export function formatMetricsOutput(
  raw: PromQueryResult,
  queryInfo?: string,
  debugInfo?: string,
): string {
  const lines: string[] = [];

  if (queryInfo) {
    lines.push(chalk.cyan.bold("Metrics") + chalk.gray(` — ${queryInfo}`));
    lines.push(chalk.gray("─".repeat(60)));
  }

  if (debugInfo) {
    lines.push(chalk.gray(debugInfo));
    lines.push("");
  }

  const series = raw.result;
  if (!series || series.length === 0) {
    lines.push(chalk.yellow("(no data)"));
    return lines.join("\n");
  }

  for (const s of series) {
    const labels = Object.entries(s.metric)
      .filter(([k]) => k !== "__name__")
      .map(([k, v]) => `${k}="${v}"`)
      .join(", ");
    lines.push(chalk.cyan(`{${labels}}`));

    if (s.values && s.values.length > 0) {
      const step = Math.max(1, Math.ceil(s.values.length / 40));
      const sampled = s.values.filter((_, i) => i % step === 0);
      const timeRange = `${new Date(s.values[0][0] * 1000).toISOString()} → ${new Date(s.values[s.values.length - 1][0] * 1000).toISOString()}`;
      lines.push(chalk.dim(`  Time: ${timeRange} (${s.values.length} points)`));
      lines.push(`  Values: [${sampled.map((v) => parseFloat(v[1]).toFixed(2)).join(", ")}]`);
    } else if (s.value) {
      lines.push(`  Value: ${parseFloat(s.value[1]).toFixed(2)}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ─── Alert formatting ───

export function formatAlertOutput(event: Record<string, unknown> | null, eventId: string, queryInfo?: string): string {
  const lines: string[] = [];

  lines.push(chalk.cyan.bold("Alert") + chalk.gray(` — ${queryInfo || eventId}`));
  lines.push(chalk.gray("─".repeat(60)));

  if (event) {
    lines.push(JSON.stringify(event, null, 2));
  } else {
    lines.push(chalk.yellow(`No event data (eventId: ${eventId})`));
  }

  return lines.join("\n");
}

// ─── Help formatting ───

import { HELP_TEXT } from "../commands.js";

export function formatHelpOutput(): string {
  const lines = HELP_TEXT.split("\n");
  return lines.map((line) => {
    if (line.startsWith("  /")) return chalk.green(line);
    if (line.startsWith("  q") || line.includes("back")) return chalk.yellow(line);
    return line;
  }).join("\n");
}

// ─── Incremental output formatting (output each step as it completes) ───

/** Step 1: Parameter extraction complete, output extracted conditions */
export function formatExtractedParamsOutput(cmdTitle: string, queryInfo: string, extractedInfo: string): string {
  const lines: string[] = [];
  lines.push(chalk.cyan.bold(cmdTitle) + chalk.gray(` — ${queryInfo}`));
  lines.push(chalk.gray("═".repeat(70)));
  lines.push(chalk.dim(`Extracted conditions: ${extractedInfo}`));
  return lines.join("\n");
}

const MAX_LOG_PREVIEW = 15;

/** Step 2: Log query complete, output logs (show at most MAX_LOG_PREVIEW lines) */
export function formatLogsChunkOutput(logs: LogEntry[]): string {
  if (logs.length === 0) return chalk.yellow("No log data");
  const lines: string[] = [];
  lines.push(chalk.cyan.bold(`── Logs (${logs.length}) ──`));
  const show = logs.slice(0, MAX_LOG_PREVIEW);
  for (const log of show) {
    const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
    const level = detectLevel(log);
    const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
    const shortTs = ts.replace(/\.\d+Z$/, "Z").replace("T", " ");
    const colorFn = LEVEL_COLORS[level] || chalk.white;
    lines.push(`[${shortTs}] [${colorFn(level)}] ${chalk.gray("message:")} ${msg}`);
  }
  if (logs.length > MAX_LOG_PREVIEW) {
    lines.push(chalk.dim(`  ... ${logs.length - MAX_LOG_PREVIEW} entries omitted`));
  }
  return lines.join("\n");
}

/** Step 3: Single trace query complete, output trace */
export function formatTraceChunkOutput(trace: DrillTraceGroup, index: number, total: number): string {
  const { traceId, spans, stats, logs } = trace;
  const lines: string[] = [];
  lines.push(chalk.cyan("═".repeat(70)));
  lines.push(chalk.yellow.bold(`[${index}/${total}] TraceId: ${traceId}`));
  lines.push(chalk.cyan("═".repeat(70)));

  if (stats) {
    lines.push(chalk.gray(`  Spans: ${stats.spanCount}  Duration: ${stats.totalDurationMs}ms  Errors: ${stats.errorCount}  Services: ${stats.services.join(", ")}`));
    if (stats.rootOperation) lines.push(chalk.gray(`  Root call: ${stats.rootOperation}`));
  } else {
    lines.push(chalk.gray("  (No trace data)"));
  }

  if (spans.length > 0) {
    lines.push("");
    lines.push(chalk.cyan.bold("── Call chain ──"));
    lines.push(formatTraceTreeANSI(spans));
  }

  if (logs.length > 0) {
    lines.push("");
    lines.push(chalk.cyan.bold(`── Associated logs (${logs.length}) ──`));
    for (const log of logs) {
      const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
      const level = detectLevel(log);
      const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
      const shortTs = ts.replace(/\.\d+Z$/, "Z").replace("T", " ");
      const colorFn = LEVEL_COLORS[level] || chalk.white;
      lines.push(`[${shortTs}] [${colorFn(level)}] ${chalk.gray("message:")} ${msg}`);
    }
  }

  return lines.join("\n");
}

/** Metrics query complete, output metrics */
export function formatMetricsChunkOutput(metricsText: string): string {
  const lines: string[] = [];
  lines.push(chalk.cyan("═".repeat(70)));
  lines.push(chalk.cyan("Metrics overview"));
  lines.push(chalk.cyan("═".repeat(70)));
  lines.push(metricsText);
  return lines.join("\n");
}
