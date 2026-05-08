/**
 * Fake log datasource — reads mock data from file, for debugging
 */

import { readFileSync } from "node:fs";
import type { DataSourceAvailability } from "../types.js";
import type { LogDataSource, LogQueryParams, LogQueryResult } from "../log.js";
import type { Config, FakePluginConfig } from "../../config.js";
import { getPluginConfig } from "../../config.js";

export class FakeLogDataSource implements LogDataSource {
  readonly id = { kind: "log" as const, name: "fake" };

  checkAvailability(config: unknown): DataSourceAvailability {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-log");
    if (!fakeConf?.filePath) {
      return { available: false, reason: "pluginsConfig.fake-log.filePath not configured" };
    }
    return { available: true };
  }

  async query(config: unknown, _params: LogQueryParams): Promise<LogQueryResult> {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-log")!;
    const content = readFileSync(fakeConf.filePath, "utf-8");
    return JSON.parse(content) as LogQueryResult;
  }
}
