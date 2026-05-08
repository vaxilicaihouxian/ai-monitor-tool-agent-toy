/**
 * Command parsing module
 *
 * Handles parsing of REPL commands and CLI arguments. Supports tokenization
 * and parameter extraction for all interactive commands such as /trace, /log,
 * /alarm-drill, /query-metrics, etc., as well as conversion between
 * InitialCommand and REPL command strings.
 */
import { type QueryOptions, ES_LOG_LEVELS } from "./query.js";
import type { ViewType } from "./traceAnalyzer.js";

/** Whether the alert command is available (requires OMC_DEBUG=1) */
const ALERT_ENABLED = !!process.env.OMC_DEBUG;

export interface ParsedCommand {
  command: "trace" | "log" | "alert" | "alarm-drill" | "alarm-analyze-event-online" | "alarm-analyze-file" | "alarm-analyze-event-online-agent" | "alarm-analyze-file-agent" | "query-metrics" | "help" | "quit" | "export" | "memory";
  traceId?: string;
  eventId?: string;
  filePath?: string;
  viewType?: ViewType;
  logOptions: QueryOptions;
  exportDir?: string;
  metricsQuery?: string;
  metricsStart?: string;
  metricsEnd?: string;
  metricsStep?: string;
  metricsLookback?: string;
  llmInputFile?: string;
  memorySubcommand?: "add" | "show" | "clean" | "backup";
  memoryType?: "preference" | "alarm_case";
  memoryTitle?: string;
  memoryContent?: string;
  memoryTags?: string[];
  memoryAppname?: string;
  memoryBackupSuffix?: string;
}

/**
 * Parse REPL command input, format: /command arg1 arg2 --flag value
 * Supported commands:
 *   /alarm-drill <eventId>                               Alarm event analysis
 *   /trace <traceId> [-v tree|timeline|simple] [-l <n>]
 *   /log [-s <search>] [-L <level>] [-l <n>] [-a <appname>] [--trace-id <id>]
 *   /alert <eventId>                                     (requires OMC_DEBUG=1)
 *   /help
 *   /quit | /exit
 */
