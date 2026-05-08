/**
 * Fake alarm event datasource — reads mock data from file, for debugging
 */

import { readFileSync } from "node:fs";
import type { DataSourceAvailability } from "../types.js";
import type { AlarmEventDataSource, AlarmEventQueryParams, AlarmEventQueryResult } from "../alarm-event.js";
import type { Config, FakePluginConfig } from "../../config.js";
import { getPluginConfig } from "../../config.js";

export class FakeAlarmEventDataSource implements AlarmEventDataSource {
  readonly id = { kind: "alarm-event" as const, name: "fake" };

  checkAvailability(config: unknown): DataSourceAvailability {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-alarm-event");
    if (!fakeConf?.filePath) {
      return { available: false, reason: "pluginsConfig.fake-alarm-event.filePath not configured" };
    }
    return { available: true };
  }

  async query(config: unknown, _params: AlarmEventQueryParams): Promise<AlarmEventQueryResult> {
    const c = config as Config;
    const fakeConf = getPluginConfig<FakePluginConfig>(c, "fake-alarm-event")!;
    const content = readFileSync(fakeConf.filePath, "utf-8");
    return JSON.parse(content) as AlarmEventQueryResult;
  }
}
