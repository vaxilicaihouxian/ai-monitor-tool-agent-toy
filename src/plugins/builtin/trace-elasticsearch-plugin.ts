/**
 * Elasticsearch Trace Plugin
 */

import type { Plugin } from "../types.js";
import { ElasticsearchTraceDataSource } from "../../datasources/impl/trace-elasticsearch.js";

export const traceElasticsearchPlugin: Plugin = {
  name: "trace-elasticsearch",
  dataSources: [new ElasticsearchTraceDataSource()],
};
