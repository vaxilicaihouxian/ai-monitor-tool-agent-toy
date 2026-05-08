/**
 * Prometheus metrics Plugin
 */

import type { Plugin } from "../types.js";
import { PrometheusMetricsDataSource } from "../../datasources/impl/metrics-prometheus.js";

export const metricsPrometheusPlugin: Plugin = {
  name: "metrics-prometheus",
  dataSources: [new PrometheusMetricsDataSource()],
};
