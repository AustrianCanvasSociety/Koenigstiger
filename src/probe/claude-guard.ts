// The file leg's PreToolUse hook entry (W3 D-W3-7). Claude runs it through bun
// before every Write/Edit/MultiEdit/NotebookEdit; it refuses each path that
// claudeWriteGuard does not find inside the probe project named by the
// KTX_PROBE_PROJECT env var, with the reason on stderr (Claude shows that to the
// model) and exit 2. Exit 0 lets the tool run. Probe-only: no installed plugin
// writes this hook.
import { claudeWriteGuard } from "./claude-invoke";

/** The PreToolUse event on stdin; anything unparsable becomes null, which the guard refuses. */
async function hookInput(): Promise<unknown> {
  try {
    return JSON.parse(await Bun.stdin.text());
  } catch {
    return null;
  }
}

/** Refuse with `reason` on stderr, as Claude Code reads it, and stop. */
function refuse(reason: string): never {
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

// A missing or empty KTX_PROBE_PROJECT means no fence was set up: without this the
// guard would resolve the write against its own cwd and allow every path under it,
// so the var is refused here rather than left to resolve("").
const project = process.env.KTX_PROBE_PROJECT ?? "";
if (project.trim() === "") refuse("ktx probe: write refused: KTX_PROBE_PROJECT names no probe project");

const decision = claudeWriteGuard(await hookInput(), project);
if (!decision.ok) refuse(decision.reason);
// Allowed: falling off the end is exit 0, so Claude runs the tool.
