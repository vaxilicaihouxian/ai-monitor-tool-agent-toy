/**
 * Prometheus metrics query client
 *
 * Features:
 * - PromQL range/instant queries
 * - Metric template system (K8s common + configurable custom templates)
 * - Format output as statistical text
 */

import { debug } from "./utils/logger.js";

// ─── Type Definitions ───

export interface PromQueryResult {
  resultType: string;
  result: PromSeries[];
}

export interface PromSeries {
  metric: Record<string, string>;
  values?: [number, string][];
  value?: [number, string];
}

export interface MetricsQueryParams {
  appname: string;
  podname?: string;
  apiPath?: string;
  servicer?: string[];
  downstreamApi?: string[];
  startTime: number; // Unix timestamp (seconds)
  endTime: number;   // Unix timestamp (seconds)
}

export interface PrometheusConfig {
  clusters: string[];
  namespace: string;
  rateInterval?: string;  // default "2m"
  step?: string;          // default "30s"
  timeRangeMinutes?: number; // default 30
  metricTemplates?: import("./config.js").MetricTemplateConfig[];
}

export interface MetricQueryResult {
  name: string;       // Metric name, e.g. "CPU utilization"
  category: string;   // Category: "resource" / "traffic" / "latency"
  groupBy: string;    // Group dimension: "pod" / "api" / "servicer"
  query: string;      // The PromQL query
  cluster: string;    // The queried cluster
  formatted: string;  // Formatted text
  raw?: PromQueryResult;
}

// ─── Prometheus Queries ───

/**
 * Safely build Prometheus API URL
 */
function buildPromUrl(baseUrl: string, apiPath: string): URL {
  const base = baseUrl.replace(/\/+$/, "");
  const fullUrl = `${base}${apiPath}`;
  return new URL(fullUrl);
}

/**
 * Prometheus range query
 */
export async function promQueryRange(
  baseUrl: string,
  query: string,
  start: number,
  end: number,
  step: string = "30s"
): Promise<PromQueryResult> {
  const url = buildPromUrl(baseUrl, "/api/v1/query_range");
  url.searchParams.set("query", query);
  url.searchParams.set("start", String(start));
  url.searchParams.set("end", String(end));
  url.searchParams.set("step", step);

  debug(`[prom] query_range request params:\n`);
  debug(`  URL: ${url.toString()}\n`);
  debug(`  baseUrl: ${baseUrl}\n`);
  debug(`  query: ${query}\n`);
  debug(`  start: ${start} (${new Date(start * 1000).toISOString()})\n`);
  debug(`  end: ${end} (${new Date(end * 1000).toISOString()})\n`);
  debug(`  step: ${step}\n`);

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Prometheus query_range failed (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as { status: string; data?: PromQueryResult; error?: string };

  if (json.status !== "success") {
    throw new Error(`Prometheus query error: ${json.error || JSON.stringify(json)}`);
  }

  return json.data ?? { resultType: "matrix", result: [] };
}

/**
 * Prometheus instant query
 */
export async function promQueryInstant(
  baseUrl: string,
  query: string,
  time?: number
): Promise<PromQueryResult> {
  const url = buildPromUrl(baseUrl, "/api/v1/query");
  url.searchParams.set("query", query);
  if (time !== undefined) {
    url.searchParams.set("time", String(time));
  }

  debug(`[prom] query request params:\n`);
  debug(`  URL: ${url.toString()}\n`);
  debug(`  baseUrl: ${baseUrl}\n`);
  debug(`  query: ${query}\n`);
  if (time !== undefined) {
    debug(`  time: ${time} (${new Date(time * 1000).toISOString()})\n`);
  }

  const response = await fetch(url.toString());

  if (!response.ok) {
    throw new Error(`Prometheus query failed (${response.status}): ${await response.text()}`);
  }

  const json = (await response.json()) as { status: string; data?: PromQueryResult; error?: string };

  if (json.status !== "success") {
    throw new Error(`Prometheus query error: ${json.error || JSON.stringify(json)}`);
  }

  return json.data ?? { resultType: "vector", result: [] };
}

/**
 * Parse relative time string
 */
export function parseRelativeTime(input: string): number {
  const trimmed = input.trim();

  if (trimmed === "now") {
    return Math.floor(Date.now() / 1000);
  }

  // Relative time format: 5m, 1h, 2d
  const relMatch = trimmed.match(/^(\d+)([smhd])$/);
  if (relMatch) {
    const value = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const multipliers: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };
    return Math.floor(Date.now() / 1000) - value * (multipliers[unit] || 1);
  }

  // Pure number → Unix timestamp
  if (/^\d+$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    // If it looks like a millisecond timestamp, convert to seconds
    if (num > 1e12) return Math.floor(num / 1000);
    return num;
  }

  // ISO time string
  const parsed = Date.parse(trimmed);
  if (!isNaN(parsed)) {
    return Math.floor(parsed / 1000);
  }

  throw new Error(`Cannot parse time parameter: "${input}"`);
}

