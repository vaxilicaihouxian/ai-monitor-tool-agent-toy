/**
 * CommandInput - REPL command input component
 *
 * Provides an interactive command input box with support for:
 * - Cursor movement (left/right arrows)
 * - Command history navigation (up/down arrows)
 * - / prefix command completion suggestions (Tab/Enter to complete)
 * - Usage hints for completed commands
 * - Ctrl+C to exit
 */
import { useState, useRef, useMemo } from "react";
import { Box, Text, useInput, type Key } from "ink";

/** CommandInput props */
interface CommandInputProps {
  /** Submit command callback */
  onSubmit: (input: string) => void;
  /** Quit program callback */
  onQuit: () => void;
  /** Prompt, defaults to "omc" */
  prompt?: string;
  /** Available command list (dynamically computed based on PluginManager) */
  availableCommands?: string[];
}

const ALERT_ENABLED = !!process.env.OMC_DEBUG;

/** Command suggestion item */
interface SuggestionItem {
  id: string;
  displayText: string;
  tag?: string;
  description: string;
}

const COMMAND_SUGGESTIONS: SuggestionItem[] = [
  { id: "/alarm-drill", displayText: "/alarm-drill", tag: "Alarm", description: "Alarm event drill-down (logs+traces+metrics)" },
  { id: "/alarm-analyze-event-online", displayText: "/alarm-analyze-event-online", tag: "Alarm", description: "Alarm intelligent analysis (online data collection+LLM analysis)" },
  { id: "/alarm-analyze-file", displayText: "/alarm-analyze-file", tag: "Alarm", description: "Alarm intelligent analysis (from file)" },
  { id: "/alarm-analyze-event-online-agent", displayText: "/alarm-analyze-event-online-agent", tag: "Agent", description: "Agent deep analysis (online + chat)" },
  { id: "/alarm-analyze-file-agent", displayText: "/alarm-analyze-file-agent", tag: "Agent", description: "Agent deep analysis (file + chat)" },
  ...(ALERT_ENABLED ? [{ id: "/alert", displayText: "/alert", tag: "Debug", description: "Query alarm event raw JSON" }] : []),
  { id: "/log", displayText: "/log", tag: "Query", description: "Query logs [-s <search>] [-L <level>] [-a <app>]" },
  { id: "/query-metrics", displayText: "/query-metrics", tag: "Query", description: "Query Prometheus metrics" },
  { id: "/trace", displayText: "/trace", tag: "Query", description: "Query traces [-v tree|timeline|simple]" },
  { id: "/export", displayText: "/export", tag: "Tool", description: "Export results to JSON file" },
  { id: "/memory", displayText: "/memory", tag: "Tool", description: "Memory management add|show|clean|backup" },
  { id: "/help", displayText: "/help", tag: "Tool", description: "Show help" },
  { id: "/quit", displayText: "/quit", tag: "Tool", description: "Exit" },
  { id: "/exit", displayText: "/exit", tag: "Tool", description: "Exit" },
];

/** Command name fixed column width */
const CMD_COL_WIDTH = 38;
/** Max visible suggestions */
const MAX_VISIBLE = 6;

/** Truncate string to specified display width */
function truncateToWidth(text: string, width: number): string {
  let displayLen = 0;
  let result = "";
  for (const ch of text) {
    // Rough estimate: CJK characters occupy 2 width
    const w = ch.charCodeAt(0) > 0x7f ? 2 : 1;
    if (displayLen + w > width) {
      result += "…";
      break;
    }
    result += ch;
    displayLen += w;
  }
  return result;
}

/** Right-pad to specified display width */
function padRight(text: string, width: number): string {
  let displayLen = 0;
  for (const ch of text) {
    displayLen += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  }
  return text + " ".repeat(Math.max(0, width - displayLen));
}

