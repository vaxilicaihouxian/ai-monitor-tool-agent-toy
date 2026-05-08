/**
 * Jaeger Trace analysis module - ported from trace-analyzer.js
 */

export interface JaegerSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  operationName: string;
  startTime: number;
  startTimeMs: number | null;
  duration: number;
  durationMs: number | null;
  serviceName: string;
  tags: Record<string, unknown>;
  hasError: boolean;
}

export interface TraceTreeNode extends JaegerSpan {
  children: TraceTreeNode[];
}

export interface TraceStats {
  traceId: string;
  spanCount: number;
  totalDurationMs: number;
  errorCount: number;
  hasError: boolean;
  services: string[];
  rootOperation: string | undefined;
}

export type ViewType = "tree" | "timeline" | "simple";

function extractParentSpanId(source: Record<string, unknown>): string | null {
  if (source.parentSpanID || source.parentSpanId) {
    return (source.parentSpanID || source.parentSpanId) as string;
  }

  const references = source.references as Array<{
    refType?: string;
    spanID?: string;
  }> | undefined;
  if (references && Array.isArray(references)) {
    const childOfRef = references.find(
      (ref) => ref.refType === "CHILD_OF" || ref.refType === "child_of"
    );
    if (childOfRef?.spanID) return childOfRef.spanID;
  }

  return null;
}

function parseTags(
  tags: Array<{ key: string; value: unknown }>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (tag.key) result[tag.key] = tag.value;
    }
  }
  return result;
}

function checkError(source: Record<string, unknown>): boolean {
  const tags = source.tags as Array<{ key: string; value: unknown }> | undefined;
  if (tags && Array.isArray(tags)) {
    const errorTag = tags.find((t) => t.key === "error");
    if (errorTag)
      return errorTag.value === true || errorTag.value === "true";
  }
  return false;
}

export function parseSpan(hit: { _source?: Record<string, unknown>; fields?: Record<string, unknown> }): JaegerSpan {
  const source = (hit._source || hit.fields || {}) as Record<string, unknown>;

  return {
    traceId: (source.traceID || source.traceId || "") as string,
    spanId: (source.spanID || source.spanId || "") as string,
    parentSpanId: extractParentSpanId(source),
    operationName: (source.operationName || source.operation || "") as string,
    startTime: (source.startTime || 0) as number,
    startTimeMs: source.startTime
      ? Math.floor((source.startTime as number) / 1000)
      : null,
    duration: (source.duration || 0) as number,
    durationMs: source.duration
      ? Math.floor((source.duration as number) / 1000)
      : null,
    serviceName: (
      (source.process as Record<string, unknown>)?.serviceName ||
      source.serviceName ||
      ""
    ) as string,
    tags: parseTags((source.tags || []) as Array<{ key: string; value: unknown }>),
    hasError: checkError(source),
  };
}

export function parseSpans(
  hits: Array<{ _source?: Record<string, unknown>; fields?: Record<string, unknown> }>
): JaegerSpan[] {
  return hits.map((hit) => parseSpan(hit));
}

/**
 * Build call tree, handle orphan spans (parent not in result set)
 */
export function buildCallTree(spans: JaegerSpan[]): TraceTreeNode[] {
  const spanMap: Record<string, TraceTreeNode> = {};
  const rootSpans: TraceTreeNode[] = [];
  const orphanSpans: TraceTreeNode[] = [];

  for (const span of spans) {
    spanMap[span.spanId] = { ...span, children: [] };
  }

  for (const span of spans) {
    const node = spanMap[span.spanId];
    const hasNoParent =
      !span.parentSpanId ||
      span.parentSpanId === "" ||
      span.parentSpanId === "0" ||
      (span.parentSpanId as unknown as number) === 0;

    if (hasNoParent) {
      rootSpans.push(node);
    } else if (span.parentSpanId && spanMap[span.parentSpanId]) {
      spanMap[span.parentSpanId].children.push(node);
    } else {
      orphanSpans.push(node);
    }
  }

  // If no root, promote orphans to root (fallback handling)
  if (rootSpans.length === 0 && orphanSpans.length > 0) {
    rootSpans.push(...orphanSpans);
  }

  const sortByStartTime = (nodes: TraceTreeNode[]) => {
    nodes.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    for (const node of nodes) {
      if (node.children.length > 0) sortByStartTime(node.children);
    }
  };
  sortByStartTime(rootSpans);

  return rootSpans;
}

function formatNodeName(node: JaegerSpan): string {
  const service = node.serviceName || "unknown";
  const operation = node.operationName || "unknown";
  const shortOp = operation.split("/").pop() || operation;
  return `${service} → ${shortOp}`;
}

function formatTreeNode(
  nodes: TraceTreeNode[],
  prefix = "",
  totalDuration: number
): string {
  let result = "";

  nodes.forEach((node, index) => {
    const isLastNode = index === nodes.length - 1;
    const connector = isLastNode ? "└─ " : "├─ ";
    const status = node.hasError ? "❌" : "✓";
    const duration = node.durationMs ? `${node.durationMs}ms` : "";
    const percent =
      totalDuration && node.duration
        ? ` (${((node.duration / totalDuration) * 100).toFixed(1)}%)`
        : "";

    result += `${prefix}${connector}${status} ${formatNodeName(node)}`;
    if (duration) result += `  ${duration}${percent}`;
    result += "\n";

    if (node.children && node.children.length > 0) {
      const newPrefix = prefix + (isLastNode ? "   " : "│  ");
      result += formatTreeNode(node.children, newPrefix, totalDuration);
    }
  });

  return result;
}

