// Run-time requirements ktx doctor reports that no single harness owns (D-W4-2).
// W4 doctor track.
//
// bunStep: `swarm-build`, `swarm` and `swarm-gate` run their scripts with bun.
// Ok when an executable `bun` resolves on env.PATH (the env's own PATH, never
// process.env's); the detail names its absolute path. Not ok otherwise, with a
// detail saying the swarm procedures need bun. Never throws on a missing or empty
// PATH. The step is named "bun"; doctor reports it as a gap, and `ktx install`
// prints it as a warning that never refuses (D-W5-4).

import { accessSync, constants, statSync } from "node:fs";
import { basename, delimiter, resolve } from "node:path";
import type { Env } from "./paths";
import type { Step } from "./types";

/** The name the procedures need; the step's name is the same word. */
const BUN = "bun";
/**
 * The temp folder `bun run` puts first on the PATH of what it runs: bun-node-<hash>,
 * holding `bun` and `node` links (bun 1.4.2). A harness session never has it, so a
 * bun found only there is ktx's own launcher, not one the procedures can run.
 */
const BUN_RUN_SHIM = /^bun-node-[0-9a-f]+$/;

/** Whether a shell started with this PATH could run `path`: a regular file with the execute bit. */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * An absolute path to the first `bun` this PATH offers, or undefined when it offers none.
 * A PATH field that is empty is skipped rather than read as the working directory, which a
 * shell would do: a report promising absolute paths must not resolve against doctor's cwd.
 */
function findBun(path: string | undefined): string | undefined {
  for (const field of (path ?? "").split(delimiter)) {
    if (!field || BUN_RUN_SHIM.test(basename(resolve(field)))) continue;
    const candidate = resolve(field, BUN);
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

export function bunStep(env: Env): Step {
  const found = findBun(env.PATH);
  if (found) return { name: BUN, ok: true, detail: `bun at ${found}` };
  return {
    name: BUN,
    ok: false,
    detail: `${BUN} is not on PATH — the swarm procedures (swarm, swarm-build, swarm-gate) run their scripts with it`,
  };
}
