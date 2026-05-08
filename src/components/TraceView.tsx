/**
 * TraceView - Trace view component
 *
 * Provides three view modes to display Jaeger Span data:
 * - tree: Tree-shaped call relationship diagram, showing service call hierarchy and duration ratio
 * - timeline: Waterfall timeline, visually displaying the time distribution of each Span
 * - simple: Simple list, displaying Span number, duration, parent-child relationship
 */
import React from "react";
import { Box, Text } from "ink";
import {
  buildCallTree,
  calculateDepths,
  type JaegerSpan,
  type TraceTreeNode,
  type ViewType,
} from "../traceAnalyzer.js";

// ─── Color constants ───
const C = {
  connector: "gray",
  statusOk: "green",
  statusErr: "red",
  service: "cyan",
  operation: "white",
  arrow: "gray",
  duration: "yellow",
  percent: "gray",
  bar: "green",
  barErr: "red",
  index: "gray",
  parentId: "gray",
  header: "cyan",
  headerDim: "gray",
};

// ─── Tree view ───

interface TreeNodeLine {
  connector: string;
  status: "ok" | "err";
  service: string;
  operation: string;
  duration: string;
  percent: string;
  children: TreeNodeLine[];
}

function buildTreeLines(
  nodes: TraceTreeNode[],
  totalDuration: number,
  isLast = true,
  prefix = ""
): TreeNodeLine[] {
  const result: TreeNodeLine[] = [];

  nodes.forEach((node, index) => {
    const isLastNode = index === nodes.length - 1;
    const connector = isLastNode ? "└─ " : "├─ ";
    const status = node.hasError ? "err" : "ok";
    const duration = node.durationMs ? `${node.durationMs}ms` : "";
    const percent =
      totalDuration && node.duration
        ? `(${((node.duration / totalDuration) * 100).toFixed(1)}%)`
        : "";

    const service = node.serviceName || "unknown";
    const operation = node.operationName || "unknown";
    const shortOp = operation.split("/").pop() || operation;

    const children: TreeNodeLine[] =
      node.children && node.children.length > 0
        ? buildTreeLines(
            node.children,
            totalDuration,
            isLastNode,
            prefix + (isLastNode ? "   " : "│  ")
          )
        : [];

    result.push({
      connector: prefix + connector,
      status,
      service,
      operation: shortOp,
      duration,
      percent,
      children,
    });
  });

  return result;
}

function TreeNode({ node }: { node: TreeNodeLine }) {
  return (
    <Box flexDirection="column">
      <Text>
        <Text color={C.connector}>{node.connector}</Text>
        <Text color={node.status === "err" ? C.statusErr : C.statusOk}>
          {node.status === "err" ? "✕" : "✓"}{" "}
        </Text>
        <Text color={C.service}>{node.service}</Text>
        <Text color={C.arrow}> → </Text>
        <Text color={C.operation}>{node.operation}</Text>
        {node.duration && (
          <>
            <Text>  </Text>
            <Text color={C.duration}>{node.duration}</Text>
            {node.percent && <Text color={C.percent}> {node.percent}</Text>}
          </>
        )}
      </Text>
      {node.children.map((child, i) => (
        <TreeNode key={i} node={child} />
      ))}
    </Box>
  );
}

function TreeView({ spans }: { spans: JaegerSpan[] }) {
  if (spans.length === 0) {
    return <Text dimColor>(No span data)</Text>;
  }
  const tree = buildCallTree(spans);
  const totalDuration = Math.max(...spans.map((s) => s.duration || 0));
  const lines = buildTreeLines(tree, totalDuration);

  return (
    <Box flexDirection="column">
      {lines.map((node, i) => (
        <TreeNode key={i} node={node} />
      ))}
    </Box>
  );
}

// ─── Timeline view ───

const TERM_BAR_WIDTH = 40;

