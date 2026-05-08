/**
 * Configuration loading module
 *
 * Loads all Monitor CLI configuration items from a JSON configuration file.
 * Datasource configurations are unified under pluginsConfig, where the key is the plugin name and the value is the plugin's own configuration object.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Plugin configuration type definitions ───

export interface TraceES {
  host: string;
  indexPattern: string;
  username?: string;
  password?: string;
}

export interface ESFieldMapping {
  appname?: string;       // default "appname"
  traceId?: string;       // default "traceId"
  level?: string;         // default "level"
  podname?: string;       // not set by default (ES field that the Agent tool's podname parameter maps to)
  uri?: string;           // not set by default (ES field that the Agent tool's uri parameter maps to)
  searchFields?: string;  // default "*" (multi_match field pattern)
  logLevels?: string[];   // default ["DEBUG","INFO","WARN","ERROR","FATAL"]
  traceIdAliases?: string[]; // alternative field names for findTraceId, default ["traceID","trace_id","trace-id","TraceId"]
}

export interface LogES {
  host: string;
  indexPattern: string;
  username?: string;
  password?: string;
  traceIdField?: string;
  timestampField?: string;
  fieldMapping?: ESFieldMapping;
}

/** Metrics Prometheus plugin configuration (specify Prometheus address directly) */
export interface MetricTemplateConfig {
  name: string;
  category: string;    // "resource" / "traffic" / "latency"
  groupBy: string;     // "pod" / "api" / "servicer" / "total"
  needsServicer: boolean;
  needsApi: boolean;
  /** PromQL template, supports {{cluster}} {{namespace}} {{pod}} {{appname}} {{api}} {{servicer}} {{downstreamApi}} {{rateInterval}} variables */
  template: string;
}

export interface MetricsPrometheusConfig {
  clusters: string[];
  namespace: string;
  rateInterval?: string;
  step?: string;
  timeRangeMinutes?: number;
  /** Prometheus remoteRead API URL, e.g. http://localhost:9090 */
  remoteReadUrl?: string;
  /** Custom metric templates, merged with default K8s templates */
  metricTemplates?: MetricTemplateConfig[];
}

/** Fake plugin configuration — specify mock data file path */
export interface FakePluginConfig {
  filePath: string;
}

// ─── Non-plugin configuration type definitions ───

/** Alarm event parameter extraction model configuration */
export interface ExtractorModelConfig {
  /** API base URL, e.g. https://api.example.com/v1 */
  baseUrl: string;
  /** API Token / Key */
  token: string;
  /** Model name */
  model: string;
}

/** Analysis model configuration */
export interface AnalysisModelConfig {
  /** API base URL */
  baseUrl: string;
  /** API Token / Key */
  token: string;
  /** Model name */
  model: string;
  /** Temperature parameter */
  temperature?: number;
  /** Max token count */
  maxTokens?: number;
}

/** Analyzer configuration: combines model + prompt */
export interface AnalysisAnalyzerConfig {
  /** Reference key in models */
  model: string;
  /** Reference prompt file name (without .md), uses built-in sre-deep if not configured */
  prompt?: string;
  /** Override model temperature */
  temperature?: number;
}

/** appname → analyzer + context mapping */
export interface AnalysisMappingConfig {
  /** List of matching appnames */
  apps: string[];
  /** Reference key in analyzers */
  analyzer: string;
  /** Reference contexts file name (without .md) */
  context?: string;
}

/** Field filter configuration */
export interface FieldFilterConfig {
  /** Log fields to retain, retains all fields if not configured */
  logFields?: string[];
  /** Span fields to retain, retains all fields if not configured */
  spanFields?: string[];
  /** Max total data characters, truncates in log→span→event order when exceeded, default 80000 */
  maxDataChars?: number;
}

/** LLM summarization configuration */
export interface SummaryConfig {
  /** Whether to enable LLM summarization, default false */
  enabled?: boolean;
  /** Summary model reference key in models, reuses analyzer's model if not configured */
  model?: string;
  /** Max characters sent to the summary model per chunk, default 20000 */
  chunkSize?: number;
  /** Target character count for summary output, default 4000 */
  targetSize?: number;
  /** Metrics summary-specific prompt file name (without .md), uses built-in metrics summary prompt if not configured */
  metricsPrompt?: string;
}

/** Agent model configuration */
export interface AgentModelConfig {
  /** API base URL */
  baseUrl: string;
  /** API Token / Key */
  token: string;
  /** Model name */
  model: string;
  /** API type, default "openai-completions" */
  api?: "openai-completions" | "openai-responses";
  /** Temperature parameter */
  temperature?: number;
  /** Max token count, default 4096 */
  maxTokens?: number;
  /** Context window size, default 128000 */
  contextWindow?: number;
  /** Whether to enable reasoning mode, default false */
  reasoning?: boolean;
  /** Supported input types, default ["text"] */
  input?: ("text" | "image")[];
}