export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const tokens = tokenize(trimmed.slice(1)); // Remove leading /
  if (tokens.length === 0) return null;

  const cmd = tokens[0].toLowerCase();

  if (cmd === "quit" || cmd === "exit") {
    return { command: "quit", logOptions: {} };
  }

  if (cmd === "help") {
    return { command: "help", logOptions: {} };
  }

  if (cmd === "trace") {
    const traceId = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    const options: QueryOptions = {};
    let viewType: ViewType | undefined;

    const startIdx = traceId ? 2 : 1;
    for (let i = startIdx; i < tokens.length; i++) {
      switch (tokens[i]) {
        case "-v":
        case "--view":
          viewType = tokens[++i] as ViewType;
          break;
        case "-l":
        case "--limit":
          options.limit = parseInt(tokens[++i], 10);
          break;
      }
    }

    return { command: "trace", traceId, viewType, logOptions: options };
  }

  if (ALERT_ENABLED && cmd === "alert") {
    const eventId = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    return { command: "alert", eventId, logOptions: {} };
  }

  if (cmd === "alarm-drill") {
    const eventId = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    return { command: "alarm-drill", eventId, logOptions: {} };
  }

  if (cmd === "alarm-analyze-event-online") {
    const eventId = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    return { command: "alarm-analyze-event-online", eventId, logOptions: {} };
  }

  if (cmd === "alarm-analyze-file") {
    const filePath = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    return { command: "alarm-analyze-file", filePath, logOptions: {} };
  }

  if (cmd === "alarm-analyze-event-online-agent") {
    const eventId = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    let llmInputFile: string | undefined;
    for (let i = eventId ? 2 : 1; i < tokens.length; i++) {
      if (tokens[i] === "--llm-input-file") {
        llmInputFile = tokens[++i];
      }
    }
    return { command: "alarm-analyze-event-online-agent", eventId, llmInputFile, logOptions: {} };
  }

  if (cmd === "alarm-analyze-file-agent") {
    const filePath = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    let llmInputFile: string | undefined;
    for (let i = filePath ? 2 : 1; i < tokens.length; i++) {
      if (tokens[i] === "--llm-input-file") {
        llmInputFile = tokens[++i];
      }
    }
    return { command: "alarm-analyze-file-agent", filePath, llmInputFile, logOptions: {} };
  }

  if (cmd === "export") {
    const exportDir = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : undefined;
    return { command: "export", exportDir, logOptions: {} };
  }

  if (cmd === "memory") {
    const subcommand = tokens[1] as "add" | "show" | "clean" | "backup" | undefined;
    if (!subcommand || !["add", "show", "clean", "backup"].includes(subcommand)) {
      return { command: "memory", memorySubcommand: "show", logOptions: {} };
    }

    if (subcommand === "add") {
      const memoryType = tokens[2] as "preference" | "alarm_case" | undefined;
      // title may be in quotes, concatenate from token[3] onwards
      let memoryTitle: string | undefined;
      let i = 3;
      if (tokens[i]) {
        // Collect title tokens (may be wrapped in quotes)
        const titleParts: string[] = [];
        while (i < tokens.length && !tokens[i].startsWith("--")) {
          titleParts.push(tokens[i]);
          i++;
        }
        memoryTitle = titleParts.join(" ");
      }

      let memoryContent: string | undefined;
      let memoryTags: string[] | undefined;
      let memoryAppname: string | undefined;

      for (; i < tokens.length; i++) {
        if (tokens[i] === "--content") {
          // Merge all non-flag content after --content
          const contentParts: string[] = [];
          i++;
          while (i < tokens.length && !tokens[i].startsWith("--")) {
            contentParts.push(tokens[i]);
            i++;
          }
          memoryContent = contentParts.join(" ");
          i--; // for loop will i++
        } else if (tokens[i] === "--tags") {
          memoryTags = tokens[++i]?.split(",").map((t) => t.trim()).filter(Boolean);
        } else if (tokens[i] === "--appname") {
          memoryAppname = tokens[++i];
        }
      }

      return {
        command: "memory",
        memorySubcommand: "add",
        memoryType,
        memoryTitle,
        memoryContent,
        memoryTags,
        memoryAppname,
        logOptions: {},
      };
    }

    if (subcommand === "backup") {
      const memoryBackupSuffix = tokens[2] && !tokens[2].startsWith("-") ? tokens[2] : undefined;
      return { command: "memory", memorySubcommand: "backup", memoryBackupSuffix, logOptions: {} };
    }

    // show / clean
    return { command: "memory", memorySubcommand: subcommand, logOptions: {} };
  }

  if (cmd === "query-metrics") {
    // PromQL may contain quotes (e.g. app_name=~"myapp"), so tokenize cannot be used,
    // otherwise quotes would be stripped causing PromQL syntax errors. Extract from raw input.
    const rawAfterCmd = trimmed.slice(trimmed.toLowerCase().indexOf("query-metrics") + "query-metrics".length).trim();

    // Extract --flag value from the tail, the remaining part is PromQL
    const flagNames = ["start", "end", "step", "lookback"];
    const flags: Record<string, string> = {};
    let remaining = rawAfterCmd;

    for (const flag of flagNames) {
      const re = new RegExp(`--${flag}\\s+(\\S+)`);
      const m = remaining.match(re);
      if (m) {
        flags[flag] = m[1];
        remaining = remaining.replace(m[0], " ");
      }
    }

    // Strip outer single/double quotes (initialToCommandString wraps PromQL in single quotes)
    let metricsQuery = remaining.trim() || undefined;
    if (metricsQuery) {
      const first = metricsQuery[0];
      const last = metricsQuery[metricsQuery.length - 1];
      if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
        metricsQuery = metricsQuery.slice(1, -1);
      }
    }

    return {
      command: "query-metrics",
      metricsQuery,
      metricsStart: flags.start,
      metricsEnd: flags.end,
      metricsStep: flags.step,
      metricsLookback: flags.lookback,
      logOptions: {},
    };
  }

  if (cmd === "log" || cmd === "logs") {
    const options: QueryOptions = {};
    for (let i = 1; i < tokens.length; i++) {
      switch (tokens[i]) {
        case "-l":
        case "--limit":
          options.limit = parseInt(tokens[++i], 10);
          break;
        case "-L":
        case "--level": {
          const val = tokens[++i].toUpperCase();
          if (!ES_LOG_LEVELS.includes(val as any)) {
            throw new Error(`Invalid log level: ${val}, valid values: ${ES_LOG_LEVELS.join(", ")}`);
          }
          options.level = val;
          break;
        }
        case "-s":
        case "--search":
          options.search = tokens[++i];
          break;
        case "--start-time":
          options.startTime = tokens[++i];
          break;
        case "--end-time":
          options.endTime = tokens[++i];
          break;
        case "-q":
        case "--query":
          options.query = tokens[++i];
          break;
        case "--trace-id":
          options.traceId = tokens[++i];
          break;
        case "-a":
        case "--appname":
          options.appname = tokens[++i];
          break;
      }
    }

    return { command: "log", logOptions: options };
  }

  return null;
}

