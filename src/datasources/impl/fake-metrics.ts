/**
 * Fake metrics datasource — reads mock data from file, for debugging
 */

import { readFileSync } from "node:fs";
import type { DataSourceAvailability } from "../types.js";
import type { MetricsDataSource, MetricsQueryParams, MetricsQueryResult } from "../metrics.js";
import type { Config, FakePluginConfig } from "../../config.js";
import { getPluginConfig } from "../../config.js";

export class FakeMetricsDataSource implements MetricsDataSource {
  readonly id = { kind: "metrics" as const, name: "fake" };

  checkAvailability(config: unknown): DataSourceAvailability {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-metrics");
    if (!fakeConf?.filePath) {
      return { available: false, reason: "pluginsConfig.fake-metrics.filePath not configured" };
    }
    return { available: true };
  }

  async query(config: unknown, _params: MetricsQueryParams): Promise<MetricsQueryResult> {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-metrics")!;
    const content = readFileSync(fakeConf.filePath, "utf-8");
    return JSON.parse(content) as MetricsQueryResult;
  }
}
