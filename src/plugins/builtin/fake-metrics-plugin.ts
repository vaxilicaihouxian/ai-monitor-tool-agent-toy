/**
 * Fake metrics Plugin
 */

import type { Plugin } from "../types.js";
import { FakeMetricsDataSource } from "../../datasources/impl/fake-metrics.js";

export const fakeMetricsPlugin: Plugin = {
  name: "fake-metrics",
  dataSources: [new FakeMetricsDataSource()],
};
