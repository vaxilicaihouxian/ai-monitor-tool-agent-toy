/**
 * Shell - REPL interactive shell component (core UI component)
 *
 * Manages the entire REPL lifecycle: command input, command dispatch, loading states, Agent dialog loop.
 * Responsibilities:
 * - Receive and parse user commands, route to corresponding query/analysis processing flow
 * - Manage Static output area, push command results to terminal scrollback
 * - Manage lifecycle of dedicated Agent (deep analysis) and default Agent (natural language assistant)
 * - Maintain loading/idle/Agent dialog UI mode switching
 * - Maintain export data cache (lastExportRef)
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Box, Text, useApp, useInput, Static } from "ink";
import { loadConfig, type Config, getPluginConfig, type LogES, type MetricsPrometheusConfig } from "../config.js";
import type { PrometheusConfig } from "../promClient.js";
import { type LogEntry, findTraceId } from "../query.js";
import { extractParams, type ExtractedParams } from "../llmClient.js";
import { analyzeAlarm, extractAppnameFromData, type AnalysisResult } from "../alarmAnalyzer.js";
import { Agent } from "@mariozechner/pi-agent-core";
import { streamSimple, registerBuiltInApiProviders } from "@mariozechner/pi-ai";
import { createAgentTools, createDefaultAgentTools } from "../agentTools.js";
import { loadPromptFile } from "../promptLoader.js";
import { promQueryRange, parseRelativeTime } from "../promClient.js";
import { debug, warn } from "../utils/logger.js";
import {
  parseSpans,
  getTraceStats,
  type JaegerSpan,
  type TraceStats,
  type ViewType,
} from "../traceAnalyzer.js";
import { parseCommand, initialToCommandString, HELP_TEXT, type InitialCommand } from "../commands.js";
import { exportToFile, type ExportData } from "../exporter.js";
import { CommandInput } from "../components/CommandInput.js";
import { Spinner } from "../components/Spinner.js";
import { StepsProgress } from "../components/StepsProgress.js";
import { type DrillTraceGroup } from "../types.js";
import {
  formatLogsOutput,
  formatTraceOutput,
  formatAlarmDrillOutput,
  formatAlarmAnalyzeOutput,
  formatMetricsOutput,
  formatAlertOutput,
  formatHelpOutput,
  formatExtractedParamsOutput,
  formatLogsChunkOutput,
  formatTraceChunkOutput,
  formatMetricsChunkOutput,
} from "../utils/formatters.js";
import { readFileSync } from "node:fs";
import { syncCreatePluginManager, createPluginManager, type PluginManager } from "../plugins/index.js";
import { isCommandAvailable, getCommandDegradations, resolveCommandAvailabilities } from "../commands-capability.js";
import type { LogQueryParams, LogQueryResult } from "../datasources/log.js";
import type { TraceQueryParams, TraceQueryResult } from "../datasources/trace.js";
import type { MetricsQueryParams, MetricsQueryResult } from "../datasources/metrics.js";
import type { AlarmEventQueryParams, AlarmEventQueryResult } from "../datasources/alarm-event.js";
import { buildExtraTerms } from "../datasources/helpers.js";

const ALERT_ENABLED = !!process.env.OMC_DEBUG;

// Register built-in API providers
registerBuiltInApiProviders();

/** Shell run mode: idle or loading */
type Mode = "idle" | "loading";

/** Shell properties */
interface ShellProps {
  /** Optional config file path */
  configPath?: string;
  /** Optional initial command (auto-executed on startup) */
  initial?: InitialCommand;
}

/** Group logs by traceId */
function groupLogsByTraceId(logs: LogEntry[], traceIdField: string): Map<string, LogEntry[]> {
  const map = new Map<string, LogEntry[]>();
  for (const log of logs) {
    const tid = findTraceId(log, traceIdField);
    if (!tid || tid === "undefined" || tid === "null") continue;
    if (!map.has(tid)) map.set(tid, []);
    map.get(tid)!.push(log);
  }
  return map;
}

/** Extract promConfig and remoteReadUrl from metrics-prometheus config */
function splitMetricsConfig(conf: MetricsPrometheusConfig | undefined): { promConfig: PrometheusConfig | undefined; prometheusUrl: string | undefined } {
  if (!conf) return { promConfig: undefined, prometheusUrl: undefined };
  const { remoteReadUrl, ...rest } = conf;
  const promConfig: PrometheusConfig = {
    clusters: rest.clusters,
    namespace: rest.namespace,
    rateInterval: rest.rateInterval,
    step: rest.step,
    timeRangeMinutes: rest.timeRangeMinutes,
    metricTemplates: rest.metricTemplates,
  };
  return { promConfig, prometheusUrl: remoteReadUrl };
}

