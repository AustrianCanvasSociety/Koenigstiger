// What `ktx doctor` does when no harness is named and none is configured: instead of
// checking nothing, it runs every adapter's doctor, checks the harnesses ktx is
// installed in, and says where it is not (amends D-W5-14; installs stay opt-in, D-W5-3).
//
// The contract this leans on: an adapter's first doctor step is its presence step —
// Claude `marketplace`, Kimi `record`, Codex `plugin`, OpenCode `placed` — and it is
// not ok in a home ktx was never installed into (tests/discover.test.ts holds each
// adapter to it).
import type { HarnessName } from "./paths";
import type { Step } from "./types";

export type Found = { harness: HarnessName; installed: boolean; steps: Step[] };

/** Each harness's doctor steps, and whether its presence step says ktx is there. */
export function discover(names: HarnessName[], doctorOf: (harness: HarnessName) => Step[]): Found[] {
  return names.map((harness) => {
    try {
      const steps = doctorOf(harness);
      return { harness, installed: steps[0]?.ok === true, steps };
    } catch (err) {
      // A state file that cannot be read is something to report, not an absent install.
      return { harness, installed: true, steps: [{ name: "error", ok: false, detail: (err as Error).message }] };
    }
  });
}

/** The `harnesses` line: which harnesses were found and checked, or the gap of finding none. */
export function discoveryStep(found: Found[]): Step {
  const installed = found.filter((f) => f.installed).map((f) => f.harness);
  if (installed.length === 0) {
    return { name: "harnesses", ok: false, detail: "none configured and ktx is installed in no harness — run ktx install <harness>" };
  }
  return {
    name: "harnesses",
    ok: true,
    detail: `none configured; ktx found in ${installed.join(", ")} and checked there — ktx config set harnesses ${installed.join(",")} makes that the default`,
  };
}

/** The longest reason quoted on a `not installed` line; a harness CLI's error can run to paragraphs. */
const REASON_MAX = 160;

/**
 * The one line for a harness ktx is not in: not a gap, and it quotes the presence
 * step's reason (its first line, cut at REASON_MAX) so a broken install is not hidden.
 */
export function notInstalledStep(found: Found): Step {
  const first = found.steps[0];
  const line = first?.detail.split("\n")[0].trim() ?? "";
  const reason = line.length > REASON_MAX ? `${line.slice(0, REASON_MAX)}…` : line;
  const why = first ? ` (${first.name}: ${reason})` : "";
  const remedy = `run ktx install ${found.harness}`;
  // An adapter's own detail often ends with the same remedy; say it once.
  return { name: "installed", ok: true, detail: reason.includes(remedy) ? `not installed${why}` : `not installed${why} — ${remedy} to add it` };
}
