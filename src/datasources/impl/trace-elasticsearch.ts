/**
 * Elasticsearch Trace datasource implementation (Jaeger Span)
 */

import type { DataSourceAvailability } from "../types.js";
import type { TraceDataSource, TraceQueryParams, TraceQueryResult } from "../trace.js";
import type { Config, TraceES, LogES } from "../../config.js";
import { getPluginConfig } from "../../config.js";
import { queryLogsFromES } from "../../query.js";
import { esSearch } from "../../esClient.js";
import { parseSpans, getTraceStats } from "../../traceAnalyzer.js";
import { debug, warn } from "../../utils/logger.js";

export class ElasticsearchTraceDataSource implements TraceDataSource {
  readonly id = { kind: "trace" as const, name: "elasticsearch" };

  checkAvailability(config: unknown): DataSourceAvailability {
    const c = config as Config;
    const traceES = getPluginConfig<TraceES>(c, "trace-elasticsearch");
    if (!traceES?.host || !traceES?.indexPattern) {
      return { available: false, reason: "pluginsConfig.trace-elasticsearch not configured (host + indexPattern)" };
    }
    return { available: true };
  }

  async query(config: unknown, params: TraceQueryParams): Promise<TraceQueryResult> {
    const c = config as Config;
    const traceES = getPluginConfig<TraceES>(c, "trace-elasticsearch")!;
    const result: TraceQueryResult = { spans: [], stats: null, logs: [] };

    // Step 1: Query spans
    result.spans = await this.querySpans(traceES, params.traceId);
    if (result.spans.length > 0) {
      result.stats = getTraceStats(result.spans);
    }

    // Step 2: Query associated logs (optional)
    if (params.includeLogs !== false) {
      const logResult = await this.queryRelatedLogs(c, params.traceId, params.logLimit);
      result.logs = logResult.logs;
      result.logSource = logResult.logSource;
    }

    return result;
  }

  /** Query Jaeger Spans */
  private async querySpans(traceES: NonNullable<TraceES>, traceId: string) {
    try {
      const esResult = await esSearch(traceES, traceES.indexPattern, {
        query: {
          bool: {
            should: [
              { term: { traceID: traceId } },
              { term: { traceId: traceId } },
            ],
            minimum_should_match: 1,
          },
        },
        size: 1000,
        sort: [{ startTime: { order: "asc" as const } }],
      });

      return parseSpans(esResult.hits.hits);
    } catch (e) {
      warn(`Trace ES query failed: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /** Query associated logs */
  private async queryRelatedLogs(
    config: Config,
    traceId: string,
    limit: number = 200
  ): Promise<{ logs: import("../../query.js").LogEntry[]; logSource?: string }> {
    const logES = getPluginConfig<LogES>(config, "log-elasticsearch");
    if (!logES) return { logs: [] };

    try {
      const logs = await queryLogsFromES(logES, traceId, limit);
      return { logs, logSource: "elasticsearch" };
    } catch (e) {
      warn(`ES log query failed: ${e instanceof Error ? e.message : String(e)}`);
      return { logs: [] };
    }
  }
}
