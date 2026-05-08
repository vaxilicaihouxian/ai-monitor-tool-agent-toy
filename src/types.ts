/**
 * Shared type definitions
 *
 * Defines cross-module data structures used throughout the project.
 * Currently includes trace group types used in alarm event drill-down.
 */
import { type LogEntry } from "./query.js";
import { type JaegerSpan, type TraceStats } from "./traceAnalyzer.js";

/** Trace group in alarm event drill-down */
export interface DrillTraceGroup {
  traceId: string;
  spans: JaegerSpan[];
  stats: TraceStats | null;
  logs: LogEntry[];
}
