/**
 * Divider - Divider line component
 *
 * Renders a horizontal divider line in the terminal to separate different content areas.
 * Width defaults to the terminal column width, up to 60 characters.
 */
import { Text } from "ink";

/** Divider props */
interface DividerProps {
  /** Divider line width in characters, defaults to terminal width or 80 */
  width?: number;
}

export function Divider({ width }: DividerProps) {
  const columns = width || process.stdout.columns || 80;
  const line = "─".repeat(Math.min(columns - 2, 60));
  return <Text dimColor>{line}</Text>;
}
