/**
 * Fake Trace datasource — reads mock data from file, for debugging
 */

import { readFileSync } from "node:fs";
import type { DataSourceAvailability } from "../types.js";
import type { TraceDataSource, TraceQueryParams, TraceQueryResult } from "../trace.js";
import type { Config, FakePluginConfig } from "../../config.js";
import { getPluginConfig } from "../../config.js";

export class FakeTraceDataSource implements TraceDataSource {
  readonly id = { kind: "trace" as const, name: "fake" };

  checkAvailability(config: unknown): DataSourceAvailability {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-trace");
    if (!fakeConf?.filePath) {
      return { available: false, reason: "pluginsConfig.fake-trace.filePath not configured" };
    }
    return { available: true };
  }

  async query(config: unknown, _params: TraceQueryParams): Promise<TraceQueryResult> {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-trace")!;
    const content = readFileSync(fakeConf.filePath, "utf-8");
    return JSON.parse(content) as TraceQueryResult;
  }
}
