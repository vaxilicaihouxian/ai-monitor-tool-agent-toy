/**
 * Datasource abstraction layer — base type definitions
 *
 * All datasource implementations must implement the DataSource interface,
 * the main framework queries available datasources via DataSourceKind, without depending on specific implementations.
 */

/** Datasource capability type */
export type DataSourceKind = "log" | "trace" | "metrics" | "alarm-event";

/** Datasource instance identifier */
export interface DataSourceId {
  kind: DataSourceKind;
  name: string;
}

/** Datasource availability check result */
export interface DataSourceAvailability {
  available: boolean;
  reason?: string;
}

/** Datasource base interface — all datasources must implement */
export interface DataSource<TConfig = unknown, TQueryParams = unknown, TResult = unknown> {
  readonly id: DataSourceId;

  /**
   * Check if this datasource is available under current configuration
   * Checked before command routing and Agent tool calls; provides clear feedback when unavailable
   */
  checkAvailability(config: TConfig): DataSourceAvailability;

  /**
   * Execute query
   * @param config Datasource configuration
   * @param params Query parameters (unified format, DataSource implementation is responsible for converting to underlying parameters)
   */
  query(config: TConfig, params: TQueryParams): Promise<TResult>;
}