/** Shell main component: REPL interactive loop + state management + Agent integration */
export default function Shell({ configPath, initial }: ShellProps) {
  const { exit } = useApp();
  const [mode, setMode] = useState<Mode>(initial ? "loading" : "idle");
  const [loading, setLoading] = useState(!!initial);
  const [loadingStage, setLoadingStage] = useState<string>("");
  const [loadingSteps, setLoadingSteps] = useState<string[]>([]);
  const [loadingStepIndex, setLoadingStepIndex] = useState(0);
  const [loadingSubStep, setLoadingSubStep] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Static output (command results enter scrollback)
  const [staticItems, setStaticItems] = useState<{ id: number; text: string }[]>([]);
  const staticIdRef = useRef(0);

  // Agent state
  const [agentStreaming, setAgentStreaming] = useState(false);
  const [agentActive, setAgentActive] = useState(false);
  const agentRef = useRef<Agent | null>(null);

  // Default Agent state
  const defaultAgentRef = useRef<Agent | null>(null);
  const [defaultAgentStreaming, setDefaultAgentStreaming] = useState(false);
  const [defaultAgentEnabled, setDefaultAgentEnabled] = useState(false);

  const configRef = useRef<Config>(loadConfig(configPath));
  const managerRef = useRef<PluginManager>(syncCreatePluginManager(configRef.current));
  const initialExecuted = useRef(false);
  const lastExportRef = useRef<ExportData | null>(null);

  // Asynchronously load dynamic plugins (if configured), replacing the synchronously created manager
  // After loading, initialize default Agent to ensure Agent tools can see dynamic plugin data sources
  useEffect(() => {
    const loadAndInit = async () => {
      if (configRef.current.plugins && configRef.current.plugins.length > 0) {
        const manager = await createPluginManager(configRef.current);
        managerRef.current = manager;
      }
      // Initialize default Agent after dynamic plugins finish loading
      if (!defaultAgentRef.current) {
        initDefaultAgent();
      }
    };
    loadAndInit();
  }, []);

  /** Output content to terminal static area (enters scrollback, native terminal scroll can review) */
  const pushStatic = useCallback((text: string) => {
    const id = ++staticIdRef.current;
    setStaticItems((prev) => [...prev, { id, text }]);
  }, []);

  const handleBack = useCallback(() => {
    if (agentRef.current) {
      try {
        agentRef.current.abort();
      } catch {
        // abort may throw (agent already ended, etc.), ignore
      }
      agentRef.current = null;
    }
    setAgentActive(false);
    setMode("idle");
    setMessage(null);
    setAgentStreaming(false);
  }, []);

  // Agent input handling
  const handleAgentInput = useCallback((input: string) => {
    if (!agentRef.current) return;
    pushStatic(`\n> ${input}`);
    setAgentStreaming(true);
    agentRef.current.prompt(input);
  }, [pushStatic]);

  /** Start Agent Phase 2 from existing AnalysisResult */
  const startAgent = useCallback((llmInput: string, analysisText: string) => {
    const config = configRef.current;
    const agentModel = config.agentModel!;
    const model = {
      id: agentModel.model, name: agentModel.model,
      api: (agentModel.api ?? "openai-completions") as "openai-completions",
      provider: "omc-agent", baseUrl: agentModel.baseUrl,
      reasoning: agentModel.reasoning ?? false, input: agentModel.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: agentModel.contextWindow ?? 128000, maxTokens: agentModel.maxTokens ?? 4096,
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
    const systemPrompt = loadPromptFile("agent-sre-deep");
    const tools = createAgentTools(config, managerRef.current);
    let toolCallCount = 0;

    const agent = new Agent({
      initialState: { systemPrompt, model, thinkingLevel: "off", tools, messages: [] },
      streamFn: streamSimple as any,
      toolExecution: "parallel",
      getApiKey: () => agentModel.token,
      beforeToolCall: async () => {
        toolCallCount++;
        if (toolCallCount > 10) return { block: true, reason: "Maximum tool calls reached for this round (10), please summarize analysis based on existing information" };
        return undefined;
      },
    });

    agent.subscribe((event: any) => {
      if (event.type === "turn_start") {
        toolCallCount = 0;
        setAgentStreaming(true);
      }
      if (event.type === "message_end") {
        const msg = event.message;
        if (msg.role === "assistant" && msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              pushStatic(block.text);
            }
          }
        }
      }
      if (event.type === "tool_execution_start") {
        pushStatic(`🔧 Calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end") {
        if (event.isError) {
          pushStatic("  ❌ Failed");
        } else {
          const result = event.result;
          if (result?.content) {
            for (const c of result.content) {
              if (c.type === "text" && c.text) {
                const preview = c.text.length > 200 ? c.text.slice(0, 200) + "..." : c.text;
                pushStatic(`  📋 ${preview}`);
              }
            }
          }
        }
      }
      if (event.type === "turn_end") {
        setAgentStreaming(false);
      }
      if (event.type === "agent_end") {
        setAgentStreaming(false);
        // Do not clear agentRef; dedicated Agent session persists until user actively exits
      }
    });

    agentRef.current = agent;
    setAgentActive(true);
    setDefaultAgentStreaming(false);
    pushStatic("🤖 Agent starting deep analysis...");
    setAgentStreaming(true);
    setMode("idle");
    setLoading(false);

    const initialPrompt = analysisText
      ? `## LLM Input\n\n${llmInput}\n\n## LLM Analysis Conclusion\n\n${analysisText}`
      : llmInput;
    agent.prompt(initialPrompt);
  }, [pushStatic]);

  /** Initialize default Agent (called once on REPL startup) */
  const initDefaultAgent = useCallback(async () => {
    const config = configRef.current;
    const daConfig = config.defaultAgent;
    if (!daConfig || !daConfig.enabled) return;

    const model = {
      id: daConfig.model, name: daConfig.model,
      api: (daConfig.api ?? "openai-completions") as "openai-completions",
      provider: "omc-default-agent", baseUrl: daConfig.baseUrl,
      reasoning: daConfig.reasoning ?? false, input: daConfig.input ?? ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: daConfig.contextWindow ?? 128000, maxTokens: daConfig.maxTokens ?? 4096,
      compat: { supportsStore: false, supportsDeveloperRole: false, supportsReasoningEffort: false },
    };
    let systemPrompt = loadPromptFile("default-agent");

    // Inject memory into system prompt
    if (config.memory?.enabled) {
      try {
        const { loadMemoryForPrompt } = await import("../memory.js");
        const memoryContent = loadMemoryForPrompt(config.memory);
        if (memoryContent) {
          systemPrompt += "\n\n" + memoryContent;
        }
      } catch {
        // Memory loading failure does not affect Agent creation
      }
    }

    const tools = createDefaultAgentTools(config, managerRef.current);
    const maxToolCalls = daConfig.maxToolCalls ?? 10;
    let toolCallCount = 0;

    const agent = new Agent({
      initialState: { systemPrompt, model, thinkingLevel: "off", tools, messages: [] },
      streamFn: streamSimple as any,
      toolExecution: "parallel",
      getApiKey: () => daConfig.token,
      onPayload: (payload: any) => {
        const msgs = payload?.messages;
        if (msgs) {
          debug(`[default-agent] → LLM request: ${msgs.length} messages`);
          for (const m of msgs) {
            const role = m.role || "?";
            const content = m.content;
            if (Array.isArray(content)) {
              debug(`[${role}] ${content.map((c: any) => c.type === "text" ? c.text : c.type).join(" | ")}`);
            } else {
              debug(`[${role}] ${content}`);
            }
          }
        }
      },
      onResponse: (response: any) => {
        debug(`[default-agent] ← LLM response: status=${response.status}`);
      },
      beforeToolCall: async () => {
        toolCallCount++;
        if (toolCallCount > maxToolCalls) return { block: true, reason: `Maximum tool calls reached for this round (${maxToolCalls}), please summarize analysis based on existing information` };
        return undefined;
      },
    });

    agent.subscribe((event: any) => {
      if (event.type === "turn_start") {
        toolCallCount = 0;
        // Do not update default Agent state when dedicated Agent is active
        if (!agentRef.current) {
          setDefaultAgentStreaming(true);
        }
      }
      if (event.type === "message_end") {
        const msg = event.message;
        if (msg.role === "assistant" && msg.content) {
          for (const block of msg.content) {
            if (block.type === "text" && block.text) {
              pushStatic(block.text);
            }
          }
        }
      }
      if (event.type === "tool_execution_start") {
        pushStatic(`🔧 Calling tool: ${event.toolName}`);
      }
      if (event.type === "tool_execution_end") {
        if (event.isError) {
          pushStatic("  ❌ Failed");
        } else {
          const result = event.result;
          if (result?.content) {
            for (const c of result.content) {
              if (c.type === "text" && c.text) {
                const preview = c.text.length > 200 ? c.text.slice(0, 200) + "..." : c.text;
                pushStatic(`  📋 ${preview}`);
              }
            }
          }
        }
      }
      if (event.type === "turn_end" || event.type === "agent_end") {
        if (!agentRef.current) {
          setDefaultAgentStreaming(false);
        }
      }
    });

    defaultAgentRef.current = agent;
    setDefaultAgentEnabled(true);
  }, [pushStatic]);

  const executeCommand = useCallback(async (cmdStr: string) => {
    const parsed = parseCommand(cmdStr);
    if (!parsed) {
      // If default Agent is enabled, pass unknown commands to default Agent
      if (defaultAgentRef.current) {
        pushStatic(`\n> ${cmdStr}`);
        setDefaultAgentStreaming(true);
        defaultAgentRef.current.prompt(cmdStr);
      } else {
        setMessage("Unknown command, type /help for help");
      }
      return;
    }

    if (parsed.command === "quit") {
      exit();
      return;
    }

    if (parsed.command === "help") {
      pushStatic(formatHelpOutput());
      return;
    }

    if (parsed.command === "export") {
      if (!lastExportRef.current) {
        setMessage("No data to export, please run a query command first");
        return;
      }

      try {
        const filePath = exportToFile(parsed.exportDir, lastExportRef.current);
        pushStatic(`Exported to: ${filePath}`);
      } catch (err) {
        setError(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    if (parsed.command === "memory") {
      const config = configRef.current;
      if (!config.memory?.enabled) {
        setMessage("Memory feature not enabled, please set memory.enabled = true in config");
        return;
      }

      try {
        const { executeMemoryCommand } = await import("../memory.js");
        const result = executeMemoryCommand({
          subcommand: parsed.memorySubcommand ?? "show",
          type: parsed.memoryType,
          title: parsed.memoryTitle,
          content: parsed.memoryContent,
          tags: parsed.memoryTags,
          appname: parsed.memoryAppname,
          backupSuffix: parsed.memoryBackupSuffix,
        }, config.memory);
        pushStatic(result);
      } catch (err) {
        setError(`Memory operation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return;
    }

    const config = configRef.current;
    setMode("loading");
    setLoading(true);
    setLoadingStage("Querying...");
    setLoadingSteps([]);
    setLoadingStepIndex(0);
    setLoadingSubStep(undefined);
    setError(null);
    setMessage(null);

    try {
      if (parsed.command === "trace") {
        if (!parsed.traceId) {
          setError("Missing traceId, usage: /trace <traceId>");
          setMode("idle");
          setLoading(false);
          return;
        }

        const manager = managerRef.current;
        const traceDs = manager.hasAvailable("trace", config);
        if (!traceDs) {
          setError("No available trace data source, please check configuration");
          setMode("idle");
          setLoading(false);
          return;
        }

        const traceParams: TraceQueryParams = {
          traceId: parsed.traceId,
          includeLogs: true,
          logLimit: parsed.logOptions.limit,
        };

        const degradations = getCommandDegradations(manager, config, "/trace");
        const logDesc = degradations.length > 0 ? "No associated logs" : "With associated logs";
        const queryInfo = `TraceID: ${parsed.traceId} | ${logDesc}`;
        setLoadingStage("Querying traces...");

        const result = await traceDs.query(config, traceParams) as TraceQueryResult;
        const viewType = parsed.viewType || "tree";

        const output = formatTraceOutput(result.spans, result.stats, result.logs, viewType, queryInfo, result.logSource);
        pushStatic(output);

        lastExportRef.current = {
          command: cmdStr,
          timestamp: new Date().toISOString(),
          params: { command: cmdStr, traceId: parsed.traceId, viewType },
          results: { queryInfo, spans: result.spans, stats: result.stats, logs: result.logs, logSource: result.logSource },
        };
        setMode("idle");

      } else if (ALERT_ENABLED && parsed.command === "alert") {
        if (!parsed.eventId) {
          setError("Missing eventId, usage: /alert <eventId>");
          setMode("idle");
          setLoading(false);
          return;
        }

        const manager = managerRef.current;
        const alarmDs = manager.hasAvailable("alarm-event", config);
        if (!alarmDs) {
          setError("No available alarm event data source, please check configuration");
          setMode("idle");
          setLoading(false);
          return;
        }

        setLoadingStage("Querying alarm event...");
        const alarmResult = await alarmDs.query(config, { eventId: parsed.eventId }) as AlarmEventQueryResult;
        const queryInfo = `Alert: ${parsed.eventId}`;

        pushStatic(formatAlertOutput(alarmResult.raw, parsed.eventId, queryInfo));

        lastExportRef.current = {
          command: cmdStr,
          timestamp: new Date().toISOString(),
          params: { command: cmdStr, eventId: parsed.eventId },
          results: { queryInfo, event: alarmResult.raw },
        };
        setMode("idle");

      } else if (parsed.command === "alarm-drill") {
        if (!parsed.eventId) {
          setError("Missing eventId, usage: /alarm-drill <eventId>");
          setMode("idle");
          setLoading(false);
          return;
        }

        const manager = managerRef.current;
        const alarmDs = manager.hasAvailable("alarm-event", config);
        const logDs = manager.hasAvailable("log", config);
        if (!alarmDs || !logDs) {
          const missing = [];
          if (!alarmDs) missing.push("alarm event");
          if (!logDs) missing.push("log");
          setError(`No available ${missing.join("/")} data source, please check configuration`);
          setMode("idle");
          setLoading(false);
          return;
        }

        if (!config.extractorModel) {
          setError("extractorModel not configured");
          setMode("idle");
          setLoading(false);
          return;
        }

        const drillSteps = ["Query alarm event", "Extract parameters from event", "Query logs+traces+metrics"];
        setLoadingSteps(drillSteps);

        setLoadingStepIndex(0);
        const alarmResult = await alarmDs.query(config, { eventId: parsed.eventId }) as AlarmEventQueryResult;
        const event = alarmResult.raw;

        setLoadingStepIndex(1);
        const params = await extractParams(config.extractorModel, event);

        if (!params.appname) {
          setError("Cannot extract appname from alarm event, please specify manually. Usage: /log -a <appname>");
          setMode("idle");
          setLoading(false);
          return;
        }

        const parts: string[] = [];
        if (params.startTime) parts.push(`Start: ${new Date(params.startTime * 1000).toISOString()}`);
        if (params.endTime) parts.push(`End: ${new Date(params.endTime * 1000).toISOString()}`);
        parts.push(`App: ${params.appname}`);
        if (params.podname) parts.push(`Pod: ${params.podname}`);
        if (params.apiPath) parts.push(`API: ${params.apiPath}`);
        if (params.servicer?.length) parts.push(`Downstream: ${params.servicer.join(",")}`);
        if (params.downstreamApi?.length) parts.push(`Downstream API: ${params.downstreamApi.join(",")}`);
        const extractedInfo = parts.join(" | ");

        // Incremental output: extracted conditions
        const logDsName = logDs.id.name;
        const sourceDesc = `ES: ${getPluginConfig<LogES>(config, "log-elasticsearch")?.indexPattern || "unknown"}`;
        const queryInfo = `Alarm Drill: ${parsed.eventId} | ${sourceDesc} | ${extractedInfo}`;
        pushStatic(formatExtractedParamsOutput("Alarm Drill", queryInfo, extractedInfo));

        const logQueryParams: LogQueryParams = { appname: params.appname };
        if (params.startTime) logQueryParams.startTime = new Date(params.startTime * 1000).toISOString();
        logQueryParams.endTime = new Date((params.endTime || params.startTime! + 300) * 1000).toISOString();
        logQueryParams.extraTerms = buildExtraTerms({ podname: params.podname, uri: params.apiPath });

        setLoadingStepIndex(2);
        const logPromise = logDs.query(config, logQueryParams) as Promise<LogQueryResult>;

        const metricsDs = manager.hasAvailable("metrics", config);
        const metricsPromise = metricsDs
          ? (async () => {
              try {
                if (params.startTime && params.appname) {
                  const metricsParams: MetricsQueryParams = {
                    appname: params.appname, podname: params.podname, apiPath: params.apiPath,
                    servicer: params.servicer, downstreamApi: params.downstreamApi,
                    startTime: params.startTime, endTime: params.endTime || params.startTime + 1800,
                  };
                  const mResult = await metricsDs.query(config, metricsParams) as MetricsQueryResult;
                  return mResult.formatted;
                }
              } catch { /* Metrics query failure does not interrupt */ }
              return null;
            })()
          : Promise.resolve(null);

        const [logResult, metricsText] = await Promise.all([logPromise, metricsPromise]);

        // Incremental output: logs
        pushStatic(formatLogsChunkOutput(logResult.entries));

        // Incremental output: metrics
        if (metricsText) {
          pushStatic(formatMetricsChunkOutput(metricsText));
        }

        // Extract traceIds, query traces one by one and output incrementally
        const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
        const logsByTraceId = groupLogsByTraceId(logResult.entries, traceIdField);
        const uniqueTraceIds = [...logsByTraceId.keys()].slice(0, 5);

        const traceDs = manager.hasAvailable("trace", config);
        const traceResults: DrillTraceGroup[] = [];
        if (uniqueTraceIds.length > 0 && traceDs) {
          for (let i = 0; i < uniqueTraceIds.length; i++) {
            const tid = uniqueTraceIds[i];
            try {
              const traceResult = await traceDs.query(config, { traceId: tid, includeLogs: false }) as TraceQueryResult;
              const group: DrillTraceGroup = { traceId: tid, spans: traceResult.spans, stats: traceResult.stats, logs: logsByTraceId.get(tid) ?? [] };
              traceResults.push(group);
              pushStatic(formatTraceChunkOutput(group, i + 1, uniqueTraceIds.length));
            } catch {
              const group: DrillTraceGroup = { traceId: tid, spans: [], stats: null, logs: logsByTraceId.get(tid) ?? [] };
              traceResults.push(group);
              pushStatic(formatTraceChunkOutput(group, i + 1, uniqueTraceIds.length));
            }
          }
        }

        const drillExportResults: Record<string, unknown> = {
          queryInfo, logs: logResult.entries, traces: traceResults, event, extractedParams: params,
        };
        if (metricsText) drillExportResults.metricsText = metricsText;
        lastExportRef.current = {
          command: cmdStr,
          timestamp: new Date().toISOString(),
          params: { command: cmdStr, eventId: parsed.eventId, extractedInfo, logQueryParams },
          results: drillExportResults,
        };
        setMode("idle");

      } else if (parsed.command === "alarm-analyze-event-online") {
        if (!parsed.eventId) {
          setError("Missing eventId, usage: /alarm-analyze-event-online <eventId>");
          setMode("idle");
          setLoading(false);
          return;
        }

        const manager = managerRef.current;
        const alarmDs = manager.hasAvailable("alarm-event", config);
        const logDs = manager.hasAvailable("log", config);
        if (!alarmDs || !logDs) {
          const missing = [];
          if (!alarmDs) missing.push("alarm event");
          if (!logDs) missing.push("log");
          setError(`No available ${missing.join("/")} data source, please check configuration`);
          setMode("idle");
          setLoading(false);
          return;
        }

        if (!config.extractorModel || !config.analysis) {
          setError("extractorModel or analysis not configured");
          setMode("idle");
          setLoading(false);
          return;
        }

        const analyzeSteps = ["Query alarm event", "Extract parameters from event", "Query logs+traces+metrics", "Run intelligent analysis"];
        setLoadingSteps(analyzeSteps);

        setLoadingStepIndex(0);
        const alarmResult = await alarmDs.query(config, { eventId: parsed.eventId }) as AlarmEventQueryResult;
        const event = alarmResult.raw;

        setLoadingStepIndex(1);
        const params = await extractParams(config.extractorModel, event);

        if (!params.appname) {
          setError("Cannot extract appname from alarm event, cannot perform intelligent analysis");
          setMode("idle");
          setLoading(false);
          return;
        }

        const parts: string[] = [];
        if (params.startTime) parts.push(`Start: ${new Date(params.startTime * 1000).toISOString()}`);
        if (params.endTime) parts.push(`End: ${new Date(params.endTime * 1000).toISOString()}`);
        parts.push(`App: ${params.appname}`);
        if (params.podname) parts.push(`Pod: ${params.podname}`);
        if (params.apiPath) parts.push(`API: ${params.apiPath}`);
        if (params.servicer?.length) parts.push(`Downstream: ${params.servicer.join(",")}`);
        if (params.downstreamApi?.length) parts.push(`Downstream API: ${params.downstreamApi.join(",")}`);
        const extractedInfo = parts.join(" | ");

        // Incremental output: extracted conditions
        const logDsName = logDs.id.name;
        const sourceDesc = `ES: ${getPluginConfig<LogES>(config, "log-elasticsearch")?.indexPattern || "unknown"}`;
        const queryInfo = `Alarm Analyze: ${parsed.eventId} | ${sourceDesc} | ${extractedInfo}`;
        pushStatic(formatExtractedParamsOutput("Alarm Analyze", queryInfo, extractedInfo));

        const logQueryParams: LogQueryParams = { appname: params.appname };
        if (params.startTime) logQueryParams.startTime = new Date(params.startTime * 1000).toISOString();
        logQueryParams.endTime = new Date((params.endTime || params.startTime! + 300) * 1000).toISOString();
        logQueryParams.extraTerms = buildExtraTerms({ podname: params.podname, uri: params.apiPath });

        setLoadingStepIndex(2);
        const logPromise = logDs.query(config, logQueryParams) as Promise<LogQueryResult>;

        const metricsDs = manager.hasAvailable("metrics", config);
        const analyzeMetricsPromise = metricsDs
          ? (async () => {
              try {
                if (params.startTime && params.appname) {
                  const metricsParams: MetricsQueryParams = {
                    appname: params.appname, podname: params.podname, apiPath: params.apiPath,
                    servicer: params.servicer, downstreamApi: params.downstreamApi,
                    startTime: params.startTime, endTime: params.endTime || params.startTime + 1800,
                  };
                  const mResult = await metricsDs.query(config, metricsParams) as MetricsQueryResult;
                  return { results: mResult.results, formatted: mResult.formatted };
                }
              } catch { /* Metrics query failure does not interrupt */ }
              return null;
            })()
          : Promise.resolve(null);

        const [analyzeLogResult, analyzeMetricsData] = await Promise.all([logPromise, analyzeMetricsPromise]);

        // Incremental output: logs
        pushStatic(formatLogsChunkOutput(analyzeLogResult.entries));

        // Incremental output: metrics
        if (analyzeMetricsData?.formatted) {
          pushStatic(formatMetricsChunkOutput(analyzeMetricsData.formatted));
        }

        // Query traces one by one and output incrementally
        const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
        const logsByTraceId = groupLogsByTraceId(analyzeLogResult.entries, traceIdField);
        const uniqueTraceIds = [...logsByTraceId.keys()].slice(0, 5);

        const traceDs = manager.hasAvailable("trace", config);
        const traceResults: DrillTraceGroup[] = [];
        if (uniqueTraceIds.length > 0 && traceDs) {
          for (let i = 0; i < uniqueTraceIds.length; i++) {
            const tid = uniqueTraceIds[i];
            try {
              const r = await traceDs.query(config, { traceId: tid, includeLogs: false }) as TraceQueryResult;
              const group: DrillTraceGroup = { traceId: tid, spans: r.spans, stats: r.stats, logs: logsByTraceId.get(tid) ?? [] };
              traceResults.push(group);
              pushStatic(formatTraceChunkOutput(group, i + 1, uniqueTraceIds.length));
            } catch {
              const group: DrillTraceGroup = { traceId: tid, spans: [], stats: null, logs: logsByTraceId.get(tid) ?? [] };
              traceResults.push(group);
              pushStatic(formatTraceChunkOutput(group, i + 1, uniqueTraceIds.length));
            }
          }
        }

        setLoadingStepIndex(3);
        const analyzeExportResults: Record<string, unknown> = {
          queryInfo, logs: analyzeLogResult.entries, traces: traceResults, event, extractedParams: params,
        };
        if (analyzeMetricsData?.results) analyzeExportResults.metrics = analyzeMetricsData.results;
        const exportData: ExportData = {
          command: cmdStr,
          timestamp: new Date().toISOString(),
          params: { command: cmdStr, eventId: parsed.eventId, extractedInfo, logQueryParams },
          results: analyzeExportResults,
        };

        const analysisRes = await analyzeAlarm(
          params.appname, exportData, config.analysis,
          (msg) => setLoadingSubStep(msg), splitMetricsConfig(getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus")).promConfig,
          splitMetricsConfig(getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus")).prometheusUrl
        );

        // Incremental output: LLM analysis results
        pushStatic(formatAlarmAnalyzeOutput(analysisRes, queryInfo));

        lastExportRef.current = {
          ...exportData,
          params: { ...exportData.params, analysisType: analysisRes.type, analyzerName: analysisRes.analyzerName },
          results: {
            ...(exportData.results as Record<string, unknown>),
            analysis: {
              type: analysisRes.type, appname: analysisRes.appname, analyzerName: analysisRes.analyzerName,
              contextName: analysisRes.contextName, analysisText: analysisRes.analysisText, statistics: analysisRes.statistics,
            },
          },
        };
        setMode("idle");

      } else if (parsed.command === "alarm-analyze-file") {
        if (!parsed.filePath) {
          setError("Missing filePath, usage: /alarm-analyze-file <filePath>");
          setMode("idle");
          setLoading(false);
          return;
        }

        if (!config.analysis) {
          setError("analysis not configured");
          setMode("idle");
          setLoading(false);
          return;
        }

        setLoadingSteps(["Reading file", "Run intelligent analysis"]);
        setLoadingStepIndex(0);
        let exportData: ExportData;
        try {
          const raw = readFileSync(parsed.filePath, "utf-8");
          exportData = JSON.parse(raw) as ExportData;
        } catch (err) {
          setError(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
          setMode("idle");
          setLoading(false);
          return;
        }

        const appname = extractAppnameFromData(exportData);
        const queryInfo = `Alarm Analyze (file): ${parsed.filePath}${appname ? ` | App: ${appname}` : ""}`;

        setLoadingStepIndex(1);
        const { promConfig, prometheusUrl } = splitMetricsConfig(getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus"));
        const analysisRes = await analyzeAlarm(appname, exportData, config.analysis, (msg) => setLoadingSubStep(msg), promConfig, prometheusUrl);

        const output = formatAlarmAnalyzeOutput(analysisRes, queryInfo);
        pushStatic(output);

        lastExportRef.current = {
          ...exportData,
          params: { ...exportData.params, analysisType: analysisRes.type, analyzerName: analysisRes.analyzerName },
          results: {
            ...(exportData.results as Record<string, unknown>),
            analysis: {
              type: analysisRes.type, appname: analysisRes.appname, analyzerName: analysisRes.analyzerName,
              contextName: analysisRes.contextName, analysisText: analysisRes.analysisText, statistics: analysisRes.statistics,
            },
          },
        };
        setMode("idle");

      } else if (parsed.command === "alarm-analyze-event-online-agent") {
        if (!parsed.eventId) {
          setError("Missing eventId, usage: /alarm-analyze-event-online-agent <eventId>");
          setMode("idle");
          setLoading(false);
          return;
        }
        if (!config.agentModel) {
          setError("agentModel not configured");
          setMode("idle");
          setLoading(false);
          return;
        }

        // Reuse existing analysis results, skip Phase 1
        if (parsed.llmInputFile) {
          try {
            const initialPrompt = readFileSync(parsed.llmInputFile, "utf-8");
            startAgent(initialPrompt, "");
            return;
          } catch (err) {
            setError(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
            setMode("idle");
            setLoading(false);
            return;
          }
        }

        // No existing results, execute Phase 1
        const manager = managerRef.current;
        const alarmDs = manager.hasAvailable("alarm-event", config);
        const logDs = manager.hasAvailable("log", config);
        if (!alarmDs || !logDs) {
          const missing = [];
          if (!alarmDs) missing.push("alarm event");
          if (!logDs) missing.push("log");
          setError(`No available ${missing.join("/")} data source, please check configuration`);
          setMode("idle");
          setLoading(false);
          return;
        }

        if (!config.extractorModel || !config.analysis) {
          setError("extractorModel or analysis not configured");
          setMode("idle");
          setLoading(false);
          return;
        }

        const analyzeSteps = ["Query alarm event", "Extract parameters from event", "Query logs+traces+metrics", "Run intelligent analysis", "Start Agent"];
        setLoadingSteps(analyzeSteps);

        setLoadingStepIndex(0);
        const alarmResult = await alarmDs.query(config, { eventId: parsed.eventId }) as AlarmEventQueryResult;
        const event = alarmResult.raw;

        setLoadingStepIndex(1);
        const params = await extractParams(config.extractorModel, event);
        if (!params.appname) {
          setError("Cannot extract appname from alarm event, cannot perform intelligent analysis");
          setMode("idle");
          setLoading(false);
          return;
        }
        const parts: string[] = [];
        if (params.startTime) parts.push(`Start: ${new Date(params.startTime * 1000).toISOString()}`);
        if (params.endTime) parts.push(`End: ${new Date(params.endTime * 1000).toISOString()}`);
        parts.push(`App: ${params.appname}`);
        if (params.podname) parts.push(`Pod: ${params.podname}`);
        if (params.apiPath) parts.push(`API: ${params.apiPath}`);

        const logQueryParams: LogQueryParams = { appname: params.appname };
        if (params.startTime) logQueryParams.startTime = new Date(params.startTime * 1000).toISOString();
        logQueryParams.endTime = new Date((params.endTime || params.startTime! + 300) * 1000).toISOString();
        logQueryParams.extraTerms = buildExtraTerms({ podname: params.podname, uri: params.apiPath });

        setLoadingStepIndex(2);
        const logPromise = logDs.query(config, logQueryParams) as Promise<LogQueryResult>;

        const metricsDs = manager.hasAvailable("metrics", config);
        const analyzeMetricsPromise = metricsDs
          ? (async () => {
              try {
                if (params.startTime && params.appname) {
                  const mp: MetricsQueryParams = {
                    appname: params.appname, podname: params.podname, apiPath: params.apiPath,
                    servicer: params.servicer, downstreamApi: params.downstreamApi,
                    startTime: params.startTime, endTime: params.endTime || params.startTime + 1800,
                  };
                  const mr = await metricsDs.query(config, mp) as MetricsQueryResult;
                  return { results: mr.results, formatted: mr.formatted };
                }
              } catch {}
              return null;
            })()
          : Promise.resolve(null);
        const [analyzeLogResult] = await Promise.all([logPromise, analyzeMetricsPromise]);

        const traceIdField = getPluginConfig<LogES>(config, "log-elasticsearch")?.traceIdField || "traceId";
        const logsByTraceId = groupLogsByTraceId(analyzeLogResult.entries, traceIdField);
        const uniqueTraceIds = [...logsByTraceId.keys()].slice(0, 5);

        const traceDs = manager.hasAvailable("trace", config);
        let traceResults: DrillTraceGroup[] = [];
        if (uniqueTraceIds.length > 0 && traceDs) {
          traceResults = await Promise.all(uniqueTraceIds.map(async (tid) => {
            try {
              const r = await traceDs.query(config, { traceId: tid, includeLogs: false }) as TraceQueryResult;
              return { traceId: tid, spans: r.spans, stats: r.stats, logs: logsByTraceId.get(tid) ?? [] };
            } catch {
              return { traceId: tid, spans: [], stats: null, logs: logsByTraceId.get(tid) ?? [] };
            }
          }));
        }

        setLoadingStepIndex(3);
        const exportResults: Record<string, unknown> = { logs: analyzeLogResult.entries, traces: traceResults, event, extractedParams: params };
        const exportData: ExportData = { command: cmdStr, timestamp: new Date().toISOString(), params: { command: cmdStr, eventId: parsed.eventId, extractedInfo: parts.join(" | "), logQueryParams }, results: exportResults };
        const { promConfig: promConf1, prometheusUrl: promUrl1 } = splitMetricsConfig(getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus"));
        const analysisRes = await analyzeAlarm(params.appname, exportData, config.analysis, (msg) => setLoadingSubStep(msg), promConf1, promUrl1);
        if (analysisRes.type === "statistics") {
          setError("Analysis result is statistical summary (no LLM analysis), cannot start Agent");
          setMode("idle");
          setLoading(false);
          return;
        }

        setLoadingStepIndex(4);
        startAgent(analysisRes.llmInput || "", analysisRes.analysisText || "");

      } else if (parsed.command === "alarm-analyze-file-agent") {
        if (!parsed.filePath) {
          setError("Missing filePath, usage: /alarm-analyze-file-agent <filePath>");
          setMode("idle");
          setLoading(false);
          return;
        }
        if (!config.agentModel) {
          setError("agentModel not configured");
          setMode("idle");
          setLoading(false);
          return;
        }

        if (parsed.llmInputFile) {
          try {
            const initialPrompt = readFileSync(parsed.llmInputFile, "utf-8");
            startAgent(initialPrompt, "");
            return;
          } catch (err) {
            setError(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
            setMode("idle");
            setLoading(false);
            return;
          }
        }

        if (!config.analysis) {
          setError("analysis not configured");
          setMode("idle");
          setLoading(false);
          return;
        }

        setLoadingSteps(["Reading file", "Run intelligent analysis", "Start Agent"]);
        setLoadingStepIndex(0);
        let exportData: ExportData;
        try {
          const raw = readFileSync(parsed.filePath, "utf-8");
          exportData = JSON.parse(raw) as ExportData;
        } catch (err) {
          setError(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
          setMode("idle");
          setLoading(false);
          return;
        }
        const appname = extractAppnameFromData(exportData);

        setLoadingStepIndex(1);
        const { promConfig, prometheusUrl } = splitMetricsConfig(getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus"));
        const analysisRes = await analyzeAlarm(appname, exportData, config.analysis, (msg) => setLoadingSubStep(msg), promConfig, prometheusUrl);
        if (analysisRes.type === "statistics") {
          setError("Analysis result is statistical summary (no LLM analysis), cannot start Agent");
          setMode("idle");
          setLoading(false);
          return;
        }

        setLoadingStepIndex(2);
        startAgent(analysisRes.llmInput || "", analysisRes.analysisText || "");

      } else if (parsed.command === "query-metrics") {
        if (!parsed.metricsQuery) {
          setError("Missing PromQL expression, usage: /query-metrics <PromQL>");
          setMode("idle");
          setLoading(false);
          return;
        }

        const manager = managerRef.current;
        if (!manager.hasAvailable("metrics", config)) {
          setError("No available metrics data source, please check prometheus configuration");
          setMode("idle");
          setLoading(false);
          return;
        }

        setLoadingStage("Querying Prometheus metrics...");
        const metricsConf = getPluginConfig<MetricsPrometheusConfig>(config, "metrics-prometheus");
        const baseUrl = metricsConf?.remoteReadUrl!;

        const now = Math.floor(Date.now() / 1000);
        const lookback = parsed.metricsLookback ? parseRelativeTime(parsed.metricsLookback) : undefined;
        const start = parsed.metricsStart ? parseRelativeTime(parsed.metricsStart) : (lookback || now - 3600);
        const end = parsed.metricsEnd ? parseRelativeTime(parsed.metricsEnd) : now;
        const step = parsed.metricsStep || "30s";

        const fmtLocal = (ts: number) => new Date(ts * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
        setLoadingStage("Querying Prometheus metrics...");
        const queryInfo = `Metrics | ${fmtLocal(start)} - ${fmtLocal(end)}`;

        const result = await promQueryRange(baseUrl, parsed.metricsQuery, start, end, step);

        const debugInfo = !!process.env.OMC_DEBUG
          ? `PromQL: ${parsed.metricsQuery}\nURL: ${baseUrl}/api/v1/query_range\nstart: ${start} (${fmtLocal(start)})  end: ${end} (${fmtLocal(end)})  step: ${step}`
          : undefined;

        const output = formatMetricsOutput(result, queryInfo, debugInfo);
        pushStatic(output);

        lastExportRef.current = {
          command: cmdStr,
          timestamp: new Date().toISOString(),
          params: { command: cmdStr, query: parsed.metricsQuery, start, end, step },
          results: { queryInfo: `Metrics: ${parsed.metricsQuery}`, raw: result },
        };
        setMode("idle");

      } else if (parsed.command === "log") {
        const manager = managerRef.current;
        const logDs = manager.hasAvailable("log", config);
        if (!logDs) {
          setError("No available log data source, please check configuration");
          setMode("idle");
          setLoading(false);
          return;
        }

        const logDsName = logDs.id.name;
        const sourceDesc = `ES: ${getPluginConfig<LogES>(config, "log-elasticsearch")?.indexPattern || "unknown"}`;
        const queryInfo = `Data source: ${sourceDesc}`;
        setLoadingStage("Querying logs...");

        const logParams: LogQueryParams = {
          appname: parsed.logOptions.appname,
          search: parsed.logOptions.search,
          level: parsed.logOptions.level,
          traceId: parsed.logOptions.traceId,
          startTime: parsed.logOptions.startTime,
          endTime: parsed.logOptions.endTime,
          limit: parsed.logOptions.limit,
          extraTerms: parsed.logOptions.extraTerms,
        };
        const result = await logDs.query(config, logParams) as LogQueryResult;

        const output = formatLogsOutput(result.entries, queryInfo);
        pushStatic(output);

        lastExportRef.current = {
          command: cmdStr,
          timestamp: new Date().toISOString(),
          params: { command: cmdStr, ...parsed.logOptions },
          results: { queryInfo, logSource: result.source, logs: result.entries },
        };
        setMode("idle");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setMode("idle");
    } finally {
      setLoading(false);
    }
  }, [exit, startAgent]);

  // Auto-execute initial command on startup if present
  useEffect(() => {
    if (initial && !initialExecuted.current) {
      initialExecuted.current = true;
      const cmdStr = initialToCommandString(initial);
      executeCommand(cmdStr);
    }
  }, [initial, executeCommand]);

  // Static output area: command results enter terminal scrollback
  const staticBlock = staticItems.length > 0 ? (
    <Static items={staticItems}>
      {(item) => <Text key={item.id}>{item.text}</Text>}
    </Static>
  ) : null;

  // idle mode (including agent dialog state)
  if (mode === "idle") {
    const agentPrompt = agentActive ? "agent" : "omc";

    return (
      <>
        {staticBlock}
        <Box flexDirection="column" padding={1}>
          {(agentStreaming || defaultAgentStreaming) && <Spinner label="Agent thinking" />}
          {message && (
            <Box paddingBottom={1}>
              <Text color="yellow">{message}</Text>
            </Box>
          )}
          {error && (
            <Box paddingBottom={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}
          <CommandInput
            availableCommands={resolveCommandAvailabilities(managerRef.current, configRef.current).filter((c) => c.available).map((c) => c.command)}
            onSubmit={(input) => {
              const trimmed = input.trim();
              // When dedicated Agent is active, input is prioritized to dedicated Agent
              if (agentRef.current) {
                if (trimmed === "q" || trimmed === "exit") {
                  handleBack();
                } else {
                  handleAgentInput(trimmed);
                }
                return;
              }
              // /commands go through executeCommand
              if (input.startsWith("/")) {
                executeCommand(input);
                return;
              }
              // exit/quit to exit
              if (trimmed === "exit" || trimmed === "quit") {
                exit();
                return;
              }
              // Default Agent handles natural language input
              if (defaultAgentRef.current) {
                pushStatic(`\n> ${trimmed}`);
                setDefaultAgentStreaming(true);
                defaultAgentRef.current.prompt(trimmed);
              } else {
                executeCommand(input);
              }
            }}
            onQuit={() => { agentRef.current?.abort(); exit(); }}
            prompt={agentPrompt}
          />
        </Box>
      </>
    );
  }

  // loading mode
  if (mode === "loading") {
    return (
      <>
        {staticBlock}
        <Box flexDirection="column" padding={1}>
          {loadingSteps.length > 0 ? (
            <StepsProgress steps={loadingSteps} currentStep={loadingStepIndex} subStep={loadingSubStep} />
          ) : (
            <Spinner label={loadingStage || "Querying..."} />
          )}
          {error && (
            <Box paddingY={1}>
              <Text color="red">{error}</Text>
            </Box>
          )}
        </Box>
      </>
    );
  }

  return null;
}
