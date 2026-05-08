/**
 * Markdown - Markdown rendering component
 *
 * Parses and renders Markdown text as terminal output with ANSI colors.
 * Provides both component-level rendering and plain text formatting (formatMarkdownForOutput).
 */
import { useMemo } from "react";
import { Box, Text } from "ink";
import { formatMarkdown } from "../utils/markdown.js";

/** Markdown props */
interface MarkdownProps {
  /** Markdown text content */
  content: string;
}

/** Markdown rendering component: parses Markdown text and renders it as colored terminal output */
export function Markdown({ content }: MarkdownProps) {
  const lines = useMemo(() => {
    const formatted = formatMarkdown(content);
    return formatted.split("\n");
  }, [content]);

  return (
    <Box flexDirection="column">
      {lines.map((line, i) => {
        // For lines containing ANSI escape codes, use Text component to render
        // Ink's Text component handles ANSI escape codes
        // eslint-disable-next-line no-control-regex
        if (/\x1B\[/.test(line)) {
          return <Text key={i}>{line}</Text>;
        }
        return <Text key={i}>{line}</Text>;
      })}
    </Box>
  );
}

/** Directly output colored Markdown text (for console.log streaming output) */
export function formatMarkdownForOutput(content: string): string {
  return formatMarkdown(content);
}