function TimelineView({ spans }: { spans: JaegerSpan[] }) {
  if (spans.length === 0) {
    return <Text dimColor>(No span data)</Text>;
  }

  const totalDuration = Math.max(...spans.map((s) => s.duration || 0));
  const minStartTime = Math.min(...spans.map((s) => s.startTime || 0));
  const totalRange = Math.max(
    totalDuration,
    Math.max(...spans.map((s) => (s.startTime || 0) + (s.duration || 0))) -
      minStartTime
  );

  const sortedSpans = [...spans].sort(
    (a, b) => (a.startTime || 0) - (b.startTime || 0)
  );
  const depthMap = calculateDepths(spans);

  return (
    <Box flexDirection="column">
      <Text>
        <Text color={C.header}>Timeline view</Text>
        <Text color={C.headerDim}> (Total duration: {Math.floor(totalDuration / 1000)}ms)</Text>
      </Text>
      <Text color={C.connector}>{"─".repeat(TERM_BAR_WIDTH + 20)}</Text>

      {sortedSpans.map((span, idx) => {
        const depth = depthMap[span.spanId] || 0;
        const indent = "  ".repeat(Math.min(depth, 6));
        const offset = span.startTime
          ? ((span.startTime - minStartTime) / totalRange) * TERM_BAR_WIDTH
          : 0;
        const width = span.duration
          ? Math.max((span.duration / totalRange) * TERM_BAR_WIDTH, 2)
          : 2;

        const service = span.serviceName || "unknown";
        const operation = span.operationName || "unknown";
        const shortOp = operation.split("/").pop() || operation;
        const duration = span.durationMs ? `${span.durationMs}ms` : "N/A";

        const barOffset = " ".repeat(Math.floor(offset));
        const barChar = span.hasError ? "█" : "▓";
        const bar = barChar.repeat(Math.max(Math.floor(width), 1));

        return (
          <Text key={idx}>
            <Text>{indent}</Text>
            <Text color={span.hasError ? C.statusErr : C.statusOk}>
              {span.hasError ? "✕" : "✓"}{" "}
            </Text>
            <Text color={C.duration}>{duration.padEnd(8)}</Text>
            <Text color={span.hasError ? C.barErr : C.bar}>{barOffset}{bar}</Text>
            <Text> </Text>
            <Text color={C.service}>{service}</Text>
            <Text color={C.arrow}> → </Text>
            <Text color={C.operation}>{shortOp}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ─── Simple list view ───

function SimpleView({ spans }: { spans: JaegerSpan[] }) {
  if (spans.length === 0) {
    return <Text dimColor>(No span data)</Text>;
  }

  const sortedSpans = [...spans].sort(
    (a, b) => (a.startTime || 0) - (b.startTime || 0)
  );

  return (
    <Box flexDirection="column">
      <Text color={C.header}>Span list:</Text>
      <Text color={C.connector}>{"─".repeat(60)}</Text>

      {sortedSpans.map((span, idx) => {
        const service = span.serviceName || "unknown";
        const operation = span.operationName || "unknown";
        const shortOp = operation.split("/").pop() || operation;
        const duration = span.durationMs ? `${span.durationMs}ms` : "N/A";
        const parent = span.parentSpanId
          ? `← ${span.parentSpanId.substring(0, 8)}`
          : "(root)";

        return (
          <Text key={idx}>
            <Text color={span.hasError ? C.statusErr : C.statusOk}>
              {span.hasError ? "✕" : "✓"}{" "}
            </Text>
            <Text color={C.index}>[{String(idx + 1).padStart(2)}]</Text>
            <Text> </Text>
            <Text color={C.duration}>{duration.padEnd(10)}</Text>
            <Text color={C.parentId}>{parent.padEnd(12)}</Text>
            <Text color={C.service}>{service}</Text>
            <Text color={C.arrow}> → </Text>
            <Text color={C.operation}>{shortOp}</Text>
          </Text>
        );
      })}
    </Box>
  );
}

// ─── Exports ───

/** TraceView main component: switches between three view modes based on viewType */
export function TraceView({
  spans,
  viewType,
}: {
  spans: JaegerSpan[];
  viewType: ViewType;
}) {
  switch (viewType) {
    case "tree":
      return <TreeView spans={spans} />;
    case "timeline":
      return <TimelineView spans={spans} />;
    case "simple":
      return <SimpleView spans={spans} />;
    default:
      return <TreeView spans={spans} />;
  }
}
