/**
 * Agent tool definitions
 *
 * Provides log query, trace query, and metrics query tools for pi-agent.
 * Tools capture config via closures and call existing public functions in execute.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Config, getPluginConfig, type LogES, type MetricsPrometheusConfig, type ESFieldMapping } from "./config.js";
import { findTraceId, ES_LOG_LEVELS } from "./query.js";
import { extractParams } from "./llmClient.js";
import { analyzeAlarm, filterLogEntry } from "./alarmAnalyzer.js";
import { addMemory, type MemoryConfig } from "./memory.js";
import type { PluginManager } from "./plugins/index.js";
import type { LogQueryParams, LogQueryResult } from "./datasources/log.js";
import type { TraceQueryParams, TraceQueryResult } from "./datasources/trace.js";
import type { MetricsQueryParams, MetricsQueryResult } from "./datasources/metrics.js";
import type { AlarmEventQueryParams, AlarmEventQueryResult } from "./datasources/alarm-event.js";
import { buildExtraTerms } from "./datasources/helpers.js";

// ─── Parameter Schemas ───

const QueryLogsParams = Type.Object({
  appname: Type.String({ description: "Application name (required)" }),
  search: Type.Optional(Type.String({ description: "Search keyword (matches all fields, low accuracy, not recommended for frequent use)" })),
  level: Type.Optional(Type.String({ description: "Log level: DEBUG / INFO / WARN / ERROR / FATAL" })),
  podname: Type.Optional(Type.String({ description: "Pod name, exact match on the corresponding container field" })),
  uri: Type.Optional(Type.String({ description: "API path, exact match on the corresponding URI field" })),
  startTime: Type.Optional(Type.String({ description: "Start time, ISO format" })),
  endTime: Type.Optional(Type.String({ description: "End time, ISO format" })),
  limit: Type.Optional(Type.Number({ description: "Return count limit, default 200" })),
});

const QueryTraceParams = Type.Object({
  traceId: Type.String({ description: "Trace ID" }),
});

const QueryMetricsParams = Type.Object({
  appname: Type.String({ description: "Application name (required)" }),
  podname: Type.Optional(Type.String({ description: "Pod name" })),
  startTime: Type.Optional(Type.Number({ description: "Start time, Unix timestamp (seconds)" })),
  endTime: Type.Optional(Type.Number({ description: "End time, Unix timestamp (seconds)" })),
});

type QueryLogsParamsType = Static<typeof QueryLogsParams>;
type QueryTraceParamsType = Static<typeof QueryTraceParams>;
type QueryMetricsParamsType = Static<typeof QueryMetricsParams>;

// ─── Tool implementations ───

function queryLogsTool(config: Config, manager: PluginManager): AgentTool<typeof QueryLogsParams> {
  return {
    name: "query_logs",
    label: "Query Logs",
    description: "Query application logs. Supports filtering by appname, keyword, level, and time range.",
    parameters: QueryLogsParams,
    execute: async (_toolCallId, params: QueryLogsParamsType) => {
      const logDs = manager.hasAvailable("log", config);
      if (!logDs) {
        return {
          content: [{ type: "text" as const, text: "No available log data source, please check configuration" }],
          details: { error: true },
          isError: true,
        };
      }

      // Validate level
      if (params.level && !ES_LOG_LEVELS.includes(params.level.toUpperCase() as any)) {
        return {
          content: [{ type: "text" as const, text: `Invalid log level: ${params.level}, valid values: ${ES_LOG_LEVELS.join(", ")}` }],
          details: { error: true },
          isError: true,
        };
      }

      const logParams: LogQueryParams = {
        appname: params.appname,
        search: params.search,
        level: params.level?.toUpperCase(),
        startTime: params.startTime,
        endTime: params.endTime,
        limit: params.limit || 200,
        extraTerms: buildExtraTerms({ podname: params.podname, uri: params.uri }, getPluginConfig<LogES>(config, "log-elasticsearch")?.fieldMapping),
      };

      try {
        const result = await logDs.query(config, logParams) as LogQueryResult;
        const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
        const summary = result.entries.slice(0, 10).map((log) => filterLogEntry(log, config.analysis?.fieldFilter, traceIdField));

        return {
          content: [{ type: "text" as const, text: `Found ${result.entries.length} log entries (showing first ${summary.length} summaries):\n${JSON.stringify(summary, null, 2)}` }],
          details: { total: result.entries.length, showed: summary.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Log query failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

function queryTraceTool(config: Config, manager: PluginManager): AgentTool<typeof QueryTraceParams> {
  return {
    name: "query_trace",
    label: "Query Trace",
    description: "Query trace details by traceId, including span call relationships and durations.",
    parameters: QueryTraceParams,
    execute: async (_toolCallId, params: QueryTraceParamsType) => {
      const traceDs = manager.hasAvailable("trace", config);
      if (!traceDs) {
        return {
          content: [{ type: "text" as const, text: "No available trace data source, please check configuration" }],
          details: { error: true },
          isError: true,
        };
      }

      try {
        const result = await traceDs.query(config, { traceId: params.traceId, includeLogs: false }) as TraceQueryResult;
        const { spans, stats } = result;
        if (spans.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No trace data found for traceId="${params.traceId}"` }],
            details: { found: false },
          };
        }

        const spanSummary = spans.map((s) => ({
          operationName: s.operationName,
          serviceName: s.serviceName,
          durationMs: s.durationMs ?? s.duration,
          hasError: s.hasError,
        }));

        const statsText = stats
          ? `Services: ${stats.services.join(", ")} | Spans: ${stats.spanCount} | Total duration: ${stats.totalDurationMs}ms | Errors: ${stats.errorCount}`
          : "";

        return {
          content: [{
            type: "text" as const,
            text: `Trace ${params.traceId}:\n${statsText}\n\nSpan list:\n${JSON.stringify(spanSummary, null, 2)}`,
          }],
          details: { traceId: params.traceId, spanCount: spans.length, stats },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Trace query failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

function queryMetricsTool(config: Config, manager: PluginManager): AgentTool<typeof QueryMetricsParams> {
  return {
    name: "query_metrics",
    label: "Query Prometheus Metrics",
    description: "Query Prometheus monitoring metrics for an application, including CPU, memory, QPS, latency, etc.",
    parameters: QueryMetricsParams,
    execute: async (_toolCallId, params: QueryMetricsParamsType) => {
      const metricsDs = manager.hasAvailable("metrics", config);
      if (!metricsDs) {
        return {
          content: [{ type: "text" as const, text: "No available metrics data source, please check configuration" }],
          details: { error: true },
          isError: true,
        };
      }

      try {
        const now = Math.floor(Date.now() / 1000);
        const metricsParams: MetricsQueryParams = {
          appname: params.appname,
          podname: params.podname,
          startTime: params.startTime || now - 1800,
          endTime: params.endTime || now,
        };

        const mResult = await metricsDs.query(config, metricsParams) as MetricsQueryResult;

        return {
          content: [{ type: "text" as const, text: `Metrics query results (${mResult.results.length} items):\n${mResult.formatted}` }],
          details: { resultCount: mResult.results.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Metrics query failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

/** Create specialized Agent tool list (3 tools, existing logic) */
export function createAgentTools(config: Config, manager: PluginManager): AgentTool[] {
  return [
    queryLogsTool(config, manager),
    queryTraceTool(config, manager),
    queryMetricsTool(config, manager),
  ];
}