/** Unicode tree view */
export function formatTraceTree(spans: JaegerSpan[]): string {
  if (spans.length === 0) return "(no span data)";
  const tree = buildCallTree(spans);
  const totalDuration = Math.max(...spans.map((s) => s.duration || 0));
  return formatTreeNode(tree, "", totalDuration);
}

export function calculateDepths(spans: JaegerSpan[]): Record<string, number> {
  const depthMap: Record<string, number> = {};
  const spanMap: Record<string, JaegerSpan> = {};

  for (const s of spans) spanMap[s.spanId] = s;

  const getDepth = (spanId: string): number => {
    if (depthMap[spanId] !== undefined) return depthMap[spanId];
    const span = spanMap[spanId];
    if (!span || !span.parentSpanId || !spanMap[span.parentSpanId]) {
      depthMap[spanId] = 0;
      return 0;
    }
    const depth = getDepth(span.parentSpanId) + 1;
    depthMap[spanId] = depth;
    return depth;
  };

  for (const s of spans) getDepth(s.spanId);
  return depthMap;
}

function drawBar(offset: number, width: number, hasError: boolean): string {
  const offsetStr = " ".repeat(Math.floor(offset));
  const barChar = hasError ? "█" : "▓";
  const bar = barChar.repeat(Math.max(Math.floor(width), 1));
  return `${offsetStr}${bar}`;
}

// Constant: terminal width
const TERM_BAR_WIDTH = 60;

/** Timeline view (waterfall) */
export function formatTimelineView(spans: JaegerSpan[]): string {
  if (spans.length === 0) return "(no span data)";

  const totalDuration = Math.max(...spans.map((s) => s.duration || 0));
  const minStartTime = Math.min(...spans.map((s) => s.startTime || 0));
  const totalRange = Math.max(
    totalDuration,
    Math.max(...spans.map((s) => (s.startTime || 0) + (s.duration || 0))) -
      minStartTime
  );

  let result = `Timeline view (total duration: ${Math.floor(totalDuration / 1000)}ms)\n`;
  result += `${"─".repeat(TERM_BAR_WIDTH + 30)}\n`;

  const sortedSpans = [...spans].sort(
    (a, b) => (a.startTime || 0) - (b.startTime || 0)
  );
  const depthMap = calculateDepths(spans);

  for (const span of sortedSpans) {
    const depth = depthMap[span.spanId] || 0;
    const indent = "  ".repeat(Math.min(depth, 6));
    const offset = span.startTime
      ? ((span.startTime - minStartTime) / totalRange) * TERM_BAR_WIDTH
      : 0;
    const width = span.duration
      ? Math.max((span.duration / totalRange) * TERM_BAR_WIDTH, 2)
      : 2;

    const status = span.hasError ? "❌" : "✓";
    const bar = drawBar(offset, width, span.hasError);
    const duration = span.durationMs
      ? `${span.durationMs}ms`.padEnd(8)
      : "N/A".padEnd(8);

    result += `${indent}${status} ${duration} ${bar} ${formatNodeName(span)}\n`;
  }

  return result;
}

/** Simple list view */
export function formatSimpleList(spans: JaegerSpan[]): string {
  if (spans.length === 0) return "(no span data)";

  const sortedSpans = [...spans].sort(
    (a, b) => (a.startTime || 0) - (b.startTime || 0)
  );

  let result = "Span list:\n";
  result += `${"─".repeat(70)}\n`;

  sortedSpans.forEach((span, idx) => {
    const status = span.hasError ? "❌" : "✓";
    const duration = span.durationMs
      ? `${span.durationMs}ms`.padEnd(10)
      : "N/A".padEnd(10);
    const parent = span.parentSpanId
      ? `← ${span.parentSpanId.substring(0, 8)}`
      : "(root)";

    result += `${status} [${String(idx + 1).padStart(2)}] ${duration} ${parent.padEnd(12)} ${formatNodeName(span)}\n`;
  });

  return result;
}

/** Format by view type */
export function formatTraceView(
  spans: JaegerSpan[],
  viewType: ViewType = "tree"
): string {
  switch (viewType) {
    case "tree":
      return formatTraceTree(spans);
    case "timeline":
      return formatTimelineView(spans);
    case "simple":
      return formatSimpleList(spans);
    default:
      return formatTraceTree(spans);
  }
}

/** Calculate call chain statistics */
export function getTraceStats(spans: JaegerSpan[]): TraceStats | null {
  if (!spans || spans.length === 0) return null;

  const totalDuration = Math.max(...spans.map((s) => s.duration || 0));
  const errorCount = spans.filter((s) => s.hasError).length;
  const services = [
    ...new Set(spans.map((s) => s.serviceName).filter(Boolean)),
  ];
  const rootSpan = spans.find(
    (s) =>
      !s.parentSpanId ||
      s.parentSpanId === "" ||
      s.parentSpanId === "0"
  );

  return {
    traceId: spans[0]?.traceId,
    spanCount: spans.length,
    totalDurationMs: Math.floor(totalDuration / 1000),
    errorCount,
    hasError: errorCount > 0,
    services,
    rootOperation: rootSpan?.operationName,
  };
}