// ─── PromQL Template Functions ───

/** Variable substitution, generate final PromQL */
function applyTemplateVars(
  template: string,
  vars: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

/**
 * CPU utilization (by pod) — K8s common metric
 */
export function buildCpuQuery(params: MetricsQueryParams, config: PrometheusConfig, cluster: string): string {
  const template = `sum(rate(container_cpu_usage_seconds_total{cluster=~"{{cluster}}",namespace=~"{{namespace}}",pod=~"{{pod}}",container!="POD",image!=""}[2m])*100)by(pod)/sum(container_spec_cpu_quota{cluster=~"{{cluster}}",namespace=~"{{namespace}}",pod=~"{{pod}}",container!="POD",image!=""}/container_spec_cpu_period{cluster=~"{{cluster}}",namespace=~"{{namespace}}",pod=~"{{pod}}",container!="POD",image!=""})by(pod)`;

  const pod = params.podname || `${params.appname}-.*`;
  return applyTemplateVars(template, {
    cluster,
    namespace: config.namespace,
    pod,
  });
}

/**
 * Memory utilization (by pod) — K8s common metric, result needs ×100 to convert to percentage
 */
export function buildMemoryQuery(params: MetricsQueryParams, config: PrometheusConfig, cluster: string): string {
  const template = `sum(container_memory_working_set_bytes{cluster=~"{{cluster}}",namespace=~"{{namespace}}",pod=~"{{pod}}",container!="POD",image!=""}) by (pod)/ sum(container_spec_memory_limit_bytes{cluster=~"{{cluster}}",namespace=~"{{namespace}}",pod=~"{{pod}}",container!="POD",image!=""}) by (pod)`;

  const pod = params.podname || `${params.appname}-.*`;
  return applyTemplateVars(template, {
    cluster,
    namespace: config.namespace,
    pod,
  });
}

// ─── Default Common Templates (K8s basic resource metrics only) ───

/** Template definition */
interface MetricTemplate {
  name: string;
  category: string;
  groupBy: string;
  needsServicer: boolean;
  needsApi: boolean;
  build: (params: MetricsQueryParams, config: PrometheusConfig, cluster: string, servicer?: string) => string;
}

/** Get default templates (K8s common metrics only) */
function getDefaultTemplates(): MetricTemplate[] {
  return [
    { name: "CPU utilization", category: "resource", groupBy: "pod", needsServicer: false, needsApi: false, build: buildCpuQuery },
    { name: "Memory utilization", category: "resource", groupBy: "pod", needsServicer: false, needsApi: false, build: buildMemoryQuery },
  ];
}

/** Build template list from configured metricTemplates */
function getConfiguredTemplates(config: PrometheusConfig): MetricTemplate[] {
  if (!config.metricTemplates || config.metricTemplates.length === 0) {
    return [];
  }

  return config.metricTemplates.map((tmpl) => ({
    name: tmpl.name,
    category: tmpl.category,
    groupBy: tmpl.groupBy,
    needsServicer: tmpl.needsServicer,
    needsApi: tmpl.needsApi,
    build: (params: MetricsQueryParams, promConfig: PrometheusConfig, cluster: string, _servicer?: string) => {
      const pod = params.podname || `${params.appname}-.*`;
      const api = params.apiPath || ".*";
      const rateInterval = promConfig.rateInterval || "2m";
      const servicer = _servicer || ".*";
      const downstreamApi = params.downstreamApi?.length ? params.downstreamApi.join("|") : ".*";

      return applyTemplateVars(tmpl.template, {
        cluster,
        namespace: promConfig.namespace,
        pod,
        appname: params.appname,
        api,
        servicer,
        downstreamApi,
        rateInterval,
      });
    },
  }));
}

/** Get merged template list */
function getAllTemplates(config: PrometheusConfig): MetricTemplate[] {
  const defaults = getDefaultTemplates();
  const configured = getConfiguredTemplates(config);
  if (configured.length > 0) {
    return [...defaults, ...configured];
  }
  return defaults;
}

// ─── Core Query Functions ───

/**
 * Query alarm-related metrics
 *
 * Iterate templates × clusters, issue concurrent query_range
 */
export async function queryAlarmMetrics(
  promConfig: PrometheusConfig,
  baseUrl: string,
  params: MetricsQueryParams,
  onProgress?: (msg: string) => void
): Promise<MetricQueryResult[]> {
  const step = promConfig.step || "30s";
  const timeRangeMinutes = promConfig.timeRangeMinutes || 30;

  // Time window
  const start = params.startTime - timeRangeMinutes * 60;
  const end = params.endTime ? params.endTime + timeRangeMinutes * 60 : params.startTime + timeRangeMinutes * 60;

  const templates = getAllTemplates(promConfig);
  const results: MetricQueryResult[] = [];

  // Build servicer list: iterate if provided, otherwise use ".*"
  const servicerList = params.servicer && params.servicer.length > 0
    ? params.servicer
    : [".*"];

  // Build all query tasks
  const tasks: Array<{
    template: MetricTemplate;
    cluster: string;
    query: string;
    servicer?: string;
  }> = [];

  for (const tmpl of templates) {
    if (tmpl.needsServicer && !params.servicer?.length) continue;
    if (tmpl.needsApi && !params.apiPath) continue;

    for (const cluster of promConfig.clusters) {
      if (tmpl.needsServicer) {
        for (const s of servicerList) {
          tasks.push({
            template: tmpl,
            cluster,
            query: tmpl.build(params, promConfig, cluster, s),
            servicer: s,
          });
        }
      } else {
        tasks.push({
          template: tmpl,
          cluster,
          query: tmpl.build(params, promConfig, cluster),
        });
      }
    }
  }

  onProgress?.(`Querying ${tasks.length} metrics...`);

  debug(`[prom] queryAlarmMetrics: baseUrl=${baseUrl}, start=${start}, end=${end}, step=${step}\n`);
  for (let i = 0; i < tasks.length; i++) {
    debug(`[prom]   task[${i}]: ${tasks[i].template.name} cluster=${tasks[i].cluster} query=${tasks[i].query}\n`);
  }

  // Concurrent queries
  const queryResults = await Promise.allSettled(
    tasks.map(async (task) => {
      const raw = await promQueryRange(baseUrl, task.query, start, end, step);
      const formatted = formatSingleMetric(
        task.template.name,
        task.template.category,
        task.template.groupBy,
        raw,
        params.startTime,
        start,
        end,
        step,
        task.cluster,
        task.template.name === "Memory utilization" // isMemory flag
      );
      return {
        name: task.template.name,
        category: task.template.category,
        groupBy: task.template.groupBy,
        query: task.query,
        cluster: task.cluster,
        formatted,
        raw,
      } as MetricQueryResult;
    })
  );

  for (let i = 0; i < queryResults.length; i++) {
    const r = queryResults[i];
    if (r.status === "fulfilled") {
      results.push(r.value);
    } else {
      const task = tasks[i];
      results.push({
        name: task.template.name,
        category: task.template.category,
        groupBy: task.template.groupBy,
        query: task.query,
        cluster: task.cluster,
        formatted: `(Query failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)})`,
      });
    }
  }

  return results;
}

// ─── Formatting Functions ───

/** Format a single metric query result */
function formatSingleMetric(
  name: string,
  _category: string,
  groupBy: string,
  raw: PromQueryResult,
  alarmStartTime: number,
  queryStart: number,
  queryEnd: number,
  step: string,
  cluster: string,
  isMemory: boolean
): string {
  const series = raw.result;
  if (!series || series.length === 0) {
    return `(no data)`;
  }

  const lines: string[] = [];
  const startTimeStr = formatTimestamp(queryStart);
  const endTimeStr = formatTimestamp(queryEnd);

  for (const s of series) {
    const values = s.values;
    if (!values || values.length === 0) continue;

    const label = s.metric.pod || s.metric.api || s.metric.servicer || "total";
    const clusterTag = s.metric.cluster ? ` [cluster: ${s.metric.cluster}]` : (cluster ? ` [cluster: ${cluster}]` : "");
    const groupLabel = groupBy === "total" ? "" : `${groupBy}: `;
    const pointCount = values.length;

    const numValues = values.map((v) => {
      const val = parseFloat(v[1]);
      return isMemory ? val * 100 : val;
    });

    const mean = numValues.reduce((a, b) => a + b, 0) / numValues.length;

    let maxVal = -Infinity;
    let maxIdx = 0;
    let minVal = Infinity;
    let minIdx = 0;
    for (let i = 0; i < numValues.length; i++) {
      if (numValues[i] > maxVal) { maxVal = numValues[i]; maxIdx = i; }
      if (numValues[i] < minVal) { minVal = numValues[i]; minIdx = i; }
    }

    const maxTimeStr = formatTimestamp(values[maxIdx][0]);
    const minTimeStr = formatTimestamp(values[minIdx][0]);

    let alarmValue = NaN;
    let closestDist = Infinity;
    for (const v of values) {
      const dist = Math.abs(v[0] - alarmStartTime);
      if (dist < closestDist) {
        closestDist = dist;
        alarmValue = isMemory ? parseFloat(v[1]) * 100 : parseFloat(v[1]);
      }
    }

    const beforeAlarmStart = alarmStartTime - 300;
    const beforeAlarmValues = numValues.filter((_, i) => {
      const ts = values[i][0];
      return ts >= beforeAlarmStart && ts <= alarmStartTime;
    });
    const beforeAlarmMean = beforeAlarmValues.length > 0
      ? beforeAlarmValues.reduce((a, b) => a + b, 0) / beforeAlarmValues.length
      : NaN;

    const downsampled = downsample(numValues, 40);

    const unit = name.includes("response") || name.includes("latency") || name.includes("P95") ? "ms" : "%";

    lines.push(`- ${groupLabel}${label}${clusterTag}`);
    lines.push(`  Time range: ${startTimeStr} - ${endTimeStr} (step=${step}, ${pointCount} points)`);
    lines.push(`  Avg: ${mean.toFixed(1)}${unit}  Peak: ${maxVal.toFixed(1)}${unit}(${maxTimeStr})  Min: ${minVal.toFixed(1)}${unit}(${minTimeStr})`);
    if (!isNaN(alarmValue)) {
      const alarmLine = `  Value at alert: ${alarmValue.toFixed(1)}${unit}`;
      const beforeLine = isNaN(beforeAlarmMean) ? "" : `  Avg 5min before alert: ${beforeAlarmMean.toFixed(1)}${unit}`;
      lines.push(alarmLine + beforeLine);
    }
    lines.push(`  Time series: [${downsampled.map((v) => Math.round(v))}]`);
  }

  return lines.length > 0 ? lines.join("\n") : `(no data)`;
}

/** Format Unix timestamp to HH:MM:SS */
function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** Downsample */
function downsample(values: number[], targetPoints: number): number[] {
  if (values.length <= targetPoints) return values;
  const step = Math.ceil(values.length / targetPoints);
  const result: number[] = [];
  for (let i = 0; i < values.length; i += step) {
    result.push(values[i]);
  }
  return result;
}

/**
 * Format all metric query results as text
 */
export function formatMetricsResults(results: MetricQueryResult[], _alarmStartTime: number): string {
  const grouped = new Map<string, MetricQueryResult[]>();
  for (const r of results) {
    const key = r.name;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(r);
  }

  const lines: string[] = [];
  for (const [name, items] of grouped) {
    const first = items[0];
    const groupByLabel = first.groupBy === "total" ? "" : ` (by ${first.groupBy})`;
    lines.push(`## ${name}${groupByLabel}`);

    for (const item of items) {
      lines.push(item.formatted);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
