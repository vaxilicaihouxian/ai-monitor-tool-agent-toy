/**
 * App - Log query view component
 *
 * Main display view for log results, supporting entry-level scrolling,
 * search filtering, and keyboard navigation.
 * Uses line-level scroll positioning (rather than entry-level) for precise
 * control over the visible area.
 */
import { useState, useMemo, useRef } from "react";
import { Box, Text, useInput, useApp } from "ink";
import { type LogEntry } from "../query.js";
import { Header } from "../components/Header.js";
import { Footer } from "../components/Footer.js";
import { Status } from "../components/Status.js";
import { LogItem } from "../components/LogItem.js";

/** App props */
interface AppProps {
  /** List of log entries */
  logs: LogEntry[];
  /** Whether data is loading */
  loading: boolean;
  /** Error message */
  error: string | null;
  /** Query info description */
  queryInfo: string;
  /** Back callback */
  onBack?: () => void;
}

/** Display row: contains log entry and lowercase JSON text (for search matching) */
interface DisplayRow {
  entry: LogEntry;
  jsonText: string;
}

/** Entry line info: records the starting line and line count of each entry in the total line space */
interface EntryLineInfo {
  entryIndex: number;
  startLine: number;
  lineCount: number;
}

/** Estimate the number of lines an entry occupies on screen, accounting for terminal width and long text wrapping */
function getEntryLineCount(entry: LogEntry): number {
  const termWidth = process.stdout.columns || 80;
  const availWidth = Math.max(30, termWidth - 8);

  let lines = 5;

  for (const [key, val] of Object.entries(entry)) {
    const keyLen = key.length + 2;
    let valDisplayLen: number;
    if (typeof val === "string") {
      valDisplayLen = val.length + 2;
    } else if (val === null || val === undefined) {
      valDisplayLen = 4;
    } else {
      valDisplayLen = JSON.stringify(val).length;
    }
    const lineLen = 2 + keyLen + 2 + valDisplayLen + 1;
    lines += Math.max(1, Math.ceil(lineLen / availWidth));
  }

  return lines + 1;
}

