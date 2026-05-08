/**
 * Memory Module Unit Tests
 *
 * Uses Node.js built-in test runner, covering parseMemoryFile, renderMemoryFile,
 * addMemory, trimMemory, showMemory, cleanMemory, manualBackup,
 * executeMemoryCommand, loadMemoryForPrompt and other core functions.
 * All tests run in isolated temporary directories to avoid polluting user data.
 *
 * Run: npm test
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  type MemoryEntry,
  type MemoryConfig,
  parseMemoryFile,
  renderMemoryFile,
  addMemory,
  showMemory,
  cleanMemory,
  manualBackup,
  trimMemory,
  executeMemoryCommand,
  loadMemoryForPrompt,
} from "./memory.js";

// ─── Test Infrastructure ───

let testDir: string;
let testMemoryFile: string;

function setupTestDir() {
  testDir = join(tmpdir(), `omc-test-memory-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });
  testMemoryFile = join(testDir, "memory.md");
}

function cleanupTestDir() {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
}

// ─── Test Data ───

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    type: "preference",
    timestamp: "2026-05-01T14:30:00.000Z",
    title: "Test Memory",
    content: "Test content",
    ...overrides,
  };
}

const defaultConfig: MemoryConfig = {
  enabled: true,
  maxEntriesPerType: 20,
  maxCharsPerType: 10000,
};

// ─── parseMemoryFile Tests ───

describe("parseMemoryFile", () => {
  it("empty file returns empty array", () => {
    setupTestDir();
    try {
      writeFileSync(testMemoryFile, "", "utf-8");
      const result = parseMemoryFile(testMemoryFile);
      assert.deepEqual(result, []);
    } finally {
      cleanupTestDir();
    }
  });

  it("non-existent file returns empty array", () => {
    setupTestDir();
    try {
      const result = parseMemoryFile(join(testDir, "not-exist.md"));
      assert.deepEqual(result, []);
    } finally {
      cleanupTestDir();
    }
  });

  it("parses multiple memory entries", () => {
    setupTestDir();
    try {
      const md = `# Monitor CLI Memory

<!-- memory-entry -->
## [2026-05-01T14:30:00.000Z] Prioritize ERROR logs when troubleshooting
- type: preference
- tags: troubleshooting habit, logs
- - -
Prioritize filtering ERROR level logs when investigating alarms.
<!-- /memory-entry -->

<!-- memory-entry -->
## [2026-05-01T15:20:00.000Z] app-x OOM alarm investigation
- type: alarm_case
- appname: app-x
- tags: OOM, memory leak
- - -
Root cause was goroutine leak leading to continuous memory growth.
<!-- /memory-entry -->
`;
      writeFileSync(testMemoryFile, md, "utf-8");
      const result = parseMemoryFile(testMemoryFile);

      assert.equal(result.length, 2);
      assert.equal(result[0].type, "preference");
      assert.equal(result[0].title, "Prioritize ERROR logs when troubleshooting");
      assert.equal(result[0].timestamp, "2026-05-01T14:30:00.000Z");
      assert.deepEqual(result[0].tags, ["troubleshooting habit", "logs"]);
      assert.equal(result[0].content, "Prioritize filtering ERROR level logs when investigating alarms.");

      assert.equal(result[1].type, "alarm_case");
      assert.equal(result[1].title, "app-x OOM alarm investigation");
      assert.equal(result[1].appname, "app-x");
      assert.deepEqual(result[1].tags, ["OOM", "memory leak"]);
      assert.equal(result[1].content, "Root cause was goroutine leak leading to continuous memory growth.");
    } finally {
      cleanupTestDir();
    }
  });

  it("parses entries with optional fields", () => {
    setupTestDir();
    try {
      const md = `# Monitor CLI Memory

<!-- memory-entry -->
## [2026-05-01T14:30:00.000Z] Simple preference
- type: preference
- - -
Only content, no tags.
<!-- /memory-entry -->
`;
      writeFileSync(testMemoryFile, md, "utf-8");
      const result = parseMemoryFile(testMemoryFile);

      assert.equal(result.length, 1);
      assert.equal(result[0].title, "Simple preference");
      assert.equal(result[0].tags, undefined);
      assert.equal(result[0].appname, undefined);
      assert.equal(result[0].content, "Only content, no tags.");
    } finally {
      cleanupTestDir();
    }
  });
});

// ─── renderMemoryFile Tests ───

describe("renderMemoryFile", () => {
  it("renders to Markdown", () => {
    const entries: MemoryEntry[] = [
      makeEntry({
        type: "preference",
        title: "Prioritize checking logs",
        content: "Check logs first when investigating",
        tags: ["logs"],
      }),
    ];
    const result = renderMemoryFile(entries);

    assert.ok(result.startsWith("# OMC Memory\n"));
    assert.ok(result.includes("<!-- memory-entry -->"));
    assert.ok(result.includes("## [2026-05-01T14:30:00.000Z] Prioritize checking logs"));
    assert.ok(result.includes("- type: preference"));
    assert.ok(result.includes("- tags: logs"));
    assert.ok(result.includes("- - -"));
    assert.ok(result.includes("Check logs first when investigating"));
    assert.ok(result.includes("<!-- /memory-entry -->"));
  });

  it("rendered then parsed data is consistent (round-trip test)", () => {
    setupTestDir();
    try {
      const entries: MemoryEntry[] = [
        makeEntry({
          type: "preference",
          title: "Preference 1",
          content: "Content 1",
          tags: ["a", "b"],
        }),
        makeEntry({
          type: "alarm_case",
          title: "Case 1",
          content: "Content 2\nMulti-line content",
          appname: "app-x",
          tags: ["OOM"],
        }),
      ];

      const rendered = renderMemoryFile(entries);
      writeFileSync(testMemoryFile, rendered, "utf-8");
      const parsed = parseMemoryFile(testMemoryFile);

      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].type, entries[0].type);
      assert.equal(parsed[0].title, entries[0].title);
      assert.equal(parsed[0].content, entries[0].content);
      assert.deepEqual(parsed[0].tags, entries[0].tags);

      assert.equal(parsed[1].type, entries[1].type);
      assert.equal(parsed[1].title, entries[1].title);
      assert.equal(parsed[1].content, entries[1].content);
      assert.equal(parsed[1].appname, entries[1].appname);
      assert.deepEqual(parsed[1].tags, entries[1].tags);
    } finally {
      cleanupTestDir();
    }
  });
});

// ─── addMemory Tests ───

describe("addMemory", () => {
  it("adds entry to the head", () => {
    setupTestDir();
    try {
      const existing = makeEntry({ title: "Old memory", timestamp: "2026-05-01T10:00:00.000Z" });
      writeFileSync(testMemoryFile, renderMemoryFile([existing]), "utf-8");

      const newEntry = makeEntry({ title: "New memory", timestamp: "2026-05-01T14:00:00.000Z" });
      addMemory(newEntry, defaultConfig, testDir);

      const parsed = parseMemoryFile(testMemoryFile);
      assert.equal(parsed.length, 2);
      assert.equal(parsed[0].title, "New memory");
      assert.equal(parsed[1].title, "Old memory");
    } finally {
      cleanupTestDir();
    }
  });

  it("does not add duplicate with same title", () => {
    setupTestDir();
    try {
      const entry = makeEntry({ title: "Unique title" });
      addMemory(entry, defaultConfig, testDir);

      const dup = makeEntry({ title: "Unique title", content: "Different content" });
      const result = addMemory(dup, defaultConfig, testDir);

      assert.ok(result.includes("already exists with same title"));
      const parsed = parseMemoryFile(testMemoryFile);
      assert.equal(parsed.length, 1);
    } finally {
      cleanupTestDir();
    }
  });

  it("automatically backs up original file when adding", () => {
    setupTestDir();
    try {
      writeFileSync(testMemoryFile, renderMemoryFile([makeEntry({ title: "Original" })]), "utf-8");
      // Before adding, only memory.md exists
      const filesBefore = readdirSync(testDir).filter((f) => f.endsWith(".md"));
      assert.equal(filesBefore.length, 1);

      addMemory(makeEntry({ title: "Added" }), defaultConfig, testDir);

      // After adding, there is one more backup file
      const filesAfter = readdirSync(testDir).filter((f) => f.endsWith(".md"));
      assert.equal(filesAfter.length, 2);
      // Backup file starts with memory-202 (not memory.md)
      const backups = filesAfter.filter((f) => f !== "memory.md");
      assert.equal(backups.length, 1);
      assert.ok(backups[0].startsWith("memory-2"));
    } finally {
      cleanupTestDir();
    }
  });
});

// ─── trimMemory Tests ───

describe("trimMemory", () => {
  it("trims each type independently", () => {
    const entries: MemoryEntry[] = [
      ...Array.from({ length: 5 }, (_, i) => makeEntry({
        type: "preference",
        title: `Preference ${i}`,
        content: "Short",
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
      })),
      ...Array.from({ length: 5 }, (_, i) => makeEntry({
        type: "alarm_case",
        title: `Case ${i}`,
        content: "Short",
        appname: "app-x",
        timestamp: new Date(Date.now() - i * 60000).toISOString(),
      })),
    ];

    const config: MemoryConfig = { maxEntriesPerType: 3, maxCharsPerType: 10000 };
    const result = trimMemory(entries, config);

    const prefs = result.filter((e) => e.type === "preference");
    const cases = result.filter((e) => e.type === "alarm_case");

    assert.equal(prefs.length, 3);
    assert.equal(cases.length, 3);
    assert.equal(prefs[0].title, "Preference 0");
    assert.equal(cases[0].title, "Case 0");
  });

  it("trims oldest entries when count exceeds limit", () => {
    const entries: MemoryEntry[] = Array.from({ length: 5 }, (_, i) =>
      makeEntry({ title: `Entry ${i}`, content: "Short", timestamp: new Date(Date.now() - i * 60000).toISOString() })
    );

    const config: MemoryConfig = { maxEntriesPerType: 3, maxCharsPerType: 10000 };
    const result = trimMemory(entries, config);

    assert.equal(result.length, 3);
    assert.equal(result[0].title, "Entry 0");
    assert.equal(result[2].title, "Entry 2");
  });

  it("trims when character count exceeds limit", () => {
    const entries: MemoryEntry[] = [
      makeEntry({ title: "New", content: "a".repeat(100), timestamp: "2026-05-01T14:00:00.000Z" }),
      makeEntry({ title: "Old", content: "b".repeat(100), timestamp: "2026-05-01T10:00:00.000Z" }),
    ];

    const config: MemoryConfig = { maxEntriesPerType: 20, maxCharsPerType: 150 };
    const result = trimMemory(entries, config);

    assert.equal(result.length, 1);
    assert.equal(result[0].title, "New");
  });

  it("does not trim when within limits", () => {
    const entries: MemoryEntry[] = [
      makeEntry({ title: "Entry 1", content: "Short" }),
    ];

    const config: MemoryConfig = { maxEntriesPerType: 20, maxCharsPerType: 10000 };
    const result = trimMemory(entries, config);

    assert.equal(result.length, 1);
  });
});

// ─── showMemory Tests ───

describe("showMemory", () => {
  it("returns hint when no memory file exists", () => {
    setupTestDir();
    try {
      const result = showMemory(testDir);
      assert.equal(result, "No memories yet");
    } finally {
      cleanupTestDir();
    }
  });

  it("formats output when memories exist", () => {
    setupTestDir();
    try {
      const entries: MemoryEntry[] = [
        makeEntry({ type: "preference", title: "Preference 1", content: "Content 1", tags: ["a"] }),
        makeEntry({ type: "alarm_case", title: "Case 1", content: "Content 2", appname: "app-x", tags: ["OOM"] }),
      ];
      writeFileSync(testMemoryFile, renderMemoryFile(entries), "utf-8");

      const result = showMemory(testDir);
      assert.ok(result.includes("Preference 1"));
      assert.ok(result.includes("Case 1"));
      assert.ok(result.includes("app-x"));
    } finally {
      cleanupTestDir();
    }
  });
});

// ─── cleanMemory Tests ───

describe("cleanMemory", () => {
  it("returns hint when no file to clear", () => {
    setupTestDir();
    try {
      const result = cleanMemory(testDir);
      assert.ok(result.includes("nothing to clear"));
    } finally {
      cleanupTestDir();
    }
  });

  it("deletes file and creates backup after clearing", () => {
    setupTestDir();
    try {
      writeFileSync(testMemoryFile, renderMemoryFile([makeEntry()]), "utf-8");
      assert.ok(existsSync(testMemoryFile));

      const result = cleanMemory(testDir);
      assert.ok(!existsSync(testMemoryFile));
      assert.ok(result.includes("All memories cleared"));
      assert.ok(result.includes("backed up to"));
    } finally {
      cleanupTestDir();
    }
  });
});

// ─── manualBackup Tests ───

describe("manualBackup", () => {
  it("returns hint when no file to back up", () => {
    setupTestDir();
    try {
      const result = manualBackup(undefined, testDir);
      assert.ok(result.includes("cannot back up"));
    } finally {
      cleanupTestDir();
    }
  });

  it("generates backup file with manual- prefix and optional suffix", () => {
    setupTestDir();
    try {
      writeFileSync(testMemoryFile, "# test", "utf-8");

      const result = manualBackup("v1", testDir);
      assert.ok(result.includes("Backed up to"));
      assert.ok(result.includes("manual-"));
      assert.ok(result.includes("-v1.md"));

      // Also test without suffix
      const result2 = manualBackup(undefined, testDir);
      assert.ok(result2.includes("manual-"));
      assert.ok(!result2.includes("-v1.md") || result2 !== result);
    } finally {
      cleanupTestDir();
    }
  });
});

// ─── executeMemoryCommand Tests ───

describe("executeMemoryCommand", () => {
  it("add returns error when type is missing", () => {
    setupTestDir();
    try {
      const result = executeMemoryCommand({ subcommand: "add", title: "Test" }, defaultConfig, testDir);
      assert.ok(result.includes("missing type"));
    } finally {
      cleanupTestDir();
    }
  });

  it("add returns error when title is missing", () => {
    setupTestDir();
    try {
      const result = executeMemoryCommand({ subcommand: "add", type: "preference" }, defaultConfig, testDir);
      assert.ok(result.includes("missing title"));
    } finally {
      cleanupTestDir();
    }
  });

  it("add successfully returns success message", () => {
    setupTestDir();
    try {
      const result = executeMemoryCommand({
        subcommand: "add",
        type: "preference",
        title: "Test preference",
        content: "Test content",
      }, defaultConfig, testDir);
      assert.ok(result.includes("Memory added"), `Actual result: ${result}`);

      // Verify the file was actually written
      const parsed = parseMemoryFile(testMemoryFile);
      assert.equal(parsed.length, 1);
      assert.equal(parsed[0].title, "Test preference");
    } finally {
      cleanupTestDir();
    }
  });

  it("show returns hint when no memories", () => {
    setupTestDir();
    try {
      const result = executeMemoryCommand({ subcommand: "show" }, defaultConfig, testDir);
      assert.equal(result, "No memories yet");
    } finally {
      cleanupTestDir();
    }
  });

  it("clean clears all memories", () => {
    setupTestDir();
    try {
      executeMemoryCommand({
        subcommand: "add", type: "preference", title: "To be cleared", content: "Content",
      }, defaultConfig, testDir);
      assert.ok(existsSync(testMemoryFile));

      const result = executeMemoryCommand({ subcommand: "clean" }, defaultConfig, testDir);
      assert.ok(result.includes("All memories cleared"));
      assert.ok(!existsSync(testMemoryFile));
    } finally {
      cleanupTestDir();
    }
  });

  it("backup performs manual backup", () => {
    setupTestDir();
    try {
      executeMemoryCommand({
        subcommand: "add", type: "preference", title: "To be backed up", content: "Content",
      }, defaultConfig, testDir);

      const result = executeMemoryCommand({ subcommand: "backup", backupSuffix: "v2" }, defaultConfig, testDir);
      assert.ok(result.includes("Backed up to"));
      assert.ok(result.includes("manual-"));
      assert.ok(result.includes("-v2.md"));
    } finally {
      cleanupTestDir();
    }
  });
});

// ─── loadMemoryForPrompt Tests ───

describe("loadMemoryForPrompt", () => {
  it("returns empty string when not enabled", () => {
    assert.equal(loadMemoryForPrompt({ enabled: false }, testDir), "");
  });

  it("returns empty string when config is undefined", () => {
    assert.equal(loadMemoryForPrompt(undefined, testDir), "");
  });

  it("returns tool description even when enabled but no memories", () => {
    setupTestDir();
    try {
      const result = loadMemoryForPrompt(defaultConfig, testDir);
      assert.ok(result.includes("Long-term Memory"));
      assert.ok(result.includes("memory_save Tool"));
      assert.ok(result.includes("Memory Usage Rules"));
      assert.ok(!result.includes("Existing Memories"));
    } finally {
      cleanupTestDir();
    }
  });

  it("returns prompt text including memories when they exist", () => {
    setupTestDir();
    try {
      executeMemoryCommand({
        subcommand: "add",
        type: "preference",
        title: "Prompt preference test",
        content: "For prompt testing",
        tags: ["test"],
      }, defaultConfig, testDir);

      const result = loadMemoryForPrompt(defaultConfig, testDir);
      assert.ok(result.includes("Long-term Memory"));
      assert.ok(result.includes("memory_save Tool"));
      assert.ok(result.includes("Memory Usage Rules"));
      assert.ok(result.includes("Existing Memories"));
      assert.ok(result.includes("Prompt preference test"));
    } finally {
      cleanupTestDir();
    }
  });
});
