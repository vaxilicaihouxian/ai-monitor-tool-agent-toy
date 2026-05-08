/**
 * Plugin interface definitions
 *
 * Plugin is the registration unit for data source implementations. A single Plugin can provide one or more DataSources.
 * Built-in Plugins are loaded automatically at startup; third-party Plugins are registered dynamically via PluginManager.registerPlugin().
 */

import type { DataSource } from "../datasources/types.js";

/** Plugin interface — all plugins must implement this */
export interface Plugin {
  /** Plugin name, globally unique */
  readonly name: string;
  /** List of data sources provided by the plugin */
  readonly dataSources: DataSource[];
}

/** Plugin registration info */
export interface PluginRegistration {
  plugin: Plugin;
  /** Whether this is a built-in plugin */
  builtin: boolean;
}
