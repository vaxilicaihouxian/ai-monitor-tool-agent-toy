/**
 * Log datasource interface
 *
 * Defines unified log query parameters and result format,
 * independent of the underlying datasource (ES / Loki etc.).
 */

import type { DataSource, DataSourceId } from "./types.js";
import type { LogEntry } from "../query.js";

/** Log query parameters — unified format, independent of underlying datasource */
export interface LogQueryParams {
  appname?: string;
  search?: string;
  level?: string;
  traceId?: string;
  startTime?: string;
  endTime?: string;
  limit?: number;
  /** Dynamic filter conditions, key is field name, value is match value */
  extraTerms?: Record<string, string>;
}

/** Log query result — unified format */
export interface LogQueryResult {
  entries: LogEntry[];
  /** Name of the datasource actually used */
  source: string;
}

/** Log datasource interface */
export interface LogDataSource extends DataSource<unknown, LogQueryParams, LogQueryResult> {
  readonly id: DataSourceId & { kind: "log" };
}
