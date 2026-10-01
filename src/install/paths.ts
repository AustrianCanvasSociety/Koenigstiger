// Where ktx and each harness keep their files. Every path resolves from an Env
// record, so tests and throwaway runs point all of them at a temp directory.
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { assert } from "../assert";
import { userHome, type Env, type HarnessName } from "../../shared/config/env";

// The environment record, the harness names and ktx's own config folder sit in shared/
// with the option store, which the config skill's script runs from an installed plugin.
export { configDir, HARNESS_NAMES, userHome, type Env, type HarnessName } from "../../shared/config/env";

/**
 * The harness's own data root, honoring the override each harness documents.
 * OpenCode's is its config dir, where ktx's files land (D-W5-2; W5 invariant 19).
 */
export function harnessHome(harness: HarnessName, env: Env): string {
  const home = userHome(env);
  if (harness === "claude") return env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  if (harness === "kimi") return env.KIMI_CODE_HOME || join(home, ".kimi-code");
  if (harness === "codex") return env.CODEX_HOME || join(home, ".codex");
  // No catch-all: a harness added to the union without a branch must fail loudly (W5 invariant 35).
  assert(harness === "opencode", `harnessHome: unknown harness ${harness}`);
  return env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

/**
 * Claude Code's managed settings file, the one policy layer a machine-wide check can
 * read (code.claude.com/docs/en/managed-settings; MDM and server-delivered policy are
 * not files). KTX_CLAUDE_MANAGED_SETTINGS moves it, for tests and throwaway runs.
 */
export function claudeManagedSettings(env: Env): string {
  if (env.KTX_CLAUDE_MANAGED_SETTINGS) return env.KTX_CLAUDE_MANAGED_SETTINGS;
  if (process.platform === "darwin") return "/Library/Application Support/ClaudeCode/managed-settings.json";
  if (process.platform === "win32") return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  return "/etc/claude-code/managed-settings.json";
}

/** ktx's persistent build area; Claude runs its plugin in place from here, so it must outlive the install. */
export function dataDir(env: Env): string {
  if (env.KTX_DATA_HOME) return resolve(env.KTX_DATA_HOME);
  return join(env.XDG_DATA_HOME || join(userHome(env), ".local", "share"), "ktx");
}

/**
 * Whether a path a harness recorded names the same directory as ktx's. Existing paths compare
 * by realpath (macOS temp dirs sit behind /var -> /private/var); a missing path never matches.
 */
export function sameDir(recorded: string | undefined, expected: string): boolean {
  if (!recorded || !existsSync(recorded) || !existsSync(expected)) return false;
  return realpathSync(recorded) === realpathSync(expected);
}
