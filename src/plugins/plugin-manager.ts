/**
 * Plugin manager
 *
 * Manages registration, discovery, and availability queries for all data source plugins.
 * Exposes the same query interface as DataSource, so callers need not be aware of plugin boundaries.
 */

import type { DataSource, DataSourceKind } from "../datasources/types.js";
import type { Plugin, PluginRegistration } from "./types.js";
import { debug } from "../utils/logger.js";

export class PluginManager {
  private plugins = new Map<string, PluginRegistration>();
  private sourceIndex = new Map<string, DataSource>(); // kind:name → DataSource
  private preferences = new Map<DataSourceKind, string>(); // kind → preferred name

  /** Register a plugin */
  registerPlugin(plugin: Plugin, builtin: boolean = false): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" already registered`);
    }
    this.plugins.set(plugin.name, { plugin, builtin });
    for (const ds of plugin.dataSources) {
      const key = `${ds.id.kind}:${ds.id.name}`;
      this.sourceIndex.set(key, ds);
    }
  }

  /** Unregister a plugin */
  unregisterPlugin(name: string): void {
    const reg = this.plugins.get(name);
    if (!reg) return;
    for (const ds of reg.plugin.dataSources) {
      this.sourceIndex.delete(`${ds.id.kind}:${ds.id.name}`);
    }
    this.plugins.delete(name);
  }

  /** Set the preferred data source name for a given capability type */
  setPreference(kind: DataSourceKind, name: string): void {
    this.preferences.set(kind, name);
  }

  /** Get all registered data sources for a given capability type */
  getByKind(kind: DataSourceKind): DataSource[] {
    return [...this.sourceIndex.values()].filter((s) => s.id.kind === kind);
  }

  /** Get a data source by capability type and name */
  get(kind: DataSourceKind, name: string): DataSource | undefined {
    return this.sourceIndex.get(`${kind}:${name}`);
  }

  /** Check if there is an available data source for the given capability type (strictly matches preference; if preference is unavailable, no fallback) */
  hasAvailable(kind: DataSourceKind, config: unknown): DataSource | undefined {
    const preferredName = this.preferences.get(kind);
    if (preferredName) {
      const preferred = this.get(kind, preferredName);
      if (preferred?.checkAvailability(config).available) {
        return preferred;
      }
      return undefined;
    }
    // When no preference, take the first available by registration order
    for (const source of this.getByKind(kind)) {
      if (source.checkAvailability(config).available) {
        return source;
      }
    }
    return undefined;
  }

  /** Get all available data sources for a given capability type */
  getAvailableByKind(kind: DataSourceKind, config: unknown): DataSource[] {
    return this.getByKind(kind).filter((s) => s.checkAvailability(config).available);
  }

  /** Get information about all registered plugins */
  listPlugins(): PluginRegistration[] {
    return [...this.plugins.values()];
  }

  /** Get unavailable data sources and reasons for a given capability type */
  getUnavailable(kind: DataSourceKind, config: unknown): Array<{ name: string; reason: string }> {
    return this.getByKind(kind)
      .filter((s) => !s.checkAvailability(config).available)
      .map((s) => ({
        name: s.id.name,
        reason: s.checkAvailability(config).reason || "unknown reason",
      }));
  }

  /**
   * Dynamically load and register plugins
   *
   * Expected module export format:
   * - `export const plugin: Plugin` or
   * - `export function register(manager: PluginManager): void`
   *
   * @param spec npm package name or local path
   */
  async loadAndRegisterPlugin(spec: string): Promise<void> {
    try {
      const mod = await import(spec);
      const plugin = mod.plugin ?? mod.default;
      if (plugin && plugin.name && plugin.dataSources) {
        this.registerPlugin(plugin, false);
        debug(`[plugin] Dynamically loaded plugin: ${plugin.name} (from ${spec})\n`);
      } else if (typeof mod.register === "function") {
        mod.register(this);
        debug(`[plugin] Dynamically loaded plugin (register mode): ${spec}\n`);
      } else {
        debug(`[plugin] Failed to dynamically load plugin: ${spec} — no plugin export or register function found\n`);
      }
    } catch (err) {
      debug(`[plugin] Failed to dynamically load plugin: ${spec} — ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
}
