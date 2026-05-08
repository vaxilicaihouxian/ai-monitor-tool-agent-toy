/**
 * Elasticsearch log Plugin
 */

import type { Plugin } from "../types.js";
import { ElasticsearchLogDataSource } from "../../datasources/impl/log-elasticsearch.js";

export const logElasticsearchPlugin: Plugin = {
  name: "log-elasticsearch",
  dataSources: [new ElasticsearchLogDataSource()],
};