/** Default Agent configuration */
export interface DefaultAgentConfig {
  /** Whether to enable default Agent, default false */
  enabled?: boolean;
  /** Max tool calls per conversation turn, default 10 */
  maxToolCalls?: number;
  /** API base URL */
  baseUrl: string;
  /** API Token / Key */
  token: string;
  /** Model name */
  model: string;
  /** API type, default "openai-completions" */
  api?: "openai-completions" | "openai-responses";
  /** Temperature parameter */
  temperature?: number;
  /** Max token count, default 4096 */
  maxTokens?: number;
  /** Context window size, default 128000 */
  contextWindow?: number;
  /** Whether to enable reasoning mode, default false */
  reasoning?: boolean;
  /** Supported input types, default ["text"] */
  input?: ("text" | "image")[];
}

/** Alarm intelligent analysis configuration */
export interface AnalysisConfig {
  mappings: AnalysisMappingConfig[];
  analyzers: Record<string, AnalysisAnalyzerConfig>;
  models: Record<string, AnalysisModelConfig>;
  /** Field filter (optional toggle) */
  fieldFilter?: FieldFilterConfig;
  /** LLM summarization (optional toggle) */
  summary?: SummaryConfig;
}

/** Memory feature configuration */
export interface MemoryConfig {
  /** Whether to enable memory feature, default false */
  enabled?: boolean;
  /** Max entries to retain per memory type, default 20 */
  maxEntriesPerType?: number;
  /** Max total characters per memory type, default 10000 */
  maxCharsPerType?: number;
}

/** Datasource preference configuration: specify the preferred datasource implementation name for each capability type */
export type DataSourceSelection = Partial<Record<"log" | "trace" | "metrics" | "alarm-event", string>>;

/** Read specified plugin config from pluginsConfig, with type assertion */
export function getPluginConfig<T>(config: Config, pluginName: string): T | undefined {
  const raw = config.pluginsConfig?.[pluginName];
  return raw as T | undefined;
}

export interface Config {
  // Parameter extraction model
  extractorModel?: ExtractorModelConfig;

  // Agent model
  agentModel?: AgentModelConfig;

  // Default Agent
  defaultAgent?: DefaultAgentConfig;

  // Alarm intelligent analysis
  analysis?: AnalysisConfig;

  // Memory feature
  memory?: MemoryConfig;

  // Datasource preference configuration
  /** Specify the preferred datasource implementation name for each capability type, e.g. { log: "elasticsearch", trace: "elasticsearch" } */
  dataSources?: DataSourceSelection;

  // Plugin configuration (built-in + third-party unified)
  /** key is the plugin name, value is the plugin's own configuration object */
  pluginsConfig?: Record<string, unknown>;

  // Dynamically load plugins
  /** npm package name or local path list, loaded and registered at runtime */
  plugins?: string[];
}

