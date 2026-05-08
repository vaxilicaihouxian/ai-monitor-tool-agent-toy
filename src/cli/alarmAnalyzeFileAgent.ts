/**
 * alarm-analyze-file-agent non-interactive CLI entry
 * Usage: omc alarm-analyze-file-agent <filePath> [--llm-input-file <path>]
 * Phase 1: Same file reading + LLM analysis as alarm-analyze-file
 * Phase 2: Launch agent deep analysis + conversation based on analysis results
 */

import { readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { analyzeAlarm, extractAppnameFromData } from "../alarmAnalyzer.js";
import type { ExportData } from "../exporter.js";
import { runAgentAnalysis } from "../agentRunner.js";

/** alarm-analyze-file-agent non-interactive main flow */
export async function runAlarmAnalyzeFileAgentCli(
  configPath: string | undefined,
  filePath: string,
  llmInputFile?: string
): Promise<void> {
  const config = loadConfig(configPath);

  if (!config.agentModel) {
    throw new Error("agentModel not configured, please configure agentModel in ~/.omc.json or set environment variables AGENT_MODEL_*");
  }

  let initialPrompt: string;

  if (llmInputFile) {
    // Load initial prompt from file directly, skip Phase 1
    console.log(`📄 Loading initial prompt from file: ${llmInputFile}`);
    initialPrompt = readFileSync(llmInputFile, "utf-8");
  } else {
    // Execute Phase 1: Same as runAlarmAnalyzeFileCli
    if (!config.analysis) {
      throw new Error("analysis not configured, please configure analysis (analyzers/models) in ~/.omc.json");
    }

    console.log(`⏳ Reading file: ${filePath}`);
    let exportData: ExportData;
    try {
      const raw = readFileSync(filePath, "utf-8");
      exportData = JSON.parse(raw) as ExportData;
    } catch (err) {
      throw new Error(`Cannot read file: ${err instanceof Error ? err.message : String(err)}`);
    }

    const appname = extractAppnameFromData(exportData);
    console.log(`📋 App: ${appname || "(unknown, will use statistical analysis)"}`);

    console.log("⏳ Running intelligent analysis...");
    const result = await analyzeAlarm(appname, exportData, config.analysis, (msg) => console.log(`  → ${msg}`));

    if (result.type === "statistics") {
      console.log("\n⚠️  Analysis result is statistical summary (no LLM analysis), cannot start Agent deep analysis");
      return;
    }

    initialPrompt = `## LLM Input\n\n${result.llmInput || ""}\n\n## LLM Analysis Conclusion\n\n${result.analysisText || ""}`;
  }

  // Phase 2: Start Agent
  console.log("\n=== Phase 1 complete, starting Agent deep analysis ===\n");
  await runAgentAnalysis({ config, initialPrompt });
}
