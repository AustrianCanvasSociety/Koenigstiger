// The environment record every ktx path resolves from, and ktx's own config folder.
// Kept in shared/ with the option store, so the config skill's script can read and
// write options from an installed plugin, where src/ does not exist.
import { homedir } from "node:os";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;
export type HarnessName = "claude" | "kimi" | "codex" | "opencode";
export const HARNESS_NAMES: HarnessName[] = ["claude", "kimi", "codex", "opencode"];

export function userHome(env: Env): string {
  return env.HOME || homedir();
}

/** ktx's config directory. Fixed under $HOME because the installed howdoi hook reads runbook-roots from here. */
export function configDir(env: Env): string {
  return join(userHome(env), ".config", "ktx");
}
