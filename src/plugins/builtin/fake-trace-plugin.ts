/**
 * Fake Trace Plugin
 */

import type { Plugin } from "../types.js";
import { FakeTraceDataSource } from "../../datasources/impl/fake-trace.js";

export const fakeTracePlugin: Plugin = {
  name: "fake-trace",
  dataSources: [new FakeTraceDataSource()],
};
