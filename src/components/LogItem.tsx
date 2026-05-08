/**
 * LogItem - Single log entry rendering component
 *
 * Renders a single log entry as a card with rounded borders, including
 * a selection indicator and JSON syntax-highlighted content. Border color
 * is automatically set based on log level.
 */
import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../query.js";
import { JsonBlock } from "./JsonBlock.js";

/** Log level to terminal color mapping */
export const LEVEL_COLORS: Record<string, string> = {
  ERROR: "red",
  FATAL: "redBright",
  WARN: "yellow",
  INFO: "green",
  DEBUG: "gray",
  TRACE: "gray",
};

/** Detect log level from a log entry and return the corresponding color */
export function detectLevelColor(row: LogEntry): string | null {
  for (const [, val] of Object.entries(row)) {
    if (typeof val === "string" && LEVEL_COLORS[val.toUpperCase()]) {
      return LEVEL_COLORS[val.toUpperCase()];
    }
  }
  return null;
}

/** LogItem props */
interface LogItemProps {
  /** The log entry to render */
  entry: LogEntry;
  /** Whether the entry is selected */
  isSelected: boolean;
  /** Search keyword, passed to JsonBlock for highlighting */
  query: string;
}

export function LogItem({ entry, isSelected, query }: LogItemProps) {
  const levelColor = detectLevelColor(entry);

  return (
    <Box
      flexDirection="column"
      borderStyle={isSelected ? "double" : "round"}
      borderColor={isSelected ? "yellow" : levelColor || "gray"}
      paddingX={1}
      marginBottom={1}
    >
      {/* Selection indicator */}
      <Text>
        <Text bold color={isSelected ? "yellow" : "gray"}>
          {isSelected ? " >" : "  "}
        </Text>
      </Text>
      {/* JSON block */}
      <Box paddingLeft={1}>
        <JsonBlock entry={entry} query={query} selected={isSelected} />
      </Box>
    </Box>
  );
}
