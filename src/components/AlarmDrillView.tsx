/**
 * AlarmDrillView - Alarm event drill-down view component
 *
 * Displays alarm event drill-down results, including metrics overview and
 * detailed information for multiple Traces (call chain + associated logs).
 * Supports keyboard scrolling.
 */
import { useState, useMemo, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { type LogEntry, findField } from "../query.js";
import { formatTraceTree, type JaegerSpan, type TraceStats } from "../traceAnalyzer.js";
import { type DrillTraceGroup } from "../types.js";
export type { DrillTraceGroup } from "../types.js";
import { Header } from "./Header.js";
import { Footer } from "./Footer.js";

/** AlarmDrillView props */
interface AlarmDrillViewProps {
  /** Drill-down query Trace result groups */
  traces: DrillTraceGroup[];
  /** LLM-extracted query condition description text */
  extractedInfo: string;
  /** Query info, e.g. event ID, data source */
  queryInfo: string;
  /** Optional metrics overview text */
  metricsText?: string;
  /** Back callback */
  onBack: () => void;
}

/** Format a single log entry, showing full details */
function formatLog(log: LogEntry): string[] {
  const ts = findField(log, "@timestamp") || findField(log, "timestamp") || findField(log, "ts") || "";
  const level = findField(log, "level") || findField(log, "severity") || "";
  const msg = findField(log, "message") || findField(log, "msg") || findField(log, "body") || "";
  const shortTs = ts.replace(/\.\d+Z$/, "Z").replace("T", " ");
  const levelStr = String(level).toUpperCase() || "INFO";
  const header = `[${shortTs}] [${levelStr}]`;
  const lines: string[] = [];
  if (msg) {
    lines.push(`${header} ${msg}`);
  } else {
    lines.push(header);
  }
  lines.push(JSON.stringify(log, null, 2));
  return lines;
}

/** Build all display lines */
function buildDisplayLines(traces: DrillTraceGroup[], metricsText?: string): string[] {
  const lines: string[] = [];

  // Metrics section
  if (metricsText) {
    lines.push("═".repeat(70));
    lines.push("Metrics overview");
    lines.push("═".repeat(70));
    lines.push(...metricsText.split("\n"));
    lines.push("");
  }

  for (let i = 0; i < traces.length; i++) {
    const { traceId, spans, stats, logs } = traces[i];

    if (i > 0) lines.push("");
    lines.push("═".repeat(70));
    lines.push(`[${i + 1}/${traces.length}] TraceId: ${traceId}`);
    lines.push("═".repeat(70));

    if (stats) {
      const statsLine = `  Spans: ${stats.spanCount}  Duration: ${stats.totalDurationMs}ms  Errors: ${stats.errorCount}  Services: ${stats.services.join(", ")}`;
      lines.push(statsLine);
      if (stats.rootOperation) lines.push(`  Root call: ${stats.rootOperation}`);
    } else {
      lines.push("  (No trace data)");
    }

    if (spans.length > 0) {
      lines.push("");
      lines.push("── Call chain ──");
      const treeText = formatTraceTree(spans);
      lines.push(...treeText.split("\n").filter((l) => l.length > 0));
    }

    if (logs.length > 0) {
      lines.push("");
      lines.push(`── Associated logs (${logs.length} entries) ──`);
      for (const log of logs) {
        lines.push(...formatLog(log));
      }
    }
  }

  return lines;
}

export function AlarmDrillView({ traces, extractedInfo, queryInfo, metricsText, onBack }: AlarmDrillViewProps) {
  const { exit } = useApp();
  const [scrollOffset, setScrollOffset] = useState(0);

  const allLines = useMemo(() => buildDisplayLines(traces, metricsText), [traces, metricsText]);

  const terminalHeight = process.stdout.rows || 40;
  const headerLines = 4;
  const footerLines = 3;
  const availableHeight = Math.max(5, terminalHeight - headerLines - footerLines);

  const maxScroll = Math.max(0, allLines.length - availableHeight);
  const safeOffset = Math.min(Math.max(0, scrollOffset), maxScroll);

  const stateRef = useRef({ maxScroll, safeOffset });
  stateRef.current = { maxScroll, safeOffset };

  useInput((input, key) => {
    const s = stateRef.current;

    if (input === "q" || key.escape) {
      onBack();
      return;
    }

    if (key.upArrow || input === "k") {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      return;
    }
    if (key.downArrow || input === "j") {
      setScrollOffset((prev) => Math.min(s.maxScroll, prev + 1));
      return;
    }

    if (key.ctrl && input === "e") {
      setScrollOffset((prev) => Math.min(s.maxScroll, prev + 1));
      return;
    }
    if (key.ctrl && input === "y") {
      setScrollOffset((prev) => Math.max(0, prev - 1));
      return;
    }

    if (input === "g" && !key.ctrl) {
      setScrollOffset(0);
      return;
    }
    if (input === "G" || (input === "g" && key.shift)) {
      setScrollOffset(s.maxScroll);
      return;
    }
  });

  const visibleLines = allLines.slice(safeOffset, safeOffset + availableHeight);
  const headerQueryInfo = `${queryInfo} | ${allLines.length} lines`;
  const footerHints = "↑↓/jk/Ctrl+e/y Scroll g/G top/bottom q back";

  return (
    <Box flexDirection="column" padding={0}>
      <Header title="Alarm Drill" queryInfo={headerQueryInfo} />

      {extractedInfo && (
        <Box paddingX={1}>
          <Text dimColor>Extracted conditions: {extractedInfo}</Text>
        </Box>
      )}

      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {visibleLines.map((line, i) => {
          // Simple color handling
          if (line.startsWith("═")) {
            return <Text key={i} color="cyan">{line}</Text>;
          }
          if (line.startsWith("──")) {
            return <Text key={i} color="cyan" bold>{line}</Text>;
          }
          if (line.startsWith("[") && line.includes("TraceId:")) {
            return <Text key={i} bold color="yellow">{line}</Text>;
          }
          if (line.includes("✕") || line.includes("❌")) {
            return <Text key={i} color="red">{line}</Text>;
          }
          if (line.startsWith("  Spans:") || line.startsWith("  Root call:")) {
            return <Text key={i} color="gray">{line}</Text>;
          }
          return <Text key={i}>{line}</Text>;
        })}
      </Box>

      <Footer searchMode={false} searchQuery="" hints={footerHints} />
    </Box>
  );
}
