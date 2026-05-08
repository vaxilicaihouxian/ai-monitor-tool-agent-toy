/**
 * Status - Loading/error status display component
 *
 * Displays loading prompt or error message based on loading and error states.
 * Returns null when neither loading nor in error, taking no render space.
 */
import { Box, Text } from "ink";

/** Status props */
interface StatusProps {
  /** Whether currently loading */
  loading: boolean;
  /** Error message, displays error state when non-null */
  error: string | null;
  /** Text to display while loading, defaults to "Querying..." */
  loadingText?: string;
}

export function Status({ loading, error, loadingText = "Querying..." }: StatusProps) {
  if (error) {
    return (
      <Box padding={1}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }
  if (loading) {
    return (
      <Box padding={1}>
        <Text color="yellow">{loadingText}</Text>
      </Box>
    );
  }
  return null;
}
