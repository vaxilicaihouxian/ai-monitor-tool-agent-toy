/**
 * JsonBlock - JSON syntax highlighting rendering component
 *
 * Renders a log entry (LogEntry) as JSON with syntax colors in the terminal.
 * Supports highlight color switching for selected state and search keyword highlighting.
 * Provides sub-components for highlighted text and JSON scalar values, reusable independently.
 */
import React from "react";
import { Box, Text } from "ink";
import type { LogEntry } from "../query.js";

// JSON syntax colors
const JC = {
  key: "cyan",
  string: "green",
  number: "yellow",
  boolean: "magenta",
  null: "gray",
  bracket: "gray",
};

// Colors for selected state (dark background + bright text, ensuring readability)
const JC_SELECTED = {
  key: "cyanBright",
  string: "greenBright",
  number: "yellowBright",
  boolean: "magentaBright",
  null: "gray",
  bracket: "gray",
};

export function highlightParts(
  text: string,
  query: string
): { text: string; hl: boolean }[] {
  if (!query) return [{ text, hl: false }];
  const parts: { text: string; hl: boolean }[] = [];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let lastIndex = 0;
  let idx = lowerText.indexOf(lowerQuery, lastIndex);
  while (idx !== -1) {
    if (idx > lastIndex) parts.push({ text: text.slice(lastIndex, idx), hl: false });
    parts.push({ text: text.slice(idx, idx + query.length), hl: true });
    lastIndex = idx + query.length;
    idx = lowerText.indexOf(lowerQuery, lastIndex);
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), hl: false });
  return parts;
}

/** Text fragment with search highlighting */
export function HlText({ text, query, color }: { text: string; query: string; color?: string }) {
  if (!query) {
    return <Text color={color}>{text}</Text>;
  }
  const parts = highlightParts(text, query);
  return (
    <Text>
      {parts.map((p, i) =>
        p.hl ? (
          <Text key={i} backgroundColor="magenta" color="white">{p.text}</Text>
        ) : (
          <Text key={i} color={color}>{p.text}</Text>
        ),
      )}
    </Text>
  );
}

/** Render a JSON scalar value with type-based coloring and search highlighting */
export function JsonVal({ value, query, colors }: { value: unknown; query: string; colors: typeof JC }) {
  if (value === null || value === undefined) {
    return <Text dimColor>null</Text>;
  }
  if (typeof value === "boolean") {
    return <HlText text={String(value)} query={query} color={colors.boolean} />;
  }
  if (typeof value === "number") {
    return <HlText text={String(value)} query={query} color={colors.number} />;
  }
  if (typeof value === "string") {
    return (
      <Text>
        <Text color={colors.string}>"</Text>
        <HlText text={value} query={query} color={colors.string} />
        <Text color={colors.string}>"</Text>
      </Text>
    );
  }
  return <Text color={colors.string}>{JSON.stringify(value)}</Text>;
}

/** JsonBlock props */
interface JsonBlockProps {
  /** The log entry to render */
  entry: LogEntry;
  /** Search keyword for highlighting matched text */
  query: string;
  /** Whether in selected state (switches highlight colors) */
  selected?: boolean;
}

/** Render a log entry as a syntax-highlighted JSON block */
export function JsonBlock({ entry, query, selected = false }: JsonBlockProps) {
  const colors = selected ? JC_SELECTED : JC;
  const entries = Object.entries(entry);
  if (entries.length === 0) {
    return <Text color={colors.bracket}>{"{ }"}</Text>;
  }

  return (
    <Box flexDirection="column">
      <Text color={colors.bracket}>{"{"}</Text>
      {entries.map(([key, val], i) => {
        const comma = i < entries.length - 1 ? "," : "";
        return (
          <Text key={key} wrap="wrap">
            {"  "}
            <HlText text={`"${key}"`} query={query} color={colors.key} />
            <Text color={colors.bracket}>: </Text>
            <JsonVal value={val} query={query} colors={colors} />
            <Text color={colors.bracket}>{comma}</Text>
          </Text>
        );
      })}
      <Text color={colors.bracket}>{"}"}</Text>
    </Box>
  );
}
