/**
 * Prompt file loader
 *
 * Loads .md format prompt files with support for user custom overrides.
 *
 * Loading priority:
 * 1. User directory ~/.omc/prompts/<name>.md (highest priority, freely customizable)
 * 2. Bundled prompts/<name>.md (default version shipped with the package)
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Bundled prompt directory (src/prompts/, compiled to dist/prompts/) */
const BUNDLED_PROMPTS_DIR = join(__dirname, "prompts");

/** User custom prompt directory */
const USER_PROMPTS_DIR = join(homedir(), ".omc", "prompts");

/**
 * Load prompt file content
 *
 * @param name Prompt file name (without .md suffix)
 * @returns Prompt text content
 * @throws If the file is not found in either user or bundled directory
 */
export function loadPromptFile(name: string): string {
  // 1. Try user directory
  try {
    const userPath = join(USER_PROMPTS_DIR, `${name}.md`);
    return readFileSync(userPath, "utf-8");
  } catch {
    // User file not found, try bundled
  }

  // 2. Bundled prompt
  const bundledPath = join(BUNDLED_PROMPTS_DIR, `${name}.md`);
  return readFileSync(bundledPath, "utf-8");
}
