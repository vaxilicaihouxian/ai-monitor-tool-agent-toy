/**
 * Memory - Long-term Memory Module
 *
 * Records user preferences and historical alarm cases to assist Agent analysis.
 * Data is stored in ~/.omc/memory/memory.md in Markdown format.
 *
 * All file I/O functions support an optional baseDir parameter,
 * defaulting to ~/.omc/memory/, which can be overridden with a temp directory for testing.
 */

import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Type Definitions ───

export interface MemoryEntry {
  /** Memory type */
  type: "preference" | "alarm_case";
  /** Record timestamp, ISO format */
  timestamp: string;
  /** Short title */
  title: string;
  /** Detailed content */
  content: string;
  /** Associated tags */
  tags?: string[];
  /** alarm_case specific: associated application name */
  appname?: string;
}

export interface MemoryConfig {
  enabled?: boolean;
  maxEntriesPerType?: number;
  maxCharsPerType?: number;
}

// ─── Constants ───

const DEFAULT_MEMORY_DIR = join(homedir(), ".omc", "memory");
const MEMORY_FILENAME = "memory.md";

const ENTRY_START = "<!-- memory-entry -->";
const ENTRY_END = "<!-- /memory-entry -->";
const FILE_HEADER = "# OMC Memory\n";

// ─── Path Utilities ───

/** Resolve baseDir, defaults to ~/.omc/memory/ */
function resolveDir(baseDir?: string): string {
  return baseDir ?? DEFAULT_MEMORY_DIR;
}

/** Resolve full path to memory.md */
function resolveFile(baseDir?: string): string {
  return join(resolveDir(baseDir), MEMORY_FILENAME);
}

// ─── Public Path Functions (used by Shell.tsx) ───

export function getMemoryDir(): string {
  return DEFAULT_MEMORY_DIR;
}

export function getMemoryFilePath(): string {
  return join(DEFAULT_MEMORY_DIR, MEMORY_FILENAME);
}

export function ensureMemoryDir(baseDir?: string): void {
  mkdirSync(resolveDir(baseDir), { recursive: true });
}

// ─── Internal Utility Functions ───

