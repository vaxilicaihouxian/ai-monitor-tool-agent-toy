/**
 * Alarm event datasource interface
 */

import type { DataSource, DataSourceId } from "./types.js";

/** Generic alarm event raw data type */
export type AlarmEventRaw = Record<string, unknown>;

/** Alarm event query parameters */
export interface AlarmEventQueryParams {
  eventId: string;
}

/** Alarm event query result */
export interface AlarmEventQueryResult {
  eventId: string;
  raw: AlarmEventRaw;
  /** Extracted key field summary */
  summary: Record<string, unknown>;
}

/** Alarm event datasource interface */
export interface AlarmEventDataSource extends DataSource<unknown, AlarmEventQueryParams, AlarmEventQueryResult> {
  readonly id: DataSourceId & { kind: "alarm-event" };
}
