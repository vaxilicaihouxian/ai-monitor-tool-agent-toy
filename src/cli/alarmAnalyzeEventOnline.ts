/**
 * alarm-analyze-event-online non-interactive CLI entry
 * Usage: omc alarm-analyze-event-online <eventId>
 * Online data collection + LLM analysis
 */

import { loadConfig, getPluginConfig, type LogES, type MetricsPrometheusConfig } from "../config.js";
import { extractParams, type ExtractedParams } from "../llmClient.js";
import { type LogEntry, findTraceId } from "../query.js";
import { type JaegerSpan, type TraceStats } from "../traceAnalyzer.js";
import { analyzeAlarm, type AnalysisResult } from "../alarmAnalyzer.js";
import type { ExportData } from "../exporter.js";
import { createPluginManager } from "../plugins/index.js";
import type { LogQueryParams, LogQueryResult } from "../datasources/log.js";
import type { TraceQueryParams, TraceQueryResult } from "../datasources/trace.js";
import type { MetricsQueryParams, MetricsQueryResult } from "../datasources/metrics.js";
import type { AlarmEventQueryParams, AlarmEventQueryResult } from "../datasources/alarm-event.js";
import { buildExtraTerms } from "../datasources/helpers.js";

/** Output analysis result */
function printAnalysisResult(result: AnalysisResult): void {
  if (result.type === "llm" && result.analysisText) {
    console.log(`\n=== LLM Analysis Result (analyzer: ${result.analyzerName}${result.contextName ? `, context: ${result.contextName}` : ""}) ===\n`);
    console.log(result.analysisText);
  } else if (result.statistics) {
    const stats = result.statistics;
    console.log("\n=== Statistical Summary ===");
    console.log(`Total logs: ${stats.totalLogs}`);

    const levelParts = Object.entries(stats.levelDistribution)
      .map(([level, count]) => `${level}: ${count}`);
    if (levelParts.length > 0) console.log(`  ${levelParts.join("  ")}`);

    if (stats.errorPatterns.length > 0) {
      console.log(`\nError Top ${stats.errorPatterns.length} patterns:`);
      for (let i = 0; i < stats.errorPatterns.length; i++) {
        const p = stats.errorPatterns[i];
        console.log(`  ${i + 1}. [${p.count} entries] ${p.pattern}`);
      }
    }

    if (stats.traceErrors.length > 0) {
      console.log("\nTrace anomalies:");
      for (const e of stats.traceErrors) {
        const rate = e.totalCount > 0 ? Math.round((e.errorCount / e.totalCount) * 100) : 0;
        console.log(`  - ${e.from} → ${e.to}: Error rate ${rate}%`);
      }
    }

    if (stats.slowCalls.length > 0) {
      console.log("\nLatency anomalies:");
      for (const c of stats.slowCalls) {
        console.log(`  - ${c.from} → ${c.to}: Average ${c.avgDurationMs}ms (P99: ${c.p99DurationMs}ms)`);
      }
    }
  }
}

/** alarm-analyze-event-online non-interactive main flow */
export async function runAlarmAnalyzeEventOnlineCli(configPath: string | undefined, eventId: string): Promise<void> {
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
  if (!config.analysis) {
    throw new Error("analysis not configured, please configure analysis (analyzers/models) in ~/.omc.json");
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

  if (!params.appname) {
    throw new Error("Cannot extract appname from alarm event, cannot perform intelligent analysis");
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
          return mResult.results;
        } catch {
          return null;
        }
      })()
    : Promise.resolve(null);

  const [logResult, metricsResults] = await Promise.all([logsPromise, metricsPromise]);
  const logs = logResult.entries;
  console.log(`📊 Queried ${logs.length} log entries`);

  // Step 5: Extract traceIds, query traces
  const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
  const logsByTraceId = new Map<string, LogEntry[]>();
  for (const log of logs) {
    const tid = findTraceId(log, traceIdField);
    if (!tid || tid === "undefined" || tid === "null") continue;
    if (!logsByTraceId.has(tid)) logsByTraceId.set(tid, []);
    logsByTraceId.get(tid)!.push(log);
  }

  const uniqueTraceIds = [...logsByTraceId.keys()].slice(0, 5);

  interface DrillTraceGroup { traceId: string; spans: JaegerSpan[]; stats: TraceStats | null; logs: LogEntry[] }

  const traceDs = manager.hasAvailable("trace", config);
  let traceResults: DrillTraceGroup[] = [];
  if (uniqueTraceIds.length > 0 && traceDs) {
    console.log(`⏳ Querying ${uniqueTraceIds.length} traces...`);
    traceResults = await Promise.all(
      uniqueTraceIds.map(async (tid) => {
        try {
          const r = await traceDs.query(config, { traceId: tid, includeLogs: false }) as TraceQueryResult;
          return { traceId: tid, spans: r.spans, stats: r.stats, logs: logsByTraceId.get(tid) ?? [] };
        } catch {
          return { traceId: tid, spans: [], stats: null, logs: logsByTraceId.get(tid) ?? [] };
        }
      })
    );
  }

  // Step 6: Build export data, enter analysis phase
  const exportResults: Record<string, unknown> = {
    logs,
    traces: traceResults,
    event,
    extractedParams: params,
  };
  if (metricsResults) {
    exportResults.metrics = metricsResults;
  }
  const exportData: ExportData = {
    command: `alarm-analyze-event-online ${eventId}`,
    timestamp: new Date().toISOString(),
    params: { eventId, extractedInfo: paramParts.join(" | "), logQueryParams },
    results: exportResults,
  };

  console.log("⏳ Running intelligent analysis...");
  const metricsConf = getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus");
  const promConfig = metricsConf ? { clusters: metricsConf.clusters, namespace: metricsConf.namespace, rateInterval: metricsConf.rateInterval, step: metricsConf.step, timeRangeMinutes: metricsConf.timeRangeMinutes, metricTemplates: metricsConf.metricTemplates } : undefined;
  const prometheusUrl = metricsConf?.remoteReadUrl;
  const result = await analyzeAlarm(params.appname, exportData, config.analysis, (msg) => console.log(`  → ${msg}`), promConfig, prometheusUrl);
  printAnalysisResult(result);
}
