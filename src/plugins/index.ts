/**
 * Plugin management entry point
 *
 * Registers all built-in + fake plugins, sets data source preferences via config.dataSources.
 * Supports dynamic loading of third-party plugins from config.plugins.
 */

import type { DataSourceKind } from "../datasources/types.js";
import { PluginManager } from "./plugin-manager.js";

// Built-in plugins
import { logElasticsearchPlugin } from "./builtin/log-elasticsearch-plugin.js";
import { traceElasticsearchPlugin } from "./builtin/trace-elasticsearch-plugin.js";
import { metricsPrometheusPlugin } from "./builtin/metrics-prometheus-plugin.js";

// Fake plugins
import { fakeLogPlugin } from "./builtin/fake-log-plugin.js";
import { fakeTracePlugin } from "./builtin/fake-trace-plugin.js";
import { fakeMetricsPlugin } from "./builtin/fake-metrics-plugin.js";
import { fakeAlarmEventPlugin } from "./builtin/fake-alarm-event-plugin.js";

import type { Config } from "../config.js";

/** All built-in plugins — all registered, actual usage selected via dataSources preference */
const ALL_PLUGINS = [
  // Built-in
  logElasticsearchPlugin,
  traceElasticsearchPlugin,
  metricsPrometheusPlugin,
  // Fake (for debugging)
  fakeLogPlugin,
  fakeTracePlugin,
  fakeMetricsPlugin,
  fakeAlarmEventPlugin,
];

/** Synchronously create PluginManager (only register built-in plugins, do not load dynamic plugins) */
export function syncCreatePluginManager(config?: Config): PluginManager {
  const manager = new PluginManager();

  // Register built-in plugins
  for (const plugin of ALL_PLUGINS) {
    manager.registerPlugin(plugin, true);
  }

  // Set preferences based on config.dataSources
  if (config?.dataSources) {
    for (const [kind, name] of Object.entries(config.dataSources)) {
      if (kind && name) {
        manager.setPreference(kind as DataSourceKind, name);
      }
    }
  }

  return manager;
}

/** Create PluginManager and register all plugins, set preferences based on config.dataSources, dynamically load third-party plugins */
export async function createPluginManager(config?: Config): Promise<PluginManager> {
  const manager = syncCreatePluginManager(config);

  // Dynamically load third-party plugins
  if (config?.plugins && config.plugins.length > 0) {
    for (const spec of config.plugins) {
      await manager.loadAndRegisterPlugin(spec);
    }
  }

  return manager;
}

export { PluginManager } from "./plugin-manager.js";
