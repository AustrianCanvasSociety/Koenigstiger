// ktx's OpenCode plugin, installed as <config-dir>/plugins/ktx.ts (D-W5-2).
// OpenCode v2 loads it from the plugins dir with no imports needed (W5 invariants
// 4, 42) and calls setup(ctx) once per server.
//
// Seam S2 producer (D-W5-5, amended at the contract lens): a `prompt` hook spawns
//   bash <this dir>/../ktx/runtime/ktx-help.sh opencode
// on EVERY prompt — the runtime does the matching, with the same grep -E the
// other harnesses use; the plugin never pre-filters — with {"prompt": <text>}
// as JSON on stdin and a HOOK_TIMEOUT_MS (30 000 ms) bound (OpenCode sets none,
// W5 invariant 4; the build's HOOK_TIMEOUT_S is seconds, not this). It appends
// "\n\n" + the runtime's stdout to e.prompt.text only when stdout is non-empty
// and at most MAX_CONTEXT_BYTES. Every error, non-zero exit, timeout or oversize
// output leaves the prompt unchanged; the hook never throws (a throw in a hook is
// a defect, W5 invariant 4). A setup that cannot register says so on stderr and
// still returns (W-T2).
// promptHook(runtime, timeoutMs) is exported so tests can point it at a fake
// runtime and a short timeout; the default export wires the installed path.
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const HOOK_TIMEOUT_MS = 30_000;
/**
 * The most context one prompt may gain (W-T3). A runbook match is a few KB; output
 * past this is a defect in a trigger script, and it is dropped rather than cut, since
 * half a context block is worse than none. It also bounds what the spawn buffers.
 */
export const MAX_CONTEXT_BYTES = 64 * 1024;

/** The hook event: the mutable prompt draft, the one field ktx reads and edits (invariant 2). */
export type PromptEvent = { prompt: { text: string } };
/** The slice of OpenCode's plugin ctx ktx uses: register one hook, once per server. */
export type PluginCtx = { session: { hook(name: string, fn: (e: PromptEvent) => void): unknown } };

/**
 * Where install puts the runtime, relative to the plugin file's own directory
 * (invariant 42). `import.meta.dir` is Bun's; Node spells it `dirname` (W-T1).
 * Called inside setup's try, so a runtime with neither fails open, not at import.
 */
function runtimePath(): string {
  const dir = import.meta.dir ?? import.meta.dirname;
  if (typeof dir !== "string") throw new Error("no import.meta.dir or import.meta.dirname");
  return join(dir, "..", "ktx", "runtime", "ktx-help.sh");
}

/**
 * The prompt hook for a runtime script at `runtime`, bounded by `timeoutMs`:
 * spawn `bash <runtime> opencode` with the prompt on stdin and append "\n\n" +
 * its stdout when the script exited 0 with output. Every other outcome — no
 * output, a non-zero exit, a timeout, a spawn that never happened — leaves the
 * prompt exactly as it was; the hook never throws.
 */
export function promptHook(runtime: string, timeoutMs: number): (e: PromptEvent) => void {
  return (e) => {
    try {
      const run = spawnSync("bash", [runtime, "opencode"], {
        input: JSON.stringify({ prompt: e.prompt.text }),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: MAX_CONTEXT_BYTES + 1,
      });
      // Exit 0 only: a script killed at the timeout or one that failed may still
      // have written to stdout, and half a context block is worse than none.
      if (run.status !== 0) return;
      const context = run.stdout ?? "";
      if (!context || Buffer.byteLength(context) > MAX_CONTEXT_BYTES) return;
      e.prompt.text = `${e.prompt.text}\n\n${context}`;
    } catch {
      // Fail open: a broken trigger must never keep the user's prompt from the model.
    }
  };
}

export default {
  id: "ktx",
  async setup(ctx: PluginCtx): Promise<void> {
    try {
      // The recorded plugin awaits its registration; OpenCode awaits setup itself.
      await ctx.session.hook("prompt", promptHook(runtimePath(), HOOK_TIMEOUT_MS));
    } catch (err) {
      // Fail open: a plugin that cannot register must not stop OpenCode from starting,
      // but every ktx trigger is now off, so say so once (W-T2).
      console.error(`ktx: prompt triggers are off — the prompt hook did not register: ${(err as Error)?.message ?? err}`);
    }
  },
};
