/**
 * Welcome - Startup welcome page component
 *
 * Displays ASCII Logo, version number, command quick reference, and data source status.
 * As a transient component, it auto-exits 50ms after rendering, handing over to the Shell.
 */
import { Box, Text, useApp } from "ink";
import { useEffect } from "react";
import { welcome } from "../static/welcome_ascii.js";
import { VERSION } from "../version.js";
import type { Config } from "../config.js";
import type { PluginManager } from "../plugins/index.js";
import type { DataSourceKind } from "../datasources/types.js";
import { resolveCommandAvailabilities } from "../commands-capability.js";

const COMMANDS = [
  { tag: "Alarm", cmd: "/alarm-drill <id>", desc: "Event drill-down" },
  { tag: "Alarm", cmd: "/alarm-analyze-event-online", desc: "Intelligent analysis" },
  { tag: "Alarm", cmd: "/alarm-analyze-file <path>", desc: "File analysis" },
  { tag: "Agent", cmd: "/alarm-analyze-event-online-agent", desc: "Agent online analysis" },
  { tag: "Agent", cmd: "/alarm-analyze-file-agent", desc: "Agent file analysis" },
  { tag: "Query", cmd: "/log [-s] [-L] [-a]", desc: "Log query" },
  { tag: "Query", cmd: "/trace <id> [-v]", desc: "Trace query" },
  { tag: "Query", cmd: "/query-metrics <PromQL>", desc: "Metrics query" },
  { tag: "Tool", cmd: "/export [dir]", desc: "Export results" },
  { tag: "Tool", cmd: "/help", desc: "Help" },
  { tag: "Tool", cmd: "/quit  /exit", desc: "Exit" },
];

/** Welcome page component: auto-exits after rendering, used for startup transient display */
export default function Welcome({ config, manager }: { config: Config; manager: PluginManager }) {
  const { exit } = useApp();
  useEffect(() => {
    const t = setTimeout(() => exit(), 50);
    return () => clearTimeout(t);
  }, [exit]);

  const ver = VERSION;

  // Data source status (based on PluginManager)
  const dsKinds: DataSourceKind[] = ["log", "trace", "metrics", "alarm-event"];
  const dsLabels: Record<DataSourceKind, string> = {
    log: "Logs",
    trace: "Traces",
    metrics: "Metrics",
    "alarm-event": "Alarm events",
  };

  // Command availability
  const commandAvailabilities = resolveCommandAvailabilities(manager, config);
  const availableCommands = commandAvailabilities.filter((c) => c.available).map((c) => c.command);

  const agentLine = config.agentModel?.model || "—";
  const analysisOk = !!config.analysis;

  return (
    <Box borderStyle="round" borderColor="cyan" padding={1} flexDirection="row">
      <Box flexDirection="column" width="33%" justifyContent="center" alignItems="center">
        <Box flexDirection="column">
          {welcome.split("\n").filter((_, i, arr) => i > 0 && i < arr.length - 1).map((line, i) => (
            <Text key={i} color="cyan">{line}</Text>
          ))}
          <Text color="cyan">   Observability Ready</Text>
          <Text color="cyan">   omc v{ver}</Text>
        </Box>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>│</Text>
      </Box>
      <Box flexDirection="column" width="67%">
        <Text bold>Commands</Text>
        {COMMANDS.map(({ tag, cmd, desc }) => {
          const cmdId = cmd.split(" ")[0];
          const isAvailable = availableCommands.includes(cmdId);
          return (
            <Text key={cmd} color={isAvailable ? undefined : "gray"}>
              <Text dimColor>[{tag}]</Text>  {cmd.padEnd(35)}  {desc}{!isAvailable ? " (unavailable)" : ""}
            </Text>
          );
        })}
        <Text> </Text>
        <Text bold>Data Sources</Text>
        {dsKinds.map((kind) => {
          const ds = manager.hasAvailable(kind, config);
          const sources = manager.getByKind(kind);
          const label = dsLabels[kind];
          if (ds) {
            return <Text key={kind}>{label.padEnd(9)} <Text color="green">✓</Text> <Text dimColor>{ds.id.name}</Text></Text>;
          } else if (sources.length > 0) {
            const reasons = sources.map((s) => s.checkAvailability(config).reason).filter(Boolean);
            return <Text key={kind}>{label.padEnd(9)} <Text color="yellow">✗</Text> <Text dimColor>{reasons.join("; ")}</Text></Text>;
          } else {
            return <Text key={kind}>{label.padEnd(9)} <Text dimColor>✗ Not registered</Text></Text>;
          }
        })}
        <Text>agent:    <Text dimColor>{agentLine}</Text></Text>
        <Text>analysis: {analysisOk ? <Text color="green">✓</Text> : <Text dimColor>—</Text>}</Text>
      </Box>
    </Box>
  );
}
