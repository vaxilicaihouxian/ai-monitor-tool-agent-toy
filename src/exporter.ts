/**
 * Export utility: saves command execution parameters and results to a JSON file
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface ExportData {
  command: string;
  timestamp: string;
  params: Record<string, unknown>;
  results: Record<string, unknown>;
}

/**
 * Write export data to a file
 * @param dir User-specified directory, defaults to /tmp/omc/
 * @param data Data to export
 * @returns Absolute file path of the written file
 */
export function exportToFile(dir: string | undefined, data: ExportData): string {
  const targetDir = dir || "/tmp/omc";
  mkdirSync(targetDir, { recursive: true });

  const filename = `omc-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
  const filePath = join(targetDir, filename);

  writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  return filePath;
}