/** Binary search: find the entry index that contains the specified line number */
function findEntryAtLine(line: number, info: EntryLineInfo[]): number {
  let lo = 0;
  let hi = info.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (info[mid].startLine <= line) {
      if (mid === info.length - 1 || info[mid + 1].startLine > line) {
        return mid;
      }
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return 0;
}

/** App log query view component */
export default function App({ logs, loading, error, queryInfo, onBack }: AppProps) {
  const { exit } = useApp();
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [scrollLine, setScrollLine] = useState(0);

  const stateRef = useRef<{
    searchMode: boolean;
    searchQuery: string;
    selectedIndex: number;
    scrollLine: number;
    maxScrollLine: number;
    filteredLogs: DisplayRow[];
    entryLineInfo: EntryLineInfo[];
    totalLines: number;
    logs: LogEntry[];
  }>({
    searchMode: false,
    searchQuery: "",
    selectedIndex: 0,
    scrollLine: 0,
    maxScrollLine: 0,
    filteredLogs: [],
    entryLineInfo: [],
    totalLines: 0,
    logs: [],
  });

  const displayRows: DisplayRow[] = useMemo(
    () =>
      logs.map((entry) => ({
        entry,
        jsonText: JSON.stringify(entry, null, 2).toLowerCase(),
      })),
    [logs],
  );

  const terminalHeight = process.stdout.rows || 40;
  const headerLines = 4;
  const footerLines = 3;
  const availableListHeight = Math.max(5, terminalHeight - headerLines - footerLines);

  const filteredLogs = searchQuery
    ? displayRows.filter((row) => row.jsonText.includes(searchQuery.toLowerCase()))
    : displayRows;

  const safeSelectedIndex = Math.min(selectedIndex, Math.max(0, filteredLogs.length - 1));

  const entryLineInfo: EntryLineInfo[] = useMemo(() => {
    const info: EntryLineInfo[] = [];
    let line = 0;
    for (let i = 0; i < filteredLogs.length; i++) {
      const lc = getEntryLineCount(filteredLogs[i].entry);
      info.push({ entryIndex: i, startLine: line, lineCount: lc });
      line += lc;
    }
    return info;
  }, [filteredLogs]);

  const totalLines = useMemo(() => {
    if (entryLineInfo.length === 0) return 0;
    const last = entryLineInfo[entryLineInfo.length - 1];
    return last.startLine + last.lineCount;
  }, [entryLineInfo]);

  const maxScrollLine = Math.max(0, totalLines - availableListHeight);
  const safeScrollLine = Math.min(Math.max(0, scrollLine), maxScrollLine);

  const visibleEntries: { info: EntryLineInfo; row: DisplayRow }[] = useMemo(() => {
    if (entryLineInfo.length === 0) return [];

    const firstIdx = findEntryAtLine(safeScrollLine, entryLineInfo);
    const viewTop = entryLineInfo[firstIdx].startLine;
    const viewBottom = viewTop + availableListHeight;

    const result: { info: EntryLineInfo; row: DisplayRow }[] = [];
    for (let i = firstIdx; i < entryLineInfo.length; i++) {
      const info = entryLineInfo[i];
      const entryEnd = info.startLine + info.lineCount;
      if (info.startLine < viewBottom && entryEnd > viewTop) {
        result.push({ info, row: filteredLogs[info.entryIndex] });
      }
      if (info.startLine >= viewBottom) break;
    }
    return result;
  }, [entryLineInfo, safeScrollLine, availableListHeight, filteredLogs]);

  stateRef.current = {
    searchMode,
    searchQuery,
    selectedIndex,
    scrollLine: safeScrollLine,
    maxScrollLine,
    filteredLogs,
    entryLineInfo,
    totalLines,
    logs,
  };

  useInput((input, key) => {
    const s = stateRef.current;

    if (s.searchMode) {
      if (key.escape) {
        setSearchMode(false);
        setSearchQuery("");
        setSelectedIndex(0);
      } else if (key.return) {
        setSearchMode(false);
      } else if (key.backspace || key.delete) {
        setSearchQuery((prev) => prev.slice(0, -1));
        setSelectedIndex(0);
      } else if (input.length === 1 && !key.ctrl && !key.meta) {
        setSearchQuery((prev) => prev + input);
        setSelectedIndex(0);
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

    if (key.ctrl && input === "e") {
      setScrollLine((prev) => Math.min(s.maxScrollLine, prev + 1));
      return;
    }
    if (key.ctrl && input === "y") {
      setScrollLine((prev) => Math.max(0, prev - 1));
      return;
    }

    if (key.upArrow || input === "k") {
      const nextIdx = Math.max(0, s.selectedIndex - 1);
      setSelectedIndex(nextIdx);

      if (nextIdx < s.entryLineInfo.length) {
        const entry = s.entryLineInfo[nextIdx];
        if (entry.startLine < s.scrollLine) {
          setScrollLine(entry.startLine);
        }
      }
      return;
    }

    if (key.downArrow || input === "j") {
      const maxIdx = Math.max(0, s.filteredLogs.length - 1);
      const nextIdx = Math.min(maxIdx, s.selectedIndex + 1);
      setSelectedIndex(nextIdx);

      if (nextIdx < s.entryLineInfo.length) {
        const entry = s.entryLineInfo[nextIdx];
        const viewBottom = s.scrollLine + availableListHeight;
        const entryBottom = entry.startLine + entry.lineCount;
        if (entryBottom > viewBottom) {
          setScrollLine(entry.startLine);
        }
      }
      return;
    }

    if (input === "g" && !key.ctrl) {
      setSelectedIndex(0);
      setScrollLine(0);
      return;
    }
    if (input === "G" || (input === "g" && key.shift)) {
      const lastIdx = Math.max(0, s.filteredLogs.length - 1);
      setSelectedIndex(lastIdx);
      setScrollLine(s.maxScrollLine);
      return;
    }
  });

  if (loading || error) {
    return <Status loading={loading} error={error} loadingText="Querying logs..." />;
  }

  const headerQueryInfo = `${queryInfo} | ${logs.length} entries${searchQuery ? ` | Search: "${searchQuery}" -> ${filteredLogs.length} entries` : ""}`;
  const footerHints = "/ Search  Up/Down/jk Select  ctrl+e/y Scroll line  g/G Top/Bottom  q Quit";

  return (
    <Box flexDirection="column" padding={0}>
      <Header title="Monitor CLI" queryInfo={headerQueryInfo} />

      {/* Content area */}
      <Box flexDirection="column" flexGrow={1} paddingX={1}>
        {filteredLogs.length === 0 ? (
          <Text dimColor>{searchQuery ? "No matching results" : "No data"}</Text>
        ) : (
          visibleEntries.map(({ info, row }) => {
            const isSelected = info.entryIndex === safeSelectedIndex;
            return (
              <LogItem
                key={info.entryIndex}
                entry={row.entry}
                isSelected={isSelected}
                query={searchQuery}
              />
            );
          })
        )}
      </Box>

      <Footer searchMode={searchMode} searchQuery={searchQuery} hints={footerHints} />
    </Box>
  );
}
