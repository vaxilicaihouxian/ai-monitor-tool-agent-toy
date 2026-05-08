#!/usr/bin/env node
/**
 * CLI entry point
 *
 * Parses command-line arguments and routes to the appropriate execution mode:
 * - alarm-drill / alarm-analyze-* subcommands use non-interactive CLI output
 * - Other commands start the Ink REPL interactive mode (Welcome banner then Shell)
 */
import { render } from "ink";
import { parseCliArgs } from "./commands.js";
import { loadConfig } from "./config.js";
import Welcome from "./components/Welcome.js";
import Shell from "./ui/Shell.js";
import { createPluginManager } from "./plugins/index.js";
import { runAlarmDrillCli } from "./cli/alarmDrill.js";
import { runAlarmAnalyzeEventOnlineCli } from "./cli/alarmAnalyzeEventOnline.js";
import { runAlarmAnalyzeFileCli } from "./cli/alarmAnalyzeFile.js";
import { runAlarmAnalyzeEventOnlineAgentCli } from "./cli/alarmAnalyzeEventOnlineAgent.js";
import { runAlarmAnalyzeFileAgentCli } from "./cli/alarmAnalyzeFileAgent.js";

const { configPath, initial } = parseCliArgs();

// Subcommands use non-interactive CLI output, no REPL
if (initial?.command === "alarm-drill") {
  runAlarmDrillCli(configPath, initial.eventId!).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (initial?.command === "alarm-analyze-event-online") {
  runAlarmAnalyzeEventOnlineCli(configPath, initial.eventId!).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (initial?.command === "alarm-analyze-file") {
  runAlarmAnalyzeFileCli(configPath, initial.filePath!).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (initial?.command === "alarm-analyze-event-online-agent") {
  runAlarmAnalyzeEventOnlineAgentCli(configPath, initial.eventId!, initial.llmInputFile).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else if (initial?.command === "alarm-analyze-file-agent") {
  runAlarmAnalyzeFileAgentCli(configPath, initial.filePath!, initial.llmInputFile).catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
} else {
  // Ink REPL mode: render Welcome banner first, then start Shell
  (async () => {
    const config = loadConfig(configPath);
    const manager = await createPluginManager(config);
    const { waitUntilExit } = render(<Welcome config={config} manager={manager} />);
    await waitUntilExit();
    process.env.HMC_QUIET = "1";
    const { unmount } = render(<Shell configPath={configPath} initial={initial} />);
    process.on("SIGINT", () => {
      unmount();
      process.exit(0);
    });
  })();
}
