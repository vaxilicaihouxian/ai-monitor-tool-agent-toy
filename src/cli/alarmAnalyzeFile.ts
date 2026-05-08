/**
 * alarm-analyze-file non-interactive CLI entry
 * Usage: omc alarm-analyze-file <filePath>
 * Skip data collection, analyze the specified JSON file directly
 */

import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { analyzeAlarm, extractAppnameFromData, type AnalysisResult } from "../alarmAnalyzer.js";
import type { ExportData } from "../exporter.js";

/** Output analysis result */
function printAnalysisResult(result: AnalysisResult): void {
  if (result.type === "llm" && result.analysisText) {
    console.log(`\n=== LLM Analysis Result (analyzer: ${result.analyzerName}${result.contextName ? `, context: ${result.contextName}` : ""}) ===\n`);
    console.log(result.analysisText);
  } else if (result.statistics) {
    const stats = result.statistics;
    console.log("\n=== Statistical Summary ===");
    console.log(`Total logs: ${stats.totalLogs}`);

    const levelParts = Object.entries(stats.levelDistribution)
      .map(([level, count]) => `${level}: ${count}`);
    if (levelParts.length > 0) console.log(`  ${levelParts.join("  ")}`);

    if (stats.errorPatterns.length > 0) {
      console.log(`\nError Top ${stats.errorPatterns.length} patterns:`);
      for (let i = 0; i < stats.errorPatterns.length; i++) {
        const p = stats.errorPatterns[i];
        console.log(`  ${i + 1}. [${p.count} entries] ${p.pattern}`);
      }
    }

    if (stats.traceErrors.length > 0) {
      console.log("\nTrace anomalies:");
      for (const e of stats.traceErrors) {
        const rate = e.totalCount > 0 ? Math.round((e.errorCount / e.totalCount) * 100) : 0;
        console.log(`  - ${e.from} → ${e.to}: Error rate ${rate}%`);
      }
    }

    if (stats.slowCalls.length > 0) {
      console.log("\nLatency anomalies:");
      for (const c of stats.slowCalls) {
        console.log(`  - ${c.from} → ${c.to}: Average ${c.avgDurationMs}ms (P99: ${c.p99DurationMs}ms)`);
      }
    }
  }
}

/** alarm-analyze-file non-interactive main flow */
export async function runAlarmAnalyzeFileCli(configPath: string | undefined, filePath: string): Promise<void> {
  const config = loadConfig(configPath);

  if (!config.analysis) {
    throw new Error("analysis not configured, please configure analysis (analyzers/models) in ~/.omc.json");
  }

  // Read JSON file
  console.log(`⏳ Reading file: ${filePath}`);
  let exportData: ExportData;
  try {
    const raw = readFileSync(filePath, "utf-8");
    exportData = JSON.parse(raw) as ExportData;
  } catch (err) {
    throw new Error(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Extract appname from file data
  const appname = extractAppnameFromData(exportData);
  console.log(`📋 App: ${appname || "(unknown, will use statistical analysis)"}`);

  // Enter analysis phase
  console.log("⏳ Running intelligent analysis...");
  const result = await analyzeAlarm(appname, exportData, config.analysis, (msg) => console.log(`  → ${msg}`));
  printAnalysisResult(result);
}
