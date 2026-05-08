/**
 * Metrics datasource interface
 */

import type { DataSource, DataSourceId } from "./types.js";
import type { MetricQueryResult } from "../promClient.js";

/** Metrics query parameters */
export interface MetricsQueryParams {
  appname: string;
  podname?: string;
  startTime: number;
  endTime: number;
  apiPath?: string;
  servicer?: string[];
  downstreamApi?: string[];
}

/** Metrics query result */
export interface MetricsQueryResult {
  results: MetricQueryResult[];
  formatted: string;
}

/** Metrics datasource interface */
export interface MetricsDataSource extends DataSource<unknown, MetricsQueryParams, MetricsQueryResult> {
  readonly id: DataSourceId & { kind: "metrics" };
}