/** Create default Agent tool list (6~7 tools, adds memory_save when memory is enabled) */
export function createDefaultAgentTools(config: Config, manager: PluginManager): AgentTool[] {
  const tools: AgentTool[] = [
    queryLogsTool(config, manager),
    queryTraceTool(config, manager),
    queryMetricsTool(config, manager),
    queryAlarmEventTool(config, manager),
    alarmDrillTool(config, manager),
    alarmAnalyzeTool(config, manager),
  ];

  if (config.memory?.enabled) {
    tools.push(memorySaveTool(config));
  }

  return tools;
}

// ─── Additional tool parameter schemas ───

const QueryAlarmEventParams = Type.Object({
  eventId: Type.String({ description: "Alarm event ID" }),
});

const AlarmDrillParams = Type.Object({
  eventId: Type.String({ description: "Alarm event ID" }),
});

const AlarmAnalyzeParams = Type.Object({
  eventId: Type.String({ description: "Alarm event ID" }),
});

type QueryAlarmEventParamsType = Static<typeof QueryAlarmEventParams>;
type AlarmDrillParamsType = Static<typeof AlarmDrillParams>;
type AlarmAnalyzeParamsType = Static<typeof AlarmAnalyzeParams>;

// ─── Additional tool implementations ───

function queryAlarmEventTool(config: Config, manager: PluginManager): AgentTool<typeof QueryAlarmEventParams> {
  return {
    name: "query_alarm_event",
    label: "Query Alarm Event",
    description: "Query alarm event details. Requires eventId. Returns key information about the alarm event (application name, time range, alarm content, Pod, etc.).",
    parameters: QueryAlarmEventParams,
    execute: async (_toolCallId, params: QueryAlarmEventParamsType) => {
      const alarmDs = manager.hasAvailable("alarm-event", config);
      if (!alarmDs) {
        return {
          content: [{ type: "text" as const, text: "No available alarm event data source, please check configuration" }],
          details: { error: true },
          isError: true,
        };
      }

      try {
        const result = await alarmDs.query(config, { eventId: params.eventId }) as AlarmEventQueryResult;
        return {
          content: [{ type: "text" as const, text: `Alarm event summary:\n${JSON.stringify(result.summary, null, 2)}` }],
          details: { eventId: params.eventId },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Alarm event query failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

function alarmDrillTool(config: Config, manager: PluginManager): AgentTool<typeof AlarmDrillParams> {
  return {
    name: "alarm_drill",
    label: "Alarm Drill-down",
    description: "Alarm event drill-down. Requires eventId. Automatically: query event details -> LLM extract parameters (appname/time range/Pod/API path) -> query related logs -> extract traceIds from logs -> query related traces. Suitable for quickly understanding the full picture of an alarm event.",
    parameters: AlarmDrillParams,
    execute: async (_toolCallId, params: AlarmDrillParamsType) => {
      const alarmDs = manager.hasAvailable("alarm-event", config);
      const logDs = manager.hasAvailable("log", config);
      if (!alarmDs || !logDs) {
        const missing = [];
        if (!alarmDs) missing.push("alarm event");
        if (!logDs) missing.push("log");
        return {
          content: [{ type: "text" as const, text: `No available ${missing.join("/")} data source, please check configuration` }],
          details: { error: true },
          isError: true,
        };
      }

      if (!config.extractorModel) {
        return {
          content: [{ type: "text" as const, text: "extractorModel not configured, cannot execute alarm drill-down" }],
          details: { error: true },
          isError: true,
        };
      }

      try {
        // Step 1: Query event
        const alarmResult = await alarmDs.query(config, { eventId: params.eventId }) as AlarmEventQueryResult;
        const event = alarmResult.raw;

        // Step 2: LLM extract parameters
        const extracted = await extractParams(config.extractorModel, event);
        if (!extracted.appname) {
          return {
            content: [{ type: "text" as const, text: `Cannot extract appname from alarm event ${params.eventId}, drill-down aborted` }],
            details: { error: true },
            isError: true,
          };
        }

        const parts: string[] = [`App: ${extracted.appname}`];
        if (extracted.startTime) parts.push(`Start: ${new Date(extracted.startTime * 1000).toISOString()}`);
        if (extracted.endTime) parts.push(`End: ${new Date(extracted.endTime * 1000).toISOString()}`);
        if (extracted.podname) parts.push(`Pod: ${extracted.podname}`);
        if (extracted.apiPath) parts.push(`API: ${extracted.apiPath}`);
        const extractedInfo = parts.join(" | ");

        // Step 3: Query logs
        const logParams: LogQueryParams = { appname: extracted.appname, limit: 200 };
        if (extracted.startTime) logParams.startTime = new Date(extracted.startTime * 1000).toISOString();
        logParams.endTime = new Date((extracted.endTime || extracted.startTime! + 300) * 1000).toISOString();
        logParams.extraTerms = buildExtraTerms({ podname: extracted.podname, uri: extracted.apiPath }, getPluginConfig<LogES>(config, "log-elasticsearch")?.fieldMapping);
        const logResult = await logDs.query(config, logParams) as LogQueryResult;
        const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
        const logSummary = logResult.entries.slice(0, 10).map((log) => filterLogEntry(log, config.analysis?.fieldFilter, traceIdField));

        // Step 4: Extract traceIds, query traces
        const traceIdSet = new Set<string>();
        for (const log of logResult.entries) {
          const tid = findTraceId(log, traceIdField);
          if (tid && tid !== "undefined" && tid !== "null") traceIdSet.add(tid);
        }
        const uniqueTraceIds = [...traceIdSet].slice(0, 5);

        const traceDs = manager.hasAvailable("trace", config);
        const traceSummaries: string[] = [];
        for (const tid of uniqueTraceIds) {
          try {
            const r = await traceDs!.query(config, { traceId: tid, includeLogs: false }) as TraceQueryResult;
            const statsText = r.stats
              ? `Services: ${r.stats.services.join(", ")} | Spans: ${r.stats.spanCount} | Total duration: ${r.stats.totalDurationMs}ms | Errors: ${r.stats.errorCount}`
              : "No statistics available";
            const spanList = r.spans.map((s) => `${s.operationName} (${s.serviceName}, ${s.durationMs ?? s.duration}ms${s.hasError ? " ❌" : ""})`).join("\n  ");
            traceSummaries.push(`Trace ${tid}:\n  ${statsText}\n  Span list:\n  ${spanList}`);
          } catch {
            traceSummaries.push(`Trace ${tid}: query failed`);
          }
        }

        const result = [
          `Alarm drill-down: ${params.eventId}`,
          `Extracted conditions: ${extractedInfo}`,
          `Found ${logResult.entries.length} log entries (showing first ${logSummary.length} summaries):`,
          JSON.stringify(logSummary, null, 2),
          ...(traceSummaries.length > 0 ? [`\nRelated traces (${traceSummaries.length}):`, ...traceSummaries] : []),
        ].join("\n\n");

        return {
          content: [{ type: "text" as const, text: result }],
          details: { eventId: params.eventId, logCount: logResult.entries.length, traceCount: uniqueTraceIds.length },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Alarm drill-down failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

function alarmAnalyzeTool(config: Config, manager: PluginManager): AgentTool<typeof AlarmAnalyzeParams> {
  return {
    name: "alarm_analyze",
    label: "Alarm Analysis",
    description: "Intelligent alarm analysis. Requires eventId. Automatically: online data collection (logs+traces+metrics) -> incremental summarization -> LLM deep analysis. Suitable for scenarios requiring a complete analysis report.",
    parameters: AlarmAnalyzeParams,
    execute: async (_toolCallId, params: AlarmAnalyzeParamsType) => {
      const alarmDs = manager.hasAvailable("alarm-event", config);
      const logDs = manager.hasAvailable("log", config);
      if (!alarmDs || !logDs) {
        const missing = [];
        if (!alarmDs) missing.push("alarm event");
        if (!logDs) missing.push("log");
        return {
          content: [{ type: "text" as const, text: `No available ${missing.join("/")} data source, please check configuration` }],
          details: { error: true },
          isError: true,
        };
      }

      if (!config.extractorModel || !config.analysis) {
        return {
          content: [{ type: "text" as const, text: "extractorModel or analysis not configured, cannot execute intelligent analysis" }],
          details: { error: true },
          isError: true,
        };
      }

      try {
        // Step 1: Query event
        const alarmResult = await alarmDs.query(config, { eventId: params.eventId }) as AlarmEventQueryResult;
        const event = alarmResult.raw;

        // Step 2: LLM extract parameters
        const extracted = await extractParams(config.extractorModel, event);
        if (!extracted.appname) {
          return {
            content: [{ type: "text" as const, text: `Cannot extract appname from alarm event ${params.eventId}, analysis aborted` }],
            details: { error: true },
            isError: true,
          };
        }

        // Step 3: Query logs
        const logParams: LogQueryParams = { appname: extracted.appname, limit: 200 };
        if (extracted.startTime) logParams.startTime = new Date(extracted.startTime * 1000).toISOString();
        logParams.endTime = new Date((extracted.endTime || extracted.startTime! + 300) * 1000).toISOString();
        logParams.extraTerms = buildExtraTerms({ podname: extracted.podname, uri: extracted.apiPath }, getPluginConfig<LogES>(config, "log-elasticsearch")?.fieldMapping);
        const logResult = await logDs.query(config, logParams) as LogQueryResult;

        // Step 4: Extract traceIds, query traces
        const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
        const logsByTraceId = new Map<string, unknown[]>();
        for (const log of logResult.entries) {
          const tid = findTraceId(log, traceIdField);
          if (!tid || tid === "undefined" || tid === "null") continue;
          if (!logsByTraceId.has(tid)) logsByTraceId.set(tid, []);
          logsByTraceId.get(tid)!.push(log);
        }
        const uniqueTraceIds = [...logsByTraceId.keys()].slice(0, 5);

        const traceDs = manager.hasAvailable("trace", config);
        const traceResults: Record<string, unknown>[] = [];
        if (uniqueTraceIds.length > 0 && traceDs) {
          for (const tid of uniqueTraceIds) {
            try {
              const r = await traceDs.query(config, { traceId: tid, includeLogs: false }) as TraceQueryResult;
              traceResults.push({ traceId: tid, spans: r.spans, stats: r.stats, logs: logsByTraceId.get(tid) ?? [] });
            } catch {
              traceResults.push({ traceId: tid, spans: [], stats: null, logs: logsByTraceId.get(tid) ?? [] });
            }
          }
        }

        // Step 5: Build exportData, call analyzeAlarm
        const exportResults: Record<string, unknown> = {
          logs: logResult.entries,
          traces: traceResults,
          event,
          extractedParams: extracted,
        };

        // Query metrics
        const metricsDs = manager.hasAvailable("metrics", config);
        if (metricsDs && extracted.startTime && extracted.appname) {
          try {
            const metricsParams: MetricsQueryParams = {
              appname: extracted.appname,
              podname: extracted.podname,
              apiPath: extracted.apiPath,
              servicer: extracted.servicer,
              downstreamApi: extracted.downstreamApi,
              startTime: extracted.startTime,
              endTime: extracted.endTime || extracted.startTime + 1800,
            };
            const metricsResult = await metricsDs.query(config, metricsParams) as MetricsQueryResult;
            exportResults.metrics = metricsResult.results;
          } catch {
            // Metrics query failure does not interrupt
          }
        }

        const exportData = {
          command: `alarm-analyze ${params.eventId}`,
          timestamp: new Date().toISOString(),
          params: { eventId: params.eventId },
          results: exportResults,
        };

        // Step 6: Execute analysis
        const metricsConf = getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus");
        const result = await analyzeAlarm(
          extracted.appname,
          exportData,
          config.analysis,
          undefined,
          metricsConf ? { clusters: metricsConf.clusters, namespace: metricsConf.namespace, rateInterval: metricsConf.rateInterval, step: metricsConf.step, timeRangeMinutes: metricsConf.timeRangeMinutes, metricTemplates: metricsConf.metricTemplates } : undefined,
          metricsConf?.remoteReadUrl,
        );

        if (result.type === "llm" && result.analysisText) {
          return {
            content: [{ type: "text" as const, text: `Analysis result (analyzer: ${result.analyzerName}${result.contextName ? `, context: ${result.contextName}` : ""}):\n\n${result.analysisText}` }],
            details: { eventId: params.eventId, type: result.type, analyzerName: result.analyzerName },
          };
        }

        // Fallback to statistical summary
        const stats = result.statistics;
        if (stats) {
          const statText = [
            `Statistical summary (total logs: ${stats.totalLogs})`,
            Object.entries(stats.levelDistribution).map(([l, c]) => `${l}: ${c}`).join("  "),
            ...(stats.errorPatterns.length > 0 ? [`Error Top ${stats.errorPatterns.length}:`, ...stats.errorPatterns.map((p, i) => `  ${i + 1}. [${p.count} entries] ${p.pattern}`)] : []),
            ...(stats.traceErrors.length > 0 ? ["Trace errors:", ...stats.traceErrors.map((e) => `  - ${e.from} → ${e.to}: error rate ${e.totalCount > 0 ? Math.round((e.errorCount / e.totalCount) * 100) : 0}%`)] : []),
            ...(stats.slowCalls.length > 0 ? ["Slow calls:", ...stats.slowCalls.map((c) => `  - ${c.from} → ${c.to}: avg ${c.avgDurationMs}ms`)] : []),
          ].join("\n");
          return {
            content: [{ type: "text" as const, text: statText }],
            details: { eventId: params.eventId, type: "statistics" },
          };
        }

        return {
          content: [{ type: "text" as const, text: "Analysis produced no valid results" }],
          details: { eventId: params.eventId },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Intelligent analysis failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}

// ─── Memory tool parameter schemas ───

const MemorySaveParams = Type.Object({
  type: Type.Union([Type.Literal("preference"), Type.Literal("alarm_case")], { description: "Memory type: preference (user preferences/troubleshooting habits) or alarm_case (alarm incident case)" }),
  title: Type.String({ description: "Memory title, a brief one-line summary" }),
  content: Type.String({ description: "Detailed memory content" }),
  tags: Type.Optional(Type.String({ description: "Tags, comma-separated, e.g. 'OOM,memory leak'" })),
  appname: Type.Optional(Type.String({ description: "Associated application name (applicable for alarm_case)" })),
});

type MemorySaveParamsType = Static<typeof MemorySaveParams>;

// ─── Memory tool implementation ───

function memorySaveTool(config: Config): AgentTool<typeof MemorySaveParams> {
  return {
    name: "memory_save",
    label: "Save Memory",
    description: "Save a long-term memory entry. Can record user preferences, troubleshooting habits, or alarm incident cases and their results. Memories are persisted and available for reference in future sessions.",
    parameters: MemorySaveParams,
    execute: async (_toolCallId, params: MemorySaveParamsType) => {
      const memoryConfig = config.memory;
      if (!memoryConfig?.enabled) {
        return {
          content: [{ type: "text" as const, text: "Memory feature is not enabled" }],
          details: { error: true },
          isError: true,
        };
      }

      try {
        const tags = params.tags ? params.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
        const result = addMemory({
          type: params.type,
          timestamp: new Date().toISOString(),
          title: params.title,
          content: params.content,
          tags,
          appname: params.type === "alarm_case" ? params.appname : undefined,
        }, memoryConfig);

        return {
          content: [{ type: "text" as const, text: result }],
          details: { type: params.type, title: params.title },
        };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: `Failed to save memory: ${err instanceof Error ? err.message : String(err)}` }],
          details: { error: true },
          isError: true,
        };
      }
    },
  };
}
