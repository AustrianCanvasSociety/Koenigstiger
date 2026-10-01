// The install / doctor seam every harness adapter implements (frozen in W1).
import type { Options } from "../config/options";
import type { Skill } from "../skill";
import type { Env } from "./paths";
import type { Run } from "./run";

/** One line of install or doctor output; `ktx doctor` exits non-zero when any step is not ok. */
export type Step = { name: string; ok: boolean; detail: string };

export type Ctx = {
  skills: Skill[]; // canonical skills from loadSkills
  env: Env; // resolves every path (paths.ts); a throwaway run points it at temp dirs
  run: Run; // harness CLI calls go through this, never Bun.spawn directly
  options: Options; // the user's ktx config
};

export type Installer = {
  /** Build, then register with the harness. Idempotent: running it again replaces a stale install. */
  install: (ctx: Ctx) => Step[];
  /** Read-only: one step per check, naming each gap (not installed, stale, hook missing or untrusted). */
  doctor: (ctx: Ctx) => Step[];
};