/** Simple tokenizer: supports quoted arguments */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;
  let quoteChar = "";

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inQuotes) {
      if (ch === quoteChar) {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      inQuotes = true;
      quoteChar = ch;
    } else if (ch === " " || ch === "\t") {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }

  if (current) tokens.push(current);
  return tokens;
}

/**
 * Parse CLI arguments (used at process startup)
 * Returns initialCommand for Shell auto-execution
 */
export interface InitialCommand {
  command: "trace" | "log" | "alert" | "alarm-drill" | "alarm-analyze-event-online" | "alarm-analyze-file" | "alarm-analyze-event-online-agent" | "alarm-analyze-file-agent" | "query-metrics";
  traceId?: string;
  eventId?: string;
  filePath?: string;
  viewType?: ViewType;
  logOptions: QueryOptions;
  metricsQuery?: string;
  metricsStart?: string;
  metricsEnd?: string;
  metricsStep?: string;
  metricsLookback?: string;
  llmInputFile?: string;
}

export function parseCliArgs(): { configPath?: string; initial?: InitialCommand } {
  const args = process.argv.slice(2);

  let configPath: string | undefined;
  const filteredArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" || args[i] === "--config") {
      configPath = args[++i];
    } else {
      filteredArgs.push(args[i]);
    }
  }

  if (filteredArgs.length === 0) {
    return { configPath };
  }

  // trace subcommand: omc trace <traceId> [options]
  if (filteredArgs[0] === "trace" && filteredArgs[1] && !filteredArgs[1].startsWith("-")) {
    const result: InitialCommand = {
      command: "trace",
      traceId: filteredArgs[1],
      logOptions: {},
    };

    for (let i = 2; i < filteredArgs.length; i++) {
      switch (filteredArgs[i]) {
        case "-v":
        case "--view":
          result.viewType = filteredArgs[++i] as ViewType;
          break;
        case "-l":
        case "--limit":
          result.logOptions.limit = parseInt(filteredArgs[++i], 10);
          break;
      }
    }

    return { configPath, initial: result };
  }

  // alert subcommand: omc alert <eventId> (requires OMC_DEBUG=1)
  if (ALERT_ENABLED && filteredArgs[0] === "alert" && filteredArgs[1] && !filteredArgs[1].startsWith("-")) {
    return { configPath, initial: { command: "alert", eventId: filteredArgs[1], logOptions: {} } };
  }

  // alarm-drill subcommand: omc alarm-drill <eventId>
  if (filteredArgs[0] === "alarm-drill" && filteredArgs[1] && !filteredArgs[1].startsWith("-")) {
    return { configPath, initial: { command: "alarm-drill", eventId: filteredArgs[1], logOptions: {} } };
  }

  // alarm-analyze-event-online subcommand: omc alarm-analyze-event-online <eventId>
  if (filteredArgs[0] === "alarm-analyze-event-online" && filteredArgs[1] && !filteredArgs[1].startsWith("-")) {
    return { configPath, initial: { command: "alarm-analyze-event-online", eventId: filteredArgs[1], logOptions: {} } };
  }

  // alarm-analyze-file subcommand: omc alarm-analyze-file <filePath>
  if (filteredArgs[0] === "alarm-analyze-file" && filteredArgs[1] && !filteredArgs[1].startsWith("-")) {
    return { configPath, initial: { command: "alarm-analyze-file", filePath: filteredArgs[1], logOptions: {} } };
  }

  // alarm-analyze-event-online-agent subcommand: omc alarm-analyze-event-online-agent <eventId> [--llm-input-file <path>]
  if (filteredArgs[0] === "alarm-analyze-event-online-agent" && filteredArgs[1] && !filteredArgs[1].startsWith("-")) {
    let llmInputFile: string | undefined;
    for (let i = 2; i < filteredArgs.length; i++) {
      if (filteredArgs[i] === "--llm-input-file") {
        llmInputFile = filteredArgs[++i];
      }
    }
    return { configPath, initial: { command: "alarm-analyze-event-online-agent", eventId: filteredArgs[1], llmInputFile, logOptions: {} } };
  }

  // alarm-analyze-file-agent subcommand: omc alarm-analyze-file-agent <filePath> [--llm-input-file <path>]
  if (filteredArgs[0] === "alarm-analyze-file-agent" && filteredArgs[1] && !filteredArgs[1].startsWith("-")) {
    let llmInputFile: string | undefined;
    for (let i = 2; i < filteredArgs.length; i++) {
      if (filteredArgs[i] === "--llm-input-file") {
        llmInputFile = filteredArgs[++i];
      }
    }
    return { configPath, initial: { command: "alarm-analyze-file-agent", filePath: filteredArgs[1], llmInputFile, logOptions: {} } };
  }

  // query-metrics subcommand: omc query-metrics <PromQL> [options]
  if (filteredArgs[0] === "query-metrics") {
    const metricsQuery = filteredArgs[1] && !filteredArgs[1].startsWith("-") ? filteredArgs[1] : undefined;
    let metricsStart: string | undefined;
    let metricsEnd: string | undefined;
    let metricsStep: string | undefined;
    let metricsLookback: string | undefined;

    const startIdx = metricsQuery ? 2 : 1;
    for (let i = startIdx; i < filteredArgs.length; i++) {
      switch (filteredArgs[i]) {
        case "--start":
          metricsStart = filteredArgs[++i];
          break;
        case "--end":
          metricsEnd = filteredArgs[++i];
          break;
        case "--step":
          metricsStep = filteredArgs[++i];
          break;
        case "--lookback":
          metricsLookback = filteredArgs[++i];
          break;
      }
    }

    return {
      configPath,
      initial: {
        command: "query-metrics",
        metricsQuery,
        metricsStart,
        metricsEnd,
        metricsStep,
        metricsLookback,
        logOptions: {},
      },
    };
  }

  // log query mode: omc [options]
  const options: QueryOptions = {};
  for (let i = 0; i < filteredArgs.length; i++) {
    switch (filteredArgs[i]) {
      case "-l":
      case "--limit":
        options.limit = parseInt(filteredArgs[++i], 10);
        break;
      case "-L":
      case "--level": {
        const val = filteredArgs[++i].toUpperCase();
        if (!ES_LOG_LEVELS.includes(val as any)) {
          throw new Error(`Invalid log level: ${val}, valid values: ${ES_LOG_LEVELS.join(", ")}`);
        }
        options.level = val;
        break;
      }
      case "-s":
      case "--search":
        options.search = filteredArgs[++i];
        break;
      case "--start-time":
        options.startTime = filteredArgs[++i];
        break;
      case "--end-time":
        options.endTime = filteredArgs[++i];
        break;
      case "-q":
      case "--query":
        options.query = filteredArgs[++i];
        break;
      case "--trace-id":
        options.traceId = filteredArgs[++i];
        break;
      case "-a":
      case "--appname":
        options.appname = filteredArgs[++i];
        break;
    }
  }

  return { configPath, initial: { command: "log", logOptions: options } };
}

