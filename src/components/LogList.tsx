/**
 * LogList - Log list component
 *
 * Renders a filtered and paginated list of log entries. Displays placeholder
 * text when there are no matching results or when data is empty.
 */
import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../query.js";
import { LogItem, detectLevelColor } from "./LogItem.js";

/** LogList props */
interface LogListProps {
  /** Full filtered log list (for empty state detection) */
  filteredLogs: Array<{ entry: LogEntry }>;
  /** Currently visible log entry subset (for rendering) */
  visibleEntries: Array<{ row: { entry: LogEntry } }>;
  /** Currently selected log index */
  selectedIndex: number;
  /** Search keyword */
  searchQuery: string;
  /** Hint text when data is empty, defaults to "No data" */
  emptyText?: string;
}

export function LogList({
  filteredLogs,
  visibleEntries,
  selectedIndex,
  searchQuery,
  emptyText = "No data",
}: LogListProps) {
  if (filteredLogs.length === 0) {
    return <Text dimColor>{searchQuery ? "No matching results" : emptyText}</Text>;
  }

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={1}>
      {visibleEntries.map(({ row }, i) => {
        const isSelected = i === selectedIndex;
        return (
          <LogItem
            key={i}
            entry={row.entry}
            isSelected={isSelected}
            query={searchQuery}
          />
        );
      })}
    </Box>
  );
}
