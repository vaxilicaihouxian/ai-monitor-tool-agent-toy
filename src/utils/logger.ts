/**
 * Structured logging utility module
 *
 * Provides debug/info/warn/error four-level log output based on pino,
 * only writes to file /tmp/omc/log/ when OMC_DEBUG=1, otherwise silent.
 */
import pino from "pino";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const LOG_DIR = "/tmp/omc/log";

let logger: pino.Logger | null = null;

function getLogger(): pino.Logger {
  if (logger) return logger;

  // Non-debug mode: silent logger, no output
  if (!process.env.OMC_DEBUG) {
    logger = pino({ level: "silent" });
    return logger;
  }

  // Debug mode: write to file in /tmp/omc/log/
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }

  const logFile = join(LOG_DIR, `omc-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);

  logger = pino(
    { level: "debug" },
    pino.destination({ dest: logFile, sync: false, mkdir: true })
  );

  return logger;
}

/** Debug level log */
export function debug(msg: string, ...args: unknown[]) {
  getLogger().debug({ args: args.length > 0 ? args : undefined }, msg);
}

/** Info level log */
export function info(msg: string, ...args: unknown[]) {
  getLogger().info({ args: args.length > 0 ? args : undefined }, msg);
}

/** Warn level log */
export function warn(msg: string, ...args: unknown[]) {
  getLogger().warn({ args: args.length > 0 ? args : undefined }, msg);
}

/** Error level log */
export function error(msg: string, ...args: unknown[]) {
  getLogger().error({ args: args.length > 0 ? args : undefined }, msg);
}