/** Convert InitialCommand to REPL command string */
export function initialToCommandString(initial: InitialCommand): string {
  if (initial.command === "trace") {
    let cmd = `/trace ${initial.traceId}`;
    if (initial.viewType) cmd += ` -v ${initial.viewType}`;
    if (initial.logOptions.limit) cmd += ` -l ${initial.logOptions.limit}`;
    return cmd;
  }

  if (initial.command === "alert") {
    return `/alert ${initial.eventId}`;
  }

  if (initial.command === "alarm-drill") {
    return `/alarm-drill ${initial.eventId}`;
  }

  if (initial.command === "alarm-analyze-event-online") {
    return `/alarm-analyze-event-online ${initial.eventId}`;
  }

  if (initial.command === "alarm-analyze-file") {
    let cmd = `/alarm-analyze-file ${initial.filePath}`;
    if (initial.llmInputFile) cmd += ` --llm-input-file ${initial.llmInputFile}`;
    return cmd;
  }

  if (initial.command === "alarm-analyze-event-online-agent") {
    let cmd = `/alarm-analyze-event-online-agent ${initial.eventId}`;
    if (initial.llmInputFile) cmd += ` --llm-input-file ${initial.llmInputFile}`;
    return cmd;
  }

  if (initial.command === "alarm-analyze-file-agent") {
    let cmd = `/alarm-analyze-file-agent ${initial.filePath}`;
    if (initial.llmInputFile) cmd += ` --llm-input-file ${initial.llmInputFile}`;
    return cmd;
  }

  if (initial.command === "query-metrics") {
    // Wrap PromQL in single quotes to prevent tokenizer from stripping internal quotes
    let cmd = `/query-metrics '${initial.metricsQuery || ""}'`;
    if (initial.metricsStart) cmd += ` --start ${initial.metricsStart}`;
    if (initial.metricsEnd) cmd += ` --end ${initial.metricsEnd}`;
    if (initial.metricsStep) cmd += ` --step ${initial.metricsStep}`;
    if (initial.metricsLookback) cmd += ` --lookback ${initial.metricsLookback}`;
    return cmd;
  }

  let cmd = "/log";
  const opts = initial.logOptions;
  if (opts.limit) cmd += ` -l ${opts.limit}`;
  if (opts.level) cmd += ` -L ${opts.level}`;
  if (opts.search) cmd += ` -s ${opts.search}`;
  if (opts.appname) cmd += ` -a ${opts.appname}`;
  if (opts.traceId) cmd += ` --trace-id ${opts.traceId}`;
  if (opts.startTime) cmd += ` --start-time ${opts.startTime}`;
  if (opts.endTime) cmd += ` --end-time ${opts.endTime}`;
  if (opts.query) cmd += ` -q ${opts.query}`;
  return cmd;
}

