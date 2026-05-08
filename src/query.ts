/**
 * Data query module
 *
 * Provides Elasticsearch log query capabilities,
 * including ES query wrappers and log field lookup utility functions.
 */
import type { LogES } from "./config.js";
import { esSearch } from "./esClient.js";
import { debug } from "./utils/logger.js";

export interface LogEntry {
  [key: string]: unknown;
}

// ─── Log field lookup utility functions ───

/** Recursively find a field value in a log entry, supports dot-notation paths */
export function findField(log: LogEntry, field: string): string {
  if (log[field] != null) return String(log[field]);
  if (field.includes(".")) {
    const parts = field.split(".");
    let current: unknown = log;
    for (const p of parts) {
      if (current && typeof current === "object" && !Array.isArray(current)) {
        current = (current as Record<string, unknown>)[p];
      } else {
        current = undefined;
        break;
      }
    }
    if (current != null) return String(current);
  }
  for (const v of Object.values(log)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const nested = v as Record<string, unknown>;
      if (nested[field] != null) return String(nested[field]);
      if (field.includes(".")) {
        const parts = field.split(".");
        let current: unknown = nested;
        for (const p of parts) {
          if (current && typeof current === "object" && !Array.isArray(current)) {
            current = (current as Record<string, unknown>)[p];
          } else {
            current = undefined;
            break;
          }
        }
        if (current != null) return String(current);
      }
    }
  }
  return "";
}

/** Find traceId in a log entry, supports multiple common field names */
export function findTraceId(log: LogEntry, traceIdField: string): string {
  const direct = findField(log, traceIdField);
  if (direct) return direct;
  for (const alt of ["traceID", "trace_id", "trace-id", "TraceId"]) {
    const val = findField(log, alt);
    if (val) return val;
  }
  return "";
}

/** Try to match common log field names from all fields in a row */
export function getDisplayFields(row: LogEntry): {
  timestamp: string;
  level: string;
  message: string;
  extraKeys: string[];
} {
  const keys = Object.keys(row);

  const timestampKey =
    keys.find((k) => /timestamp|ts|time|datetime/i.test(k)) || keys[0] || "";
  const levelKey =
    keys.find((k) => /level|severity|lvl|loglevel/i.test(k)) || "";
  const messageKey =
    keys.find((k) => /message|msg|body|content|text/i.test(k)) || "";

  const usedKeys = new Set([timestampKey, levelKey, messageKey].filter(Boolean));
  const extraKeys = keys.filter((k) => !usedKeys.has(k));

  return {
    timestamp: timestampKey ? String(row[timestampKey] ?? "") : "",
    level: levelKey ? String(row[levelKey] ?? "") : "",
    message: messageKey ? String(row[messageKey] ?? "") : "",
    extraKeys,
  };
}

export interface QueryOptions {
  query?: string;
  limit?: number;
  level?: string;
  search?: string;
  startTime?: string;
  endTime?: string;
  traceId?: string;
  appname?: string;
  /** Dynamic ES term conditions, key is field name, value is match value */
  extraTerms?: Record<string, string>;
}

/** Valid ES log level enum */
export const ES_LOG_LEVELS = ["DEBUG", "INFO", "WARN", "ERROR", "FATAL"] as const;
export type ESLogLevel = (typeof ES_LOG_LEVELS)[number];

/**
 * Query logs from ES (by traceId)
 */
export async function queryLogsFromES(
  logES: LogES,
  traceId: string,
  limit: number = 200
): Promise<LogEntry[]> {
  const traceIdField = logES.traceIdField || "traceId";
  const timestampField = logES.timestampField || "@timestamp";

  const result = await esSearch(
    { host: logES.host, username: logES.username, password: logES.password },
    logES.indexPattern,
    {
      query: {
        term: { [traceIdField]: traceId },
      },
      size: limit,
      sort: [{ [timestampField]: { order: "desc" as const, unmapped_type: "date" as const } }],
    }
  );

  return result.hits.hits.map((hit) => {
    const entry: LogEntry = { ...hit._source };
    // Preserve _id for reference when needed
    if (hit._id) entry._id = hit._id;
    return entry;
  });
}