/** Format timestamp to filename-safe format */
function formatTimestampForFile(date?: Date): string {
  const d = date ?? new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Format timestamp for display [YYYY-MM-DD HH:mm] */
function formatTimestampDisplay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ─── Parsing and Rendering ───

/**
 * Parse memory.md into MemoryEntry[]
 *
 * Splits by <!-- memory-entry --> ... <!-- /memory-entry --> markers,
 * extracting metadata lines and free-text content from each block.
 */
export function parseMemoryFile(filePath?: string): MemoryEntry[] {
  // Compatible: filePath can be a full file path, or omitted (uses default path)
  const path = filePath ?? resolveFile();
  if (!existsSync(path)) return [];

  const raw = readFileSync(path, "utf-8");
  if (!raw.trim()) return [];

  const entries: MemoryEntry[] = [];
  const blocks = raw.split(ENTRY_START);

  for (const block of blocks) {
    const endIdx = block.indexOf(ENTRY_END);
    if (endIdx === -1) continue;

    const content = block.slice(0, endIdx).trim();
    if (!content) continue;

    const lines = content.split("\n");
    const entry: Partial<MemoryEntry> = {};

    let bodyStartIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Title line: ## [timestamp] title
      if (line.startsWith("## ") && !entry.title) {
        const match = line.match(/^##\s+\[([^\]]+)\]\s+(.+)$/);
        if (match) {
          entry.timestamp = match[1];
          entry.title = match[2];
        }
        continue;
      }

      // Separator - - - marks end of metadata, start of body (must be checked before metadata parsing)
      if (line === "- - -") {
        bodyStartIdx = i + 1;
        break;
      }

      // Metadata line: - key: value
      if (line.startsWith("- ")) {
        const metaMatch = line.match(/^- (\w+):\s*(.*)$/);
        if (metaMatch) {
          const key = metaMatch[1];
          const val = metaMatch[2].trim();
          switch (key) {
            case "type":
              if (val === "preference" || val === "alarm_case") entry.type = val;
              break;
            case "tags":
              entry.tags = val ? val.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
              break;
            case "appname":
              entry.appname = val || undefined;
              break;
          }
        }
        continue;
      }
    }

    // Extract body text
    if (bodyStartIdx >= 0) {
      entry.content = lines.slice(bodyStartIdx).join("\n").trim();
    } else {
      entry.content = "";
    }

    if (entry.type && entry.title) {
      entries.push(entry as MemoryEntry);
    }
  }

  return entries;
}

/**
 * Render MemoryEntry[] into memory.md text
 */
export function renderMemoryFile(entries: MemoryEntry[]): string {
  const parts = [FILE_HEADER];

  for (const entry of entries) {
    const lines: string[] = [ENTRY_START];
    lines.push(`## [${entry.timestamp}] ${entry.title}`);
    lines.push(`- type: ${entry.type}`);
    if (entry.tags && entry.tags.length > 0) {
      lines.push(`- tags: ${entry.tags.join(", ")}`);
    }
    if (entry.appname) {
      lines.push(`- appname: ${entry.appname}`);
    }
    lines.push("- - -");
    if (entry.content) {
      lines.push(entry.content);
    }
    lines.push(ENTRY_END);
    parts.push(lines.join("\n"));
  }

  return parts.join("\n\n") + "\n";
}

// ─── Backup ───

/**
 * Back up the current memory.md
 * @param prefix Filename prefix, e.g. "clean-", "manual-"
 * @param suffix Optional suffix
 * @param baseDir Optional base directory, pass a temp directory for testing
 * @returns Backup file path, or null if no file to back up
 */
export function backupMemory(prefix: string = "", suffix?: string, baseDir?: string): string | null {
  const dir = resolveDir(baseDir);
  const memoryFile = join(dir, MEMORY_FILENAME);
  if (!existsSync(memoryFile)) return null;

  mkdirSync(dir, { recursive: true });
  const ts = formatTimestampForFile();
  const parts = ["memory", prefix, ts];
  const suffixPart = suffix ? `-${suffix}` : "";
  const backupName = parts.filter(Boolean).join("-") + suffixPart + ".md";
  const backupPath = join(dir, backupName);

  copyFileSync(memoryFile, backupPath);
  return backupPath;
}

// ─── Trimming ───

/**
 * Trim memory by entry count and character count limits
 * Groups by type, trims each group independently, removing from the end (oldest) first.
 */
export function trimMemory(entries: MemoryEntry[], config: MemoryConfig): MemoryEntry[] {
  const maxEntries = config.maxEntriesPerType ?? 20;
  const maxChars = config.maxCharsPerType ?? 10000;

  // Group by type
  const groups = new Map<string, MemoryEntry[]>();
  for (const entry of entries) {
    if (!groups.has(entry.type)) groups.set(entry.type, []);
    groups.get(entry.type)!.push(entry);
  }

  // Trim each group
  const trimmed = new Map<string, MemoryEntry[]>();
  for (const [type, group] of groups) {
    let result = [...group];

    // Trim by entry count (keep newest at the head)
    if (result.length > maxEntries) {
      result = result.slice(0, maxEntries);
    }

    // Trim by character count
    let totalChars = result.reduce((sum, e) => sum + (e.title.length + e.content.length), 0);
    while (totalChars > maxChars && result.length > 1) {
      const removed = result.pop()!;
      totalChars -= removed.title.length + removed.content.length;
    }

    trimmed.set(type, result);
  }

  // Merge in original order (keeping newer memories first)
  return entries.filter((e) => {
    const group = trimmed.get(e.type);
    return group && group.includes(e);
  });
}

// ─── Core Operations ───

/**
 * Add a memory entry
 * @param entry Memory entry
 * @param config Memory configuration
 * @param baseDir Optional base directory, pass a temp directory for testing
 * @returns Operation result text
 */
export function addMemory(entry: MemoryEntry, config: MemoryConfig, baseDir?: string): string {
  const dir = resolveDir(baseDir);
  const memoryFile = join(dir, MEMORY_FILENAME);
  mkdirSync(dir, { recursive: true });

  const existing = parseMemoryFile(memoryFile);

  // Check for entries with the same title
  if (existing.some((e) => e.title === entry.title)) {
    return `Memory already exists with same title: "${entry.title}", not added again`;
  }

  // Insert new entry at the head
  existing.unshift(entry);

  // Trim
  const trimmed = trimMemory(existing, config);

  // Back up the original file
  const backupPath = backupMemory("", undefined, baseDir);

  // Write
  writeFileSync(memoryFile, renderMemoryFile(trimmed), "utf-8");

  const location = backupPath ? `(auto-backed up to ${backupPath})` : "";
  return `Memory added: "${entry.title}" ${location}`;
}

/**
 * Display current memory contents
 * @param baseDir Optional base directory, pass a temp directory for testing
 */
export function showMemory(baseDir?: string): string {
  const entries = parseMemoryFile(resolveFile(baseDir));
  if (entries.length === 0) return "No memories yet";

  const preferenceEntries = entries.filter((e) => e.type === "preference");
  const alarmCaseEntries = entries.filter((e) => e.type === "alarm_case");

  const parts: string[] = [];

  if (preferenceEntries.length > 0) {
    parts.push("## User Preference Memories");
    for (const e of preferenceEntries) {
      const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
      parts.push(`- [${formatTimestampDisplay(e.timestamp)}] ${e.title}${tags}`);
      if (e.content) parts.push(`  ${e.content}`);
    }
  }

  if (alarmCaseEntries.length > 0) {
    parts.push("");
    parts.push("## Alarm Case Memories");
    for (const e of alarmCaseEntries) {
      const app = e.appname ? ` (${e.appname})` : "";
      const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
      parts.push(`- [${formatTimestampDisplay(e.timestamp)}] ${e.title}${app}${tags}`);
      if (e.content) parts.push(`  ${e.content}`);
    }
  }

  return parts.join("\n");
}

/**
 * Clear all memories
 * @param baseDir Optional base directory, pass a temp directory for testing
 */
export function cleanMemory(baseDir?: string): string {
  const memoryFile = resolveFile(baseDir);
  if (!existsSync(memoryFile)) return "No memory file exists, nothing to clear";

  // Back up
  const backupPath = backupMemory("clean-", undefined, baseDir);

  // Delete
  rmSync(memoryFile);

  const backupInfo = backupPath ? `, backed up to ${backupPath}` : "";
  return `All memories cleared${backupInfo}`;
}

/**
 * Manually back up memory file
 * @param suffix Optional suffix
 * @param baseDir Optional base directory, pass a temp directory for testing
 */
export function manualBackup(suffix?: string, baseDir?: string): string {
  const memoryFile = resolveFile(baseDir);
  if (!existsSync(memoryFile)) return "No memory file exists, cannot back up";

  const backupPath = backupMemory("manual-", suffix, baseDir);
  if (!backupPath) return "Backup failed";

  return `Backed up to ${backupPath}`;
}

// ─── Command Routing ───

export interface MemoryCommandParams {
  subcommand: "add" | "show" | "clean" | "backup";
  type?: "preference" | "alarm_case";
  title?: string;
  content?: string;
  tags?: string[];
  appname?: string;
  backupSuffix?: string;
}

/**
 * Execute a memory command and return formatted output text
 * @param baseDir Optional base directory, pass a temp directory for testing
 */
export function executeMemoryCommand(params: MemoryCommandParams, config: MemoryConfig, baseDir?: string): string {
  switch (params.subcommand) {
    case "add": {
      if (!params.type) return "Error: missing type parameter, usage: /memory add <preference|alarm_case> <title>";
      if (!params.title) return "Error: missing title parameter, usage: /memory add <preference|alarm_case> <title>";

      const entry: MemoryEntry = {
        type: params.type,
        timestamp: new Date().toISOString(),
        title: params.title,
        content: params.content || "",
      };
      if (params.tags && params.tags.length > 0) entry.tags = params.tags;
      if (params.type === "alarm_case" && params.appname) entry.appname = params.appname;

      return addMemory(entry, config, baseDir);
    }
    case "show":
      return showMemory(baseDir);
    case "clean":
      return cleanMemory(baseDir);
    case "backup":
      return manualBackup(params.backupSuffix, baseDir);
    default:
      return `Unknown subcommand: ${params.subcommand}, available: add / show / clean / backup`;
  }
}

// ─── Agent Prompt Loading ───

/**
 * Load memory content for Agent prompt
 * Includes: memory_save tool description + existing memory content + usage rules
 * Returns empty string when not enabled
 * @param baseDir Optional base directory, pass a temp directory for testing
 */
export function loadMemoryForPrompt(config?: MemoryConfig, baseDir?: string): string {
  if (!config?.enabled) return "";

  const entries = parseMemoryFile(resolveFile(baseDir));
  const preferenceEntries = entries.filter((e) => e.type === "preference");
  const alarmCaseEntries = entries.filter((e) => e.type === "alarm_case");

  const sections: string[] = [];

  // Tool usage guide (parameter descriptions are provided by the tool Schema automatically; this only explains when to use it)
  sections.push(`## memory_save Tool
Save long-term memories. You can proactively use it in the following scenarios:
- When the user explicitly expresses a preference or troubleshooting habit
- After completing a valuable alarm investigation
- Do not save duplicates if the same or highly similar content already exists in memory`);

  // Existing memory content
  if (entries.length > 0) {
    const parts: string[] = [];

    if (preferenceEntries.length > 0) {
      parts.push("### User Preference Memories");
      for (const e of preferenceEntries) {
        const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
        parts.push(`- [${formatTimestampDisplay(e.timestamp)}] ${e.title}${tags}`);
        if (e.content) parts.push(`  ${e.content}`);
      }
    }

    if (alarmCaseEntries.length > 0) {
      parts.push("");
      parts.push("### Alarm Case Memories");
      for (const e of alarmCaseEntries) {
        const app = e.appname ? ` | App: ${e.appname}` : "";
        const tags = e.tags?.length ? ` [${e.tags.join(", ")}]` : "";
        parts.push(`- [${formatTimestampDisplay(e.timestamp)}] ${e.title}${app}${tags}`);
        if (e.content) parts.push(`  ${e.content}`);
      }
    }

    sections.push(`### Existing Memories\n${parts.join("\n")}`);
  }

  // Usage rules
  sections.push(`### Memory Usage Rules
- Reference preferences and habits in memory to adjust your interaction style
- If memory contains cases similar to the current alarm, proactively mention them for reference
- Do not record duplicates if the same or highly similar content already exists in memory
- Keep records concise and avoid redundancy
- After an investigation is complete, save the case or user-expressed preferences with memory_save if valuable`);

  return `# Long-term Memory\n\n${sections.join("\n\n")}`;
}