export function CommandInput({ onSubmit, onQuit, prompt = "omc", availableCommands }: CommandInputProps) {
  const [input, setInput] = useState("");
  const [cursorPos, setCursorPos] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [suggestIdx, setSuggestIdx] = useState(-1);
  const savedInputRef = useRef("");

  // When input starts with / and no space, show matching command suggestions
  const suggestions = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ")) return [];
    const available = availableCommands ?? COMMAND_SUGGESTIONS.map((c) => c.id);
    return COMMAND_SUGGESTIONS.filter((c) => c.id.startsWith(input) && available.includes(c.id));
  }, [input, availableCommands]);

  const showSuggestions = suggestions.length > 0;

  // After command is completed, show usage hint
  const usageHint = useMemo(() => {
    if (!input.startsWith("/")) return null;
    const cmdName = input.split(" ")[0];
    const cmd = COMMAND_SUGGESTIONS.find((c) => c.id === cmdName);
    if (cmd && input.includes(" ")) return cmd.description;
    return null;
  }, [input]);

  // Scroll window calculation: ensure selected item is always visible
  const scrollWindow = useMemo(() => {
    if (!showSuggestions) return { start: 0, end: 0 };
    const total = suggestions.length;
    const end = Math.min(total, MAX_VISIBLE);
    return { start: 0, end };
  }, [showSuggestions, suggestions.length]);

  const effectiveSuggestIdx = suggestIdx < 0 ? -1 : suggestIdx;

  // If selected item is outside scroll window, adjust window
  const visibleStart = useMemo(() => {
    if (effectiveSuggestIdx < 0) return scrollWindow.start;
    const windowSize = Math.min(suggestions.length, MAX_VISIBLE);
    // Ensure selected item is within window
    let start = scrollWindow.start;
    if (effectiveSuggestIdx < start) start = effectiveSuggestIdx;
    if (effectiveSuggestIdx >= start + windowSize) start = effectiveSuggestIdx - windowSize + 1;
    return start;
  }, [effectiveSuggestIdx, scrollWindow.start, suggestions.length]);

  const windowSize = Math.min(suggestions.length, MAX_VISIBLE);
  const visibleSuggestions = suggestions.slice(visibleStart, visibleStart + windowSize);

  useInput((ch: string, key: Key) => {
      if (key.ctrl && ch === "c") {
        onQuit();
        return;
      }

      // Tab completion
      if (key.tab && showSuggestions) {
        const idx = effectiveSuggestIdx >= 0 ? effectiveSuggestIdx : 0;
        const selected = suggestions[idx];
        if (selected) {
          const completed = selected.id + " ";
          setInput(completed);
          setCursorPos(completed.length);
          setSuggestIdx(-1);
        }
        return;
      }

      if (key.return) {
        // When suggestions visible and item selected, complete command instead of submitting
        if (showSuggestions && effectiveSuggestIdx >= 0) {
          const selected = suggestions[effectiveSuggestIdx];
          if (selected) {
            const completed = selected.id + " ";
            setInput(completed);
            setCursorPos(completed.length);
            setSuggestIdx(-1);
            return;
          }
        }

        const cmd = input.trim();
        if (cmd) {
          onSubmit(cmd);
          setHistory((prev) => [...prev, cmd]);
          setHistoryIdx(-1);
          savedInputRef.current = "";
        }
        setInput("");
        setCursorPos(0);
        setSuggestIdx(-1);
        return;
      }

      if (key.backspace || key.delete) {
        if (cursorPos > 0) {
          setInput((prev) => prev.slice(0, cursorPos - 1) + prev.slice(cursorPos));
          setCursorPos((prev) => prev - 1);
        }
        setSuggestIdx(-1);
        return;
      }

      // Left/right arrows to move cursor
      if (key.leftArrow) {
        if (!showSuggestions && cursorPos > 0) {
          setCursorPos((prev) => prev - 1);
        }
        return;
      }

      if (key.rightArrow) {
        if (!showSuggestions && cursorPos < input.length) {
          setCursorPos((prev) => prev + 1);
        }
        return;
      }

      // Up/down arrows: select suggestion when visible, otherwise switch history
      if (key.upArrow) {
        if (showSuggestions) {
          setSuggestIdx((prev) =>
            prev <= 0 ? suggestions.length - 1 : prev - 1
          );
        } else {
          if (history.length === 0) return;
          if (historyIdx === -1) {
            savedInputRef.current = input;
          }
          const newIdx =
            historyIdx === -1 ? history.length - 1 : Math.max(0, historyIdx - 1);
          setHistoryIdx(newIdx);
          setInput(history[newIdx]);
          setCursorPos(history[newIdx].length);
        }
        return;
      }

      if (key.downArrow) {
        if (showSuggestions) {
          setSuggestIdx((prev) =>
            prev >= suggestions.length - 1 ? 0 : prev + 1
          );
        } else {
          if (historyIdx === -1) return;
          if (historyIdx >= history.length - 1) {
            setHistoryIdx(-1);
            setInput(savedInputRef.current);
            setCursorPos(savedInputRef.current.length);
          } else {
            const newIdx = historyIdx + 1;
            setHistoryIdx(newIdx);
            setInput(history[newIdx]);
            setCursorPos(history[newIdx].length);
          }
        }
        return;
      }

      if (ch.length > 0 && !key.ctrl && !key.meta) {
        setInput((prev) => prev.slice(0, cursorPos) + ch + prev.slice(cursorPos));
        setCursorPos((prev) => prev + ch.length);
        setSuggestIdx(-1);
      }
    }
  );

  // Terminal width (Shell padding=1, 1 on each side, content area width = termWidth - 2)
  const termWidth = process.stdout.columns || 80;
  const descColWidth = termWidth - CMD_COL_WIDTH - 6; // Subtract padding and tag space
  const hLine = "─".repeat(Math.max(1, termWidth - 4));

  return (
    <Box flexDirection="column">
      <Text color="gray">╶{hLine}╴</Text>
      <Box>
        <Text bold color="cyan">
          {prompt}&gt;{" "}
        </Text>
        <Text>{input.slice(0, cursorPos)}</Text>
        {cursorPos < input.length ? (
          <Text backgroundColor="white" color="black">{input[cursorPos]}</Text>
        ) : (
          <Text backgroundColor="white"> </Text>
        )}
        <Text>{input.slice(cursorPos + 1)}</Text>
      </Box>
      {showSuggestions && (
        <Box flexDirection="column" paddingLeft={2}>
          {visibleSuggestions.map((s, vi) => {
            const realIdx = visibleStart + vi;
            const isSelected = realIdx === effectiveSuggestIdx;
            const cmdText = padRight(s.displayText, CMD_COL_WIDTH);
            const descText = truncateToWidth(s.description, Math.max(10, descColWidth));

            return (
              <Box key={s.id}>
                <Text color={isSelected ? "cyan" : "gray"} bold={isSelected}>
                  {isSelected ? "> " : "  "}
                  {cmdText}
                </Text>
                {s.tag && (
                  <Text color={isSelected ? "yellow" : "gray"} bold={isSelected}>
                    [{s.tag}]{" "}
                  </Text>
                )}
                <Text dimColor={!isSelected} color={isSelected ? "white" : "gray"}>
                  {descText}
                </Text>
              </Box>
            );
          })}
          <Text dimColor>  ↑↓ Select · Tab/Enter to complete</Text>
        </Box>
      )}
      {usageHint && (
        <Box paddingLeft={2}>
          <Text dimColor>Usage: {usageHint}</Text>
        </Box>
      )}
      <Text color="gray">╶{hLine}╴</Text>
    </Box>
  );
}
