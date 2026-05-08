/**
 * Spinner - Dynamic loading animation component
 *
 * Displays rotating animation frames with an operation description label
 * and elapsed time. Used for loading feedback of a single-step operation
 * (not for multi-step scenarios).
 */
import { useState, useEffect, useRef } from "react";
import { Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

interface SpinnerProps {
  /** Verb description, e.g. "Querying logs", "Analyzing" */
  label: string;
  /** Optional sub-step description */
  subLabel?: string;
  /** Start timestamp in milliseconds for elapsed time display. Defaults to component mount time */
  startTime?: number;
}

/** Format elapsed time */
function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const min = Math.floor(sec / 60);
  const remainSec = (sec % 60).toFixed(0);
  return `${min}m${remainSec}s`;
}

export function Spinner({ label, subLabel, startTime }: SpinnerProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(startTime ?? Date.now());

  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(frameTimer);
  }, []);

  useEffect(() => {
    const elapsedTimer = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 100);
    return () => clearInterval(elapsedTimer);
  }, []);

  return (
    <Text>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      <Text> {label}</Text>
      <Text dimColor> ({formatElapsed(elapsed)})</Text>
      {subLabel && <Text dimColor> — {subLabel}</Text>}
    </Text>
  );
}