function buildHelpText(): string {
  const lines = [
    "Available commands:",
    "  /alarm-drill <eventId>                               Alarm event analysis (LLM extracts conditions -> query logs)",
    "  /alarm-analyze-event-online <eventId>                Alarm intelligent analysis (data collection + LLM analysis)",
    "  /alarm-analyze-file <filePath>                       Alarm intelligent analysis (from file)",
    "  /alarm-analyze-event-online-agent <eventId>          Agent deep analysis (online)",
    "          [--llm-input-file <path>]",
    "  /alarm-analyze-file-agent <filePath>                 Agent deep analysis (file)",
    "          [--llm-input-file <path>]",
    "  /trace <traceId> [-v tree|timeline|simple] [-l <n>]  Query distributed traces",
    "  /log [-s <search>] [-L <level>] [-l <n>] [-a <app>]  Query logs",
    "        [--trace-id <id>] [-q <sql>]",
    "  /query-metrics <PromQL> [--start <time>] [--end <time>]  Query Prometheus metrics",
    "               [--step <duration>] [--lookback <duration>]",
  ];

  if (ALERT_ENABLED) {
    lines.splice(1, 0, "  /alert <eventId>                                     Query alarm event details");
  }

  lines.push(
    "  /export [dir]                                        Export command parameters and results to file",
    "  /memory add <type> <title> [--content <text>]        Add memory entry",
    "          [--tags <tags>] [--appname <name>]",
    "  /memory show                                         Show all memories",
    "  /memory clean                                        Clear all memories",
    "  /memory backup [suffix]                              Backup memory file",
    "  /help                                                 Show help",
    "  /quit | /exit                                         Exit program",
    "",
    "Shortcuts:",
    "  q          Return to REPL from log/trace/alarm view",
    "  Ctrl+C     Exit program",
  );

  return lines.join("\n");
}

export const HELP_TEXT = buildHelpText();
