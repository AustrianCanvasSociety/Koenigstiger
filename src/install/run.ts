// Every harness CLI call (claude plugin …, codex plugin …) goes through a Run,
// so adapters are tested against a fake and only the lead's live legs run the real CLIs.
import type { Env } from "./paths";

export type RunResult = { code: number; stdout: string; stderr: string };
export type Run = (cmd: string[], opts?: { env?: Env; cwd?: string }) => RunResult;

// A harness CLI that stalls (network, an unexpected prompt) is killed rather than hanging ktx.
const RUN_TIMEOUT_MS = 120_000;

/** A shell's exit code for a command it cannot find. */
const NOT_FOUND = 127;

export const realRun: Run = (cmd, opts = {}) => {
  let proc;
  try {
    proc = Bun.spawnSync(cmd, {
      timeout: RUN_TIMEOUT_MS,
      env: opts.env as Record<string, string> | undefined,
      cwd: opts.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    // Bun throws for a harness that is not installed. Answer as a failed call, so the
    // adapter reports its own step and keeps the steps it already took.
    if (!/not found/i.test((err as Error).message)) throw err;
    return { code: NOT_FOUND, stdout: "", stderr: `${cmd[0]} is not on PATH` };
  }
  return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
};
