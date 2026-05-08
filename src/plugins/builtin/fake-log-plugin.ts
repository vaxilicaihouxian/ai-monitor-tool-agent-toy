/**
 * Fake log Plugin
 */

import type { Plugin } from "../types.js";
import { FakeLogDataSource } from "../../datasources/impl/fake-log.js";

export const fakeLogPlugin: Plugin = {
  name: "fake-log",
  dataSources: [new FakeLogDataSource()],
};
