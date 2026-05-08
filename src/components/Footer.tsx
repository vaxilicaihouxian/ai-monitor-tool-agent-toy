/**
 * Footer - Bottom shortcut hints component
 *
 * Displays a hint bar with rounded borders at the bottom of the terminal.
 * Shows a search input box when in search mode, otherwise shows shortcut hints.
 */
import { Box, Text } from "ink";

/** Footer props */
interface FooterProps {
  /** Whether in search mode */
  searchMode: boolean;
  /** Search keyword */
  searchQuery: string;
  /** Shortcut hint text */
  hints: string;
}

export function Footer({ searchMode, searchQuery, hints }: FooterProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      {searchMode ? (
        <Text>
          <Text bold color="yellow">
            Search:{" "}
          </Text>
          <Text>{searchQuery}</Text>
          <Text dimColor> Esc/Enter to close</Text>
        </Text>
      ) : (
        <Text dimColor>{hints}</Text>
      )}
    </Box>
  );
}
