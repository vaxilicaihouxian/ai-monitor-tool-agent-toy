/**
 * Prometheus metrics datasource implementation
 */

import type { DataSourceAvailability } from "../types.js";
import type { MetricsDataSource, MetricsQueryParams, MetricsQueryResult } from "../metrics.js";
import type { Config, MetricsPrometheusConfig } from "../../config.js";
import { getPluginConfig } from "../../config.js";
import { queryAlarmMetrics, formatMetricsResults } from "../../promClient.js";

export class PrometheusMetricsDataSource implements MetricsDataSource {
  readonly id = { kind: "metrics" as const, name: "prometheus" };

  checkAvailability(config: unknown): DataSourceAvailability {
    const c = config as Config;
    const conf = getPluginConfig<MetricsPrometheusConfig>(c, "metrics-prometheus");
    if (!conf?.remoteReadUrl) return { available: false, reason: "pluginsConfig.metrics-prometheus not configured (requires remoteReadUrl and clusters/namespace)" };
    return { available: true };
  }

  async query(config: unknown, params: MetricsQueryParams): Promise<MetricsQueryResult> {
    const c = config as Config;
    const conf = getPluginConfig<MetricsPrometheusConfig>(c, "metrics-prometheus")!;
    const baseUrl = conf.remoteReadUrl!;
    const promConfig = {
      clusters: conf.clusters,
      namespace: conf.namespace,
      rateInterval: conf.rateInterval,
      step: conf.step,
      timeRangeMinutes: conf.timeRangeMinutes,
      metricTemplates: conf.metricTemplates,
    };
    const results = await queryAlarmMetrics(promConfig, baseUrl, params);
    const formatted = formatMetricsResults(results, params.startTime);
    return { results, formatted };
  }
}
