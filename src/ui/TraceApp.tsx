/**
 * TraceApp - Trace analysis view component
 *
 * Full view for trace analysis, including Trace call tree/timeline/list
 * and associated log list. Supports view switching (v key), search filtering,
 * log selection, and scrolling.
 */
import { useState, useMemo, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import type { JaegerSpan, TraceStats, ViewType } from "../traceAnalyzer.js";
import type { LogEntry } from "../query.js";
import { Header } from "../components/Header.js";
import { Footer } from "../components/Footer.js";
import { Status } from "../components/Status.js";
import { Divider } from "../components/Divider.js";
import { LogItem } from "../components/LogItem.js";
import { TraceView } from "../components/TraceView.js";

/** TraceApp props */
interface TraceAppProps {
  /** List of spans */
  spans: JaegerSpan[];
  /** Trace statistics */
  stats: TraceStats | null;
  /** Associated log list */
  logs: LogEntry[];
  /** Whether data is loading */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Query info description */
  queryInfo: string;
  /** Initial view type */
  viewType: ViewType;
  /** Log source */
  logSource?: string;
  /** Back callback */
  onBack?: () => void;
}

/** TraceApp trace analysis view component */
export default function TraceApp({
  spans,
  stats,
  logs,
  loading,
  error,
  queryInfo,
  viewType: initialViewType,
  logSource,
  onBack,
}: TraceAppProps) {
  const { exit } = useApp();
  const [viewType, setViewType] = useState<ViewType>(initialViewType);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);

  const stateRef = useRef({
    viewType,
    scrollOffset,
    searchMode,
    searchQuery,
    selectedIndex,
  });
  stateRef.current = { viewType, scrollOffset, searchMode, searchQuery, selectedIndex };

  const filteredLogs = useMemo(() => {
    if (!searchQuery) return logs;
    const q = searchQuery.toLowerCase();
    return logs.filter((entry) =>
      JSON.stringify(entry).toLowerCase().includes(q)
    );
  }, [logs, searchQuery]);

  const terminalHeight = process.stdout.rows || 40;
  const headerLines = 4;
  const footerLines = 3;
  const availableHeight = Math.max(10, terminalHeight - headerLines - footerLines);

  // Trace area takes a fixed number of lines, remainder goes to logs
  const traceHeight = spans.length > 0 ? Math.min(spans.length + 2, Math.floor(availableHeight * 0.5)) : 0;
  const logAreaHeight = Math.max(0, availableHeight - traceHeight - (logs.length > 0 ? 1 : 0));
  const visibleCount = Math.max(1, Math.floor(logAreaHeight / 6));

  const maxScrollOffset = Math.max(0, filteredLogs.length - visibleCount);
  const safeScrollOffset = Math.min(Math.max(0, scrollOffset), maxScrollOffset);
  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, filteredLogs.length - 1));

  const visibleLogs = filteredLogs.slice(safeScrollOffset, safeScrollOffset + visibleCount);

  useInput((input, key) => {
    const s = stateRef.current;

    if (s.searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchQuery("");
        setSelectedIndex(0);
        setScrollOffset(0);
      } else if (key.return) {
        setSearchMode(false);
      } else if (key.backspace || key.delete) {
        setSearchQuery((prev) => prev.slice(0, -1));
        setSelectedIndex(0);
        setScrollOffset(0);
      } else if (input.length === 1 && !key.ctrl && !key.meta) {
        setSearchQuery((prev) => prev + input);
        setSelectedIndex(0);
        setScrollOffset(0);
      }
      return;
    }

    if (input === "/") {
      setSearchMode(true);
      setSearchQuery("");
      return;
    }
    if (input === "q" || key.escape) {
      if (onBack) {
        onBack();
      } else {
        exit();
      }
      return;
    }
    if (input === "v") {
      setViewType((prev) => {
        const cycle: ViewType[] = ["tree", "timeline", "simple"];
        const idx = cycle.indexOf(prev);
        return cycle[(idx + 1) % cycle.length];
      });
      return;
    }

    // j/k select next/previous log
    if (key.downArrow || input === "j") {
      setSelectedIndex((prev) => {
        const next = Math.min(prev + 1, filteredLogs.length - 1);
        // If selected item is out of visible area, scroll to follow
        if (next >= safeScrollOffset + visibleCount) {
          setScrollOffset(next - visibleCount + 1);
        }
        return next;
      });
      return;
    }
    if (key.upArrow || input === "k") {
      setSelectedIndex((prev) => {
        const next = Math.max(prev - 1, 0);
        if (next < safeScrollOffset) {
          setScrollOffset(next);
        }
        return next;
      });
      return;
    }

    if (input === "g" && !key.ctrl) {
      setSelectedIndex(0);
      setScrollOffset(0);
      return;
    }
    if (input === "G" || (input === "g" && key.shift)) {
      const lastIdx = filteredLogs.length - 1;
      setSelectedIndex(lastIdx);
      setScrollOffset(Math.max(0, lastIdx - visibleCount + 1));
      return;
    }
  });

  if (loading || error) {
    return <Status loading={loading} error={error} loadingText="Querying trace data..." />;
  }

  const headerQueryInfo = `${queryInfo}${stats ? ` | Spans: ${stats.spanCount} | Services: ${stats.services.join(", ") || "-"} | Duration: ${stats.totalDurationMs}ms${stats.hasError ? ` | Errors: ${stats.errorCount}` : ""}` : ""}${searchQuery ? ` | Search: "${searchQuery}" -> ${filteredLogs.length} entries` : ""}`;
  const extraInfo = `View: ${viewType} (v to switch) | Logs: ${logs.length} entries${logSource ? ` (${logSource})` : ""}`;
  const footerHints = "v Switch view  / Search  Up/Down/jk Select  g/G Top/Bottom  q Quit";

  return (
    <Box flexDirection="column" padding={0}>
      <Header title="Monitor CLI - Trace" queryInfo={headerQueryInfo} extraInfo={extraInfo} />

      {/* Content area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {spans.length === 0 && logs.length === 0 ? (
          <Text dimColor>No data</Text>
        ) : (
          <>
            {/* Trace view */}
            {spans.length > 0 && (
              <>
                <TraceView spans={spans} viewType={viewType} />
                {logs.length > 0 && <Divider />}
              </>
            )}

            {/* Associated logs - with selection state */}
            {visibleLogs.map((entry, i) => {
              const absoluteIdx = safeScrollOffset + i;
              const isSelected = absoluteIdx === safeSelectedIndex;
              return (
                <LogItem
                  key={absoluteIdx}
                  entry={entry}
                  isSelected={isSelected}
                  query={searchQuery}
                />
              );
            })}
          </>
        )}
      </Box>

      <Footer searchMode={searchMode} searchQuery={searchQuery} hints={footerHints} />
    </Box>
  );
}