function loadConfigFile(configPath?: string): Partial<Config> {
  try {
    const finalPath = configPath || join(homedir(), ".omc.json");
    const raw = readFileSync(finalPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function loadEnvConfig(): Partial<Config> {
  // Parameter extraction model configuration
  const extractorBaseUrl =
    process.env.EXTRACTOR_MODEL_BASE_URL || process.env.MONITOR_EXTRACTOR_MODEL_BASE_URL;
  const extractorToken =
    process.env.EXTRACTOR_MODEL_TOKEN || process.env.MONITOR_EXTRACTOR_MODEL_TOKEN;
  const extractorModelName =
    process.env.EXTRACTOR_MODEL_NAME || process.env.MONITOR_EXTRACTOR_MODEL_NAME;

  // Agent model configuration
  const agentBaseUrl =
    process.env.AGENT_MODEL_BASE_URL || process.env.MONITOR_AGENT_MODEL_BASE_URL;
  const agentToken =
    process.env.AGENT_MODEL_TOKEN || process.env.MONITOR_AGENT_MODEL_TOKEN;
  const agentModelName =
    process.env.AGENT_MODEL_NAME || process.env.MONITOR_AGENT_MODEL_NAME;
  const agentApi =
    process.env.AGENT_MODEL_API || process.env.MONITOR_AGENT_MODEL_API;

  // Default Agent configuration
  const defaultAgentBaseUrl =
    process.env.DEFAULT_AGENT_BASE_URL || process.env.MONITOR_DEFAULT_AGENT_BASE_URL;
  const defaultAgentToken =
    process.env.DEFAULT_AGENT_TOKEN || process.env.MONITOR_DEFAULT_AGENT_TOKEN;
  const defaultAgentModelName =
    process.env.DEFAULT_AGENT_MODEL || process.env.MONITOR_DEFAULT_AGENT_MODEL;

  // Memory feature configuration
  const memoryEnabled = process.env.MONITOR_MEMORY_ENABLED;
  const memoryMaxEntries = process.env.MONITOR_MEMORY_MAX_ENTRIES;
  const memoryMaxChars = process.env.MONITOR_MEMORY_MAX_CHARS;

  return {
    extractorModel:
      extractorBaseUrl && extractorToken && extractorModelName
        ? { baseUrl: extractorBaseUrl, token: extractorToken, model: extractorModelName }
        : undefined,
    agentModel:
      agentBaseUrl && agentToken && agentModelName
        ? { baseUrl: agentBaseUrl, token: agentToken, model: agentModelName, api: (agentApi as "openai-completions" | "openai-responses") || undefined }
        : undefined,
    defaultAgent:
      defaultAgentBaseUrl && defaultAgentToken && defaultAgentModelName
        ? { baseUrl: defaultAgentBaseUrl, token: defaultAgentToken, model: defaultAgentModelName }
        : undefined,
    memory:
      memoryEnabled !== undefined
        ? {
            enabled: memoryEnabled === "true" || memoryEnabled === "1",
            maxEntriesPerType: memoryMaxEntries ? parseInt(memoryMaxEntries, 10) : undefined,
            maxCharsPerType: memoryMaxChars ? parseInt(memoryMaxChars, 10) : undefined,
          }
        : undefined,
  };
}

export function loadConfig(configPath?: string): Config {
  const fileConfig = loadConfigFile(configPath);
  const envConfig = loadEnvConfig();

  const config: Config = {};

  // extractorModel configuration
  const fileExtractor = fileConfig.extractorModel as ExtractorModelConfig | undefined;
  const envExtractor = envConfig.extractorModel;
  if (envExtractor?.baseUrl && envExtractor?.token && envExtractor?.model) {
    config.extractorModel = envExtractor;
  } else if (fileExtractor?.baseUrl && fileExtractor?.token && fileExtractor?.model) {
    config.extractorModel = fileExtractor;
  }

  // agentModel configuration
  const fileAgentModel = fileConfig.agentModel as AgentModelConfig | undefined;
  const envAgentModel = envConfig.agentModel;
  if (envAgentModel?.baseUrl && envAgentModel?.token && envAgentModel?.model) {
    config.agentModel = envAgentModel;
  } else if (fileAgentModel?.baseUrl && fileAgentModel?.token && fileAgentModel?.model) {
    config.agentModel = fileAgentModel;
  }

  // defaultAgent configuration
  const fileDefaultAgent = fileConfig.defaultAgent as DefaultAgentConfig | undefined;
  const envDefaultAgent = envConfig.defaultAgent;
  if (envDefaultAgent?.baseUrl && envDefaultAgent?.token && envDefaultAgent?.model) {
    config.defaultAgent = envDefaultAgent;
  } else if (fileDefaultAgent?.baseUrl && fileDefaultAgent?.token && fileDefaultAgent?.model) {
    config.defaultAgent = fileDefaultAgent;
  }

  // analysis configuration (loaded from file only)
  const fileAnalysis = fileConfig.analysis as AnalysisConfig | undefined;
  if (fileAnalysis?.analyzers && fileAnalysis?.models) {
    config.analysis = fileAnalysis;
  }

  // memory configuration
  const fileMemory = fileConfig.memory as MemoryConfig | undefined;
  const envMemory = envConfig.memory;
  if (envMemory?.enabled !== undefined || fileMemory?.enabled !== undefined) {
    config.memory = {
      enabled: envMemory?.enabled ?? fileMemory?.enabled,
      maxEntriesPerType: envMemory?.maxEntriesPerType ?? fileMemory?.maxEntriesPerType,
      maxCharsPerType: envMemory?.maxCharsPerType ?? fileMemory?.maxCharsPerType,
    };
  }

  // dataSources configuration (loaded from file only)
  const fileDataSources = fileConfig.dataSources as DataSourceSelection | undefined;
  if (fileDataSources && Object.keys(fileDataSources).length > 0) {
    config.dataSources = fileDataSources;
  }

  // pluginsConfig configuration (loaded from file only)
  if (fileConfig.pluginsConfig && typeof fileConfig.pluginsConfig === "object") {
    config.pluginsConfig = fileConfig.pluginsConfig as Record<string, unknown>;
  }

  // plugins configuration (loaded from file only, dynamic plugin list)
  const filePlugins = fileConfig.plugins as string[] | undefined;
  if (filePlugins && Array.isArray(filePlugins)) {
    config.plugins = filePlugins;
  }

  return config;
}