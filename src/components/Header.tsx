/**
 * Header - Top status bar component
 *
 * Displays a status bar with rounded borders at the top of the terminal,
 * containing title, query info, and optional extra info.
 * Used as a unified top bar for all views (logs, traces, alarm analysis, etc.).
 */
import { Box, Text } from "ink";

/** Header props */
interface HeaderProps {
  /** Title, e.g. "Monitor CLI", "Alarm Drill" */
  title: string;
  /** Current query info, e.g. data source, count stats */
  queryInfo: string;
  /** Optional extra info, e.g. view type, log source */
  extraInfo?: string;
}

export function Header({ title, queryInfo, extraInfo }: HeaderProps) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1}>
      <Text bold color="cyan">
        {title}
      </Text>
      <Text dimColor>{queryInfo}</Text>
      {extraInfo && <Text dimColor>{extraInfo}</Text>}
    </Box>
  );
}
