/**
 * Trace datasource interface
 *
 * Defines unified trace query parameters and result format.
 */

import type { DataSource, DataSourceId } from "./types.js";
import type { JaegerSpan, TraceStats } from "../traceAnalyzer.js";
import type { LogEntry } from "../query.js";

/** Trace query parameters */
export interface TraceQueryParams {
  traceId: string;
  /** Whether to query associated logs */
  includeLogs?: boolean;
  /** Associated log entry limit */
  logLimit?: number;
}

/** Trace query result */
export interface TraceQueryResult {
  spans: JaegerSpan[];
  stats: TraceStats | null;
  logs: LogEntry[];
  logSource?: string;
}

/** Trace datasource interface */
export interface TraceDataSource extends DataSource<unknown, TraceQueryParams, TraceQueryResult> {
  readonly id: DataSourceId & { kind: "trace" };
}
