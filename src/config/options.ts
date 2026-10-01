// The option store lives in shared/config/options.ts, where the config skill's script
// reaches it from an installed plugin. This file re-exports it for the CLI, the menu,
// install and doctor, and adds the one doctor check that reads the options.
import { existsSync, statSync } from "node:fs";
import { userHome, type Env } from "../install/paths";
import type { Step } from "../install/types";
import { ROOTS_KEY, rootsPath, type Options } from "../../shared/config/options";

export * from "../../shared/config/options";

/**
 * Doctor checks shared by every harness: the runbook folders the installed hook will search.
 * The hook reads $KTX_RUNBOOK_ROOTS when the harness was started with it set, else runbook-roots,
 * so both are checked when the variable is non-empty in the doctor's environment.
 */
export function checkRunbookRoots(env: Env, options: Options): Step[] {
  // howdoi.sh expands ~ in file lines ("${line/#\~/$HOME}") but not in the variable.
  const fileRoots = ((options[ROOTS_KEY] as string[] | undefined) ?? []).map((r) => r.replace(/^~/, userHome(env)));
  const steps = [rootsStep("runbook-roots", rootsPath(env), fileRoots)];
  // howdoi.sh uses the variable only when it is non-empty ([ -n "${KTX_RUNBOOK_ROOTS:-}" ]).
  if (env.KTX_RUNBOOK_ROOTS) {
    const step = rootsStep("runbook-roots-env", "$KTX_RUNBOOK_ROOTS", splitLikeBashRead(env.KTX_RUNBOOK_ROOTS));
    step.detail += " — overrides the file for any harness started from this shell";
    steps.push(step);
  }
  return steps;
}

/** Fields as `IFS=':' read -r -a <<<` yields them: first line only, empty fields kept except a single trailing one. */
function splitLikeBashRead(value: string): string[] {
  const fields = value.split("\n", 1)[0].split(":");
  if (fields.at(-1) === "") fields.pop();
  return fields;
}

function rootsStep(name: string, source: string, roots: string[]): Step {
  const present = roots.filter((r) => existsSync(r) && statSync(r).isDirectory());
  if (!roots.length) return { name, ok: false, detail: `none configured in ${source} — add folders with \`ktx config\`` };
  if (!present.length) return { name, ok: false, detail: `none of the ${roots.length} folders in ${source} exist: ${roots.join(", ")}` };
  const missing = roots.filter((r) => !present.includes(r));
  return { name, ok: true, detail: `${present.length} folder(s) in ${source}${missing.length ? `; missing: ${missing.join(", ")}` : ""}` };
}
