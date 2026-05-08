/**
 * alarm-drill non-interactive CLI entry
 * Usage: omc alarm-drill <eventId>
 * Output results directly to terminal, no REPL
 */

import { loadConfig, getPluginConfig, type LogES } from "../config.js";
import { extractParams, type ExtractedParams } from "../llmClient.js";
import { type LogEntry, findField, findTraceId } from "../query.js";
import { formatTraceTree, type JaegerSpan, type TraceStats } from "../traceAnalyzer.js";
import { createPluginManager, type PluginManager } from "../plugins/index.js";
import type { LogQueryParams, LogQueryResult } from "../datasources/log.js";
import type { TraceQueryParams, TraceQueryResult } from "../datasources/trace.js";
import type { MetricsQueryParams, MetricsQueryResult } from "../datasources/metrics.js";
import type { AlarmEventQueryParams, AlarmEventQueryResult } from "../datasources/alarm-event.js";
import { buildExtraTerms } from "../datasources/helpers.js";

interface DrillTraceGroup {
  traceId: string;
  spans: JaegerSpan[];
  stats: TraceStats | null;
  logs: LogEntry[];
}

/** Format a single log entry */
function formatLog(log: LogEntry): string[] {
  const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
  const level = findField(log, "level") || findField(log, "severity") || "";
  const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
  const shortTs = ts.replace(/\.\d+Z$/, "Z").replace("T", " ");
  const levelStr = String(level).toUpperCase() || "INFO";
  const header = `[${shortTs}] [${levelStr}]`;
  const lines: string[] = [];
  lines.push(msg ? `${header} ${msg}` : header);
  lines.push(JSON.stringify(log, null, 2));
  return lines;
}

