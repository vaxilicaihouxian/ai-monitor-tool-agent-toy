/**
 * StepsProgress - Multi-step progress bar component
 *
 * Displays execution progress of multiple steps in a list: completed (green check),
 * in progress (spinning animation + elapsed time), pending (gray dot).
 * Used for progress feedback in multi-step operations like alarm analysis.
 */
import { useState, useEffect, useRef } from "react";
import { Box, Text } from "ink";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** StepsProgress props */
interface StepsProgressProps {
  /** Step name list */
  steps: string[];
  /** Current step index (0-based) */
  currentStep: number;
  /** Sub-progress description for the current step */
  subStep?: string;
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

export function StepsProgress({ steps, currentStep, subStep }: StepsProgressProps) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(Date.now());

  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrame((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(frameTimer);
  }, []);

  useEffect(() => {
    startRef.current = Date.now();
    setElapsed(0);
  }, [currentStep]);

  useEffect(() => {
    const elapsedTimer = setInterval(() => {
      setElapsed(Date.now() - startRef.current);
    }, 100);
    return () => clearInterval(elapsedTimer);
  }, [currentStep]);

  return (
    <Box flexDirection="column">
      {steps.map((label, i) => {
        if (i < currentStep) {
          // Completed
          return (
            <Text key={i} color="green">
              {"  "}✓ {label}
            </Text>
          );
        }
        if (i === currentStep) {
          // In progress
          return (
            <Box key={i} flexDirection="column">
              <Text>
                <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
                <Text> {label}</Text>
                <Text dimColor> ({formatElapsed(elapsed)})</Text>
              </Text>
              {subStep && (
                <Text dimColor>
                  {"    "}{subStep}
                </Text>
              )}
            </Box>
          );
        }
        // Pending
        return (
          <Text key={i} dimColor>
            {"  "}· {label}
          </Text>
        );
      })}
    </Box>
  );
}
