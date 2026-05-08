/**
 * Elasticsearch log datasource implementation
 */

import type { DataSourceAvailability } from "../types.js";
import type { LogDataSource, LogQueryParams, LogQueryResult } from "../log.js";
import type { Config, LogES } from "../../config.js";
import { getPluginConfig } from "../../config.js";
import { queryLogsFromES } from "../../query.js";
import { esSearch } from "../../esClient.js";
import { debug } from "../../utils/logger.js";

export class ElasticsearchLogDataSource implements LogDataSource {
  readonly id = { kind: "log" as const, name: "elasticsearch" };

  checkAvailability(config: unknown): DataSourceAvailability {
    const c = config as Config;
    const logES = getPluginConfig<LogES>(c, "log-elasticsearch");
    if (!logES?.host || !logES?.indexPattern) {
      return { available: false, reason: "pluginsConfig.log-elasticsearch not configured (host + indexPattern)" };
    }
    return { available: true };
  }

  async query(config: unknown, params: LogQueryParams): Promise<LogQueryResult> {
    const c = config as Config;
    const logES = getPluginConfig<LogES>(c, "log-elasticsearch")!;

    if (params.traceId) {
      const entries = await queryLogsFromES(logES, params.traceId, params.limit || 200);
      return { entries, source: "elasticsearch" };
    }

    const entries = await this.queryByES(logES, params);
    return { entries, source: "elasticsearch" };
  }

  private async queryByES(logES: NonNullable<LogES>, params: LogQueryParams) {
    const fm = logES.fieldMapping;
    const must: Record<string, unknown>[] = [];
    if (params.appname) must.push({ term: { [fm?.appname || "appname"]: params.appname } });
    if (params.search) must.push({ multi_match: { query: params.search, fields: [fm?.searchFields || "*"], lenient: true } });
    if (params.level) {
      const levelField = fm?.level || "level";
      must.push({ term: { [levelField]: params.level } });
    }
    if (params.extraTerms) {
      for (const [field, value] of Object.entries(params.extraTerms)) {
        must.push({ term: { [field]: value } });
      }
    }
    const timestampField = logES.timestampField || "@timestamp";
    if (params.startTime || params.endTime) {
      const range: Record<string, unknown> = {};
      if (params.startTime) range.gte = params.startTime;
      if (params.endTime) range.lte = params.endTime;
      must.push({ range: { [timestampField]: range } });
    }
    const esQuery: Record<string, unknown> = must.length > 0 ? { bool: { must } } : { match_all: {} };
    const queryBody = {
      query: esQuery,
      size: params.limit || 20,
      sort: [{ [timestampField]: { order: "desc" as const, unmapped_type: "date" as const } }],
    };
    debug(`ES query conditions: ${JSON.stringify(queryBody, null, 2)}`);
    const result = await esSearch(
      { host: logES.host, username: logES.username, password: logES.password },
      logES.indexPattern,
      queryBody
    );
    return result.hits.hits.map((hit) => ({ ...hit._source, _id: hit._id }));
  }
}