/** alarm-drill non-interactive main flow */
export async function runAlarmDrillCli(configPath: string | undefined, eventId: string): Promise<void> {
  const config = loadConfig(configPath);
  const manager = await createPluginManager(config);

  // Prerequisite checks
  const alarmDs = manager.hasAvailable("alarm-event", config);
  const logDs = manager.hasAvailable("log", config);
  if (!alarmDs || !logDs) {
    const missing = [];
    if (!alarmDs) missing.push("alarm event");
    if (!logDs) missing.push("log");
    throw new Error(`No available ${missing.join("/")} data source, please check configuration`);
  }

  if (!config.extractorModel) {
    throw new Error("extractorModel not configured, please configure extractorModel in ~/.omc.json or set environment variables EXTRACTOR_MODEL_*");
  }

  // Step 1: Query alarm event
  console.log("⏳ Querying alarm event...");
  const alarmResult = await alarmDs.query(config, { eventId }) as AlarmEventQueryResult;
  const event = alarmResult.raw;

  // Step 2: LLM extract parameters
  console.log("⏳ Extracting parameters from event...");
  const params: ExtractedParams = await extractParams(config.extractorModel, event);

  const paramParts: string[] = [];
  if (params.startTime) paramParts.push(`Start: ${new Date(params.startTime * 1000).toISOString()}`);
  if (params.endTime) paramParts.push(`End: ${new Date(params.endTime * 1000).toISOString()}`);
  if (params.appname) paramParts.push(`App: ${params.appname}`);
  if (params.podname) paramParts.push(`Pod: ${params.podname}`);
  if (params.apiPath) paramParts.push(`API: ${params.apiPath}`);
  if (params.servicer?.length) paramParts.push(`Downstream: ${params.servicer.join(",")}`);
  if (params.downstreamApi?.length) paramParts.push(`Downstream API: ${params.downstreamApi.join(",")}`);
  console.log(`📋 Extracted conditions: ${paramParts.join(" | ")}`);

  // appname is required
  if (!params.appname) {
    throw new Error("Cannot extract appname from alarm event, please specify manually. Usage: /log -a <appname>");
  }

  // Step 3: Build query conditions
  const logQueryParams: LogQueryParams = { appname: params.appname };
  if (params.startTime) logQueryParams.startTime = new Date(params.startTime * 1000).toISOString();
  logQueryParams.endTime = new Date((params.endTime || params.startTime! + 300) * 1000).toISOString();
  logQueryParams.extraTerms = buildExtraTerms({ podname: params.podname, uri: params.apiPath }, getPluginConfig<LogES>(config, "log-elasticsearch")?.fieldMapping);

  // Step 4: Query logs + metrics (concurrent)
  console.log("⏳ Querying logs...");
  const logsPromise = logDs.query(config, logQueryParams) as Promise<LogQueryResult>;

  const metricsDs = manager.hasAvailable("metrics", config);
  const metricsPromise = (metricsDs && params.startTime && params.appname)
    ? (async () => {
        try {
          console.log("⏳ Querying Prometheus metrics...");
          const metricsParams: MetricsQueryParams = {
            appname: params.appname!,
            podname: params.podname,
            apiPath: params.apiPath,
            servicer: params.servicer,
            downstreamApi: params.downstreamApi,
            startTime: params.startTime!,
            endTime: params.endTime || params.startTime! + 1800,
          };
          const mResult = await metricsDs.query(config, metricsParams) as MetricsQueryResult;
          return mResult.formatted;
        } catch {
          return null;
        }
      })()
    : Promise.resolve(null);

  const [logResult, metricsText] = await Promise.all([logsPromise, metricsPromise]);
  const logs = logResult.entries;
  console.log(`📊 Queried ${logs.length} log entries`);

  if (logs.length === 0) {
    return;
  }

  // Step 5: Extract traceIds
  const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
  const logsByTraceId = new Map<string, LogEntry[]>();
  for (const log of logs) {
    const tid = findTraceId(log, traceIdField);
    if (!tid || tid === "undefined" || tid === "null") continue;
    if (!logsByTraceId.has(tid)) logsByTraceId.set(tid, []);
    logsByTraceId.get(tid)!.push(log);
  }

  const uniqueTraceIds = [...logsByTraceId.keys()].slice(0, 5);
  console.log(`🔗 ${logsByTraceId.size} unique traceIds, taking first ${uniqueTraceIds.length}`);

  if (uniqueTraceIds.length === 0) {
    // No traceId, output logs directly
    for (const log of logs) {
      for (const line of formatLog(log)) {
        console.log(line);
      }
    }
    return;
  }

  // Step 6: Concurrent trace queries
  const traceDs = manager.hasAvailable("trace", config);
  console.log(`⏳ Querying ${uniqueTraceIds.length} traces...`);
  const traceResults = await Promise.all(
    uniqueTraceIds.map(async (tid) => {
      if (!traceDs) {
        return { traceId: tid, spans: [], stats: null, logs: logsByTraceId.get(tid) ?? [] } as DrillTraceGroup;
      }
      try {
        const r = await traceDs.query(config, { traceId: tid, includeLogs: false }) as TraceQueryResult;
        return { traceId: tid, spans: r.spans, stats: r.stats, logs: logsByTraceId.get(tid) ?? [] } as DrillTraceGroup;
      } catch {
        return { traceId: tid, spans: [], stats: null, logs: logsByTraceId.get(tid) ?? [] } as DrillTraceGroup;
      }
    })
  );

  // Step 7: Output metrics
  if (metricsText) {
    console.log(`\n${"═".repeat(70)}`);
    console.log("Metrics overview");
    console.log(`${"═".repeat(70)}`);
    console.log(metricsText);
  }

  // Step 8: Output trace results
  for (let i = 0; i < traceResults.length; i++) {
    const { traceId, spans, stats, logs: relatedLogs } = traceResults[i];

    console.log(`\n${"═".repeat(70)}`);
    console.log(`[${i + 1}/${traceResults.length}] TraceId: ${traceId}`);
    console.log(`${"═".repeat(70)}`);

    if (stats) {
      console.log(`  Spans: ${stats.spanCount}  Duration: ${stats.totalDurationMs}ms  Errors: ${stats.errorCount}  Services: ${stats.services.join(", ")}`);
      if (stats.rootOperation) console.log(`  Root call: ${stats.rootOperation}`);
    } else {
      console.log("  (No trace data)");
    }

    if (spans.length > 0) {
      console.log(`\n── Call chain ──`);
      console.log(formatTraceTree(spans));
    }

    if (relatedLogs.length > 0) {
      console.log(`── Associated logs (${relatedLogs.length} entries) ──`);
      for (const log of relatedLogs) {
        for (const line of formatLog(log)) {
          console.log(line);
        }
      }
    }
  }
}
