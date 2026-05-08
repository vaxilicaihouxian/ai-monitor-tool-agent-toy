/**
 * alarm-analyze-event-online-agent non-interactive CLI entry
 * Usage: omc alarm-analyze-event-online-agent <eventId> [--llm-input-file <path>]
 * Phase 1: Same data collection + LLM analysis as alarm-analyze-event-online
 * Phase 2: Launch agent deep analysis + conversation based on analysis results
 */

import { readFileSync } from "node:fs";
import { loadConfig, getPluginConfig, type LogES, type MetricsPrometheusConfig } from "../config.js";
import { extractParams, type ExtractedParams } from "../llmClient.js";
import { type LogEntry, findTraceId } from "../query.js";
import { type JaegerSpan, type TraceStats } from "../traceAnalyzer.js";
import { analyzeAlarm } from "../alarmAnalyzer.js";
import type { ExportData } from "../exporter.js";
import { runAgentAnalysis } from "../agentRunner.js";
import { createPluginManager } from "../plugins/index.js";
import type { LogQueryParams, LogQueryResult } from "../datasources/log.js";
import type { TraceQueryParams, TraceQueryResult } from "../datasources/trace.js";
import type { MetricsQueryParams, MetricsQueryResult } from "../datasources/metrics.js";
import type { AlarmEventQueryParams, AlarmEventQueryResult } from "../datasources/alarm-event.js";
import { buildExtraTerms } from "../datasources/helpers.js";

/** alarm-analyze-event-online-agent non-interactive main flow */
export async function runAlarmAnalyzeEventOnlineAgentCli(
  configPath: string | undefined,
  eventId: string,
  llmInputFile?: string
): Promise<void> {
  const config = loadConfig(configPath);

  if (!config.agentModel) {
    throw new Error("agentModel not configured, please configure agentModel in ~/.omc.json or set environment variables AGENT_MODEL_*");
  }

  let initialPrompt: string;

  if (llmInputFile) {
    // Load initial prompt from file directly, skip Phase 1
    console.log(`📄 Loading initial prompt from file: ${llmInputFile}`);
    initialPrompt = readFileSync(llmInputFile, "utf-8");
  } else {
    // Execute Phase 1: Same as runAlarmAnalyzeEventOnlineCli
    const manager = await createPluginManager(config);
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
      command: `alarm-analyze-event-online-agent ${eventId}`,
      timestamp: new Date().toISOString(),
      params: { eventId, extractedInfo: paramParts.join(" | "), logQueryParams },
      results: exportResults,
    };

    console.log("⏳ Running intelligent analysis...");
    const metricsConf = getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus");
    const promConfig = metricsConf ? { clusters: metricsConf.clusters, namespace: metricsConf.namespace, rateInterval: metricsConf.rateInterval, step: metricsConf.step, timeRangeMinutes: metricsConf.timeRangeMinutes, metricTemplates: metricsConf.metricTemplates } : undefined;
    const prometheusUrl = metricsConf?.remoteReadUrl;
    const result = await analyzeAlarm(params.appname, exportData, config.analysis, (msg) => console.log(`  → ${msg}`), promConfig, prometheusUrl);

    if (result.type === "statistics") {
      console.log("\n⚠️  Analysis result is statistical summary (no LLM analysis), cannot start Agent deep analysis");
      return;
    }

    initialPrompt = `## LLM Input\n\n${result.llmInput || ""}\n\n## LLM Analysis Conclusion\n\n${result.analysisText || ""}`;
  }

  // Phase 2: Start Agent
  console.log("\n=== Phase 1 complete, starting Agent deep analysis ===\n");
  await runAgentAnalysis({ config, initialPrompt });
}
