/**
 * Command capability declarations and dynamic availability
 *
 * Defines each command's dependencies on data source capabilities (required/optional),
 * and dynamically determines command visibility at runtime based on registered and available Plugins.
 */

import type { DataSourceKind } from "./datasources/types.js";
import type { PluginManager } from "./plugins/plugin-manager.js";

/** Capability requirement: if required is missing the command is unavailable; if optional is missing the command degrades */
export interface CapabilityRequirement {
  kind: DataSourceKind;
  required: boolean;
  /** Hint message shown on degradation */
  degradeMessage?: string;
}

/** Command capability declaration */
export interface CommandCapability {
  command: string;
  capabilities: CapabilityRequirement[];
  otherDeps?: string[];
}

/** Capability declarations for all commands */
export const COMMAND_CAPABILITIES: CommandCapability[] = [
  {
    command: "/log",
    capabilities: [{ kind: "log", required: true }],
  },
  {
    command: "/trace",
    capabilities: [
      { kind: "trace", required: true },
      { kind: "log", required: false, degradeMessage: "No log data source configured, associated logs hidden" },
    ],
  },
  {
    command: "/query-metrics",
    capabilities: [{ kind: "metrics", required: true }],
  },
  {
    command: "/alert",
    capabilities: [{ kind: "alarm-event", required: true }],
    otherDeps: ["OMC_DEBUG=1"],
  },
  {
    command: "/alarm-drill",
    capabilities: [
      { kind: "alarm-event", required: true },
      { kind: "log", required: true },
      { kind: "trace", required: false, degradeMessage: "No trace data source configured, associated traces hidden" },
      { kind: "metrics", required: false, degradeMessage: "No metrics data source configured, metrics data hidden" },
    ],
    otherDeps: ["extractorModel"],
  },
  {
    command: "/alarm-analyze-event-online",
    capabilities: [
      { kind: "alarm-event", required: true },
      { kind: "log", required: true },
      { kind: "trace", required: false, degradeMessage: "No trace data source configured, skipping trace collection" },
      { kind: "metrics", required: false, degradeMessage: "No metrics data source configured, skipping metrics collection" },
    ],
    otherDeps: ["extractorModel", "analysis"],
  },
  {
    command: "/alarm-analyze-file",
    capabilities: [],
    otherDeps: ["analysis"],
  },
  {
    command: "/alarm-analyze-event-online-agent",
    capabilities: [
      { kind: "alarm-event", required: true },
      { kind: "log", required: true },
      { kind: "trace", required: false, degradeMessage: "No trace data source configured, skipping trace collection" },
      { kind: "metrics", required: false, degradeMessage: "No metrics data source configured, skipping metrics collection" },
    ],
    otherDeps: ["extractorModel", "analysis", "agentModel"],
  },
  {
    command: "/alarm-analyze-file-agent",
    capabilities: [],
    otherDeps: ["agentModel"],
  },
  {
    command: "/memory",
    capabilities: [],
    otherDeps: ["memory.enabled"],
  },
  {
    command: "/export",
    capabilities: [],
  },
  {
    command: "/help",
    capabilities: [],
  },
  {
    command: "/quit",
    capabilities: [],
  },
];

/** Command availability result */
export interface CommandAvailability {
  command: string;
  available: boolean;
  reason?: string;
  degradations: string[];
}

/**
 * Compute each command's availability based on registered data sources and current config
 *
 * Rules:
 * - All required capabilities have available data sources → command is available
 * - Any required capability has no available data source → command is unavailable, with reason
 * - Optional capability missing → command is available, but degradation hint is recorded
 */
export function resolveCommandAvailabilities(
  manager: PluginManager,
  config: unknown
): CommandAvailability[] {
  return COMMAND_CAPABILITIES.map((cmd) => {
    const degradations: string[] = [];
    let unavailable: string | undefined;

    for (const cap of cmd.capabilities) {
      const hasIt = manager.hasAvailable(cap.kind, config);
      if (!hasIt && cap.required) {
        const registered = manager.getByKind(cap.kind);
        const reasons = registered.map((s) => `${s.id.name}: ${s.checkAvailability(config).reason}`);
        unavailable = reasons.length > 0
          ? `Required capability ${cap.kind} unavailable: ${reasons.join("; ")}`
          : `Required capability ${cap.kind} no data source registered`;
        break;
      }
      if (!hasIt && !cap.required && cap.degradeMessage) {
        degradations.push(cap.degradeMessage);
      }
    }

    return {
      command: cmd.command,
      available: !unavailable,
      reason: unavailable,
      degradations,
    };
  });
}

/**
 * Quickly check whether a single command is available
 */
export function isCommandAvailable(
  manager: PluginManager,
  config: unknown,
  command: string
): boolean {
  return resolveCommandAvailabilities(manager, config)
    .find((c) => c.command === command)?.available ?? false;
}

/**
 * Get degradation hints for a command
 */
export function getCommandDegradations(
  manager: PluginManager,
  config: unknown,
  command: string
): string[] {
  return resolveCommandAvailabilities(manager, config)
    .find((c) => c.command === command)?.degradations ?? [];
}
