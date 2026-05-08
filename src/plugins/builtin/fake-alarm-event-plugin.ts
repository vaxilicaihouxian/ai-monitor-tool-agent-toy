/**
 * Fake alarm event Plugin
 */

import type { Plugin } from "../types.js";
import { FakeAlarmEventDataSource } from "../../datasources/impl/fake-alarm-event.js";

export const fakeAlarmEventPlugin: Plugin = {
  name: "fake-alarm-event",
  dataSources: [new FakeAlarmEventDataSource()],
};
