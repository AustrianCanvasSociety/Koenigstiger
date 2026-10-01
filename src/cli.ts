// ktx CLI.
//   ktx check                          validate every skill under skills/
//   ktx build <harness> --out <dir>    write the harness plugin to <dir>/ktx
//   ktx probe <harness> <skill>        live-test one skill in a headless harness run (a procedure: invoke it natively)
//   ktx install [<harness>...]         build and register with each harness (default: the configured harnesses;
//                                      none configured: name one — every install is opt-in, D-W5-3)
//   ktx doctor [<harness>...]          report every gap; exit 1 when any (default: the configured harnesses;
//                                      none configured: every harness ktx is found installed in)
//   ktx config                         options menu (needs a terminal)
//   ktx config list | get <key> | set <key> <value>
// Harnesses: claude, kimi, codex, opencode.
import { join } from "node:path";
import { invokeTrigger, loadSkills, type Skill } from "./skill";
import { buildClaude } from "./translators/claude";
import { buildKimi } from "./translators/kimi";
import { buildCodex } from "./translators/codex";
import { probeClaude, probeCodex, probeKimi, verdict, type ProbeResult } from "./probe";
import { probeClaudeInvoke } from "./probe/claude-invoke";
import { probeKimiInvoke } from "./probe/kimi-invoke";
import { probeCodexInvoke } from "./probe/codex-invoke";
import { buildOpencode } from "./translators/opencode";
import { probeOpencode } from "./probe/opencode";
import { probeOpencodeInvoke } from "./probe/opencode-invoke";
import { claudeInstaller } from "./install/claude";
import { discover, discoveryStep, notInstalledStep } from "./install/discover";
import { kimiInstaller } from "./install/kimi";
import { codexInstaller } from "./install/codex";
import { opencodeInstaller } from "./install/opencode";
import { HARNESS_NAMES, type HarnessName } from "./install/paths";
import { realRun } from "./install/run";
import { bunStep } from "./install/requirements";
import type { Ctx, Installer, Step } from "./install/types";
import { checkRunbookRoots, loadOptions, saveOptions } from "./config/options";
import { configCommand } from "../shared/config/command";
import { runMenu, terminalIO } from "./config/menu";

type Harness = {
  build: (skills: Skill[], out: string) => string;
  probe: (skill: Skill, all: Skill[], readDirs: string[]) => ProbeResult;
  probeInvoke: (skill: Skill, all: Skill[], readDirs: string[]) => Promise<ProbeResult>;
  installer: Installer;
};
const HARNESSES: Record<HarnessName, Harness> = {
  claude: { build: buildClaude, probe: probeClaude, probeInvoke: probeClaudeInvoke, installer: claudeInstaller },
  kimi: { build: buildKimi, probe: probeKimi, probeInvoke: probeKimiInvoke, installer: kimiInstaller },
  codex: { build: buildCodex, probe: probeCodex, probeInvoke: probeCodexInvoke, installer: codexInstaller },
  opencode: { build: buildOpencode, probe: probeOpencode, probeInvoke: probeOpencodeInvoke, installer: opencodeInstaller },
};

// D-W5-14: what `ktx install` says when no harness is named and none is configured.
const NO_HARNESS =
  "no harness named or configured — run ktx install <harness> or ktx config set harnesses <list>";

const SKILLS = join(import.meta.dir, "..", "skills");
const [verb, name, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(
    `usage: ktx check | ktx build <harness> --out <dir> | ktx probe <harness> <skill> | ktx install [<harness>...] | ` +
      `ktx doctor [<harness>...] | ktx config [list | get <key> | set <key> <value>]  (harness: ${HARNESS_NAMES.join(", ")})`,
  );
  process.exit(2);
}

/** Named harnesses, or the configured ones when none are named. */
function targets(args: string[], configured: string[]): HarnessName[] {
  const names = args.length ? args : configured;
  for (const n of names) if (!HARNESS_NAMES.includes(n as HarnessName)) usage();
  return names as HarnessName[];
}

function report(prefix: string, harness: string, steps: Step[]): number {
  for (const s of steps) console.log(`${prefix} harness=${harness} check=${s.name} ok=${s.ok} — ${s.detail}`);
  return steps.filter((s) => !s.ok).length;
}

try {
  const env = process.env;
  const harness = HARNESS_NAMES.includes(name as HarnessName) ? HARNESSES[name as HarnessName] : undefined;
  if (verb === "check") {
    for (const s of loadSkills(SKILLS)) console.log(`ok ${s.name}${s.sidecar ? " (+ktx.yaml)" : ""}`);
  } else if (verb === "build" && harness) {
    const out = rest[rest.indexOf("--out") + 1];
    if (!rest.includes("--out") || !out) usage();
    console.log(harness.build(loadSkills(SKILLS), out));
  } else if (verb === "probe" && harness) {
    const skills = loadSkills(SKILLS);
    const skill = skills.find((s) => s.name === rest[0]) ?? usage();
    // Runbook roots are granted read access so the model can open cited files.
    const readDirs = (env.KTX_RUNBOOK_ROOTS ?? "").split(":").filter(Boolean);
    const { checks, raw } = invokeTrigger(skill)
      ? await harness.probeInvoke(skill, skills, readDirs)
      : harness.probe(skill, skills, readDirs);
    for (const c of checks) {
      console.log(`PROBE harness=${name} skill=${skill.name} check=${c.name} ok=${c.ok} required=${c.required} — ${c.detail}`);
    }
    const v = verdict(checks);
    console.log(`PROBE harness=${name} skill=${skill.name} result=${v} stream=${raw}`);
    process.exit(v === "pass" ? 0 : 1);
  } else if (verb === "install" || verb === "doctor") {
    const options = loadOptions(env);
    const ctx: Ctx = { skills: loadSkills(SKILLS), env, run: realRun, options };
    const prefix = verb.toUpperCase();
    let gaps = 0;
    const chosen = targets([name, ...rest].filter(Boolean) as string[], options.harnesses as string[]);
    // Every install is opt-in (D-W5-3): nothing named and nothing configured installs nothing.
    if (verb === "install" && chosen.length === 0) throw new Error(NO_HARNESS);
    if (verb === "doctor") {
      gaps += report(prefix, "all", checkRunbookRoots(env, options));
      // The swarm procedures run their scripts with bun (D-W4-2).
      gaps += report(prefix, "all", [bunStep(env)]);
      if (chosen.length === 0) {
        // Nothing named or configured: look for ktx in every harness, check the ones that
        // have it, and say where it is not (install/discover.ts) — never an empty "ok".
        const found = discover(HARNESS_NAMES, (h) => HARNESSES[h].installer.doctor(ctx));
        gaps += report(prefix, "all", [discoveryStep(found)]);
        for (const f of found) gaps += report(prefix, f.harness, f.installed ? f.steps : [notInstalledStep(f)]);
      }
    } else {
      // D-W5-4: install warns about a missing bun and never refuses; the warning is not a gap.
      const bun = bunStep(env);
      if (!bun.ok) console.log(`${prefix} warning=bun — ${bun.detail}; swarm-build and swarm-gate will not run until bun is on PATH`);
    }
    for (const h of chosen) {
      const inst = HARNESSES[h].installer;
      // One harness failing (a malformed state file, say) must not hide the others' results.
      let steps: Step[];
      try {
        steps = verb === "install" ? inst.install(ctx) : inst.doctor(ctx);
      } catch (err) {
        steps = [{ name: "error", ok: false, detail: (err as Error).message }];
      }
      gaps += report(prefix, h, steps);
    }
    console.log(`${prefix} result=${gaps ? "gaps" : "ok"} gaps=${gaps}`);
    process.exit(gaps ? 1 : 0);
  } else if (verb === "config") {
    if (!name) {
      if (!process.stdin.isTTY) usage();
      const io = terminalIO();
      // NO_COLOR (no-color.org): any non-empty value asks for no colour.
      const edited = await runMenu(io, loadOptions(env), Boolean(env.NO_COLOR)).finally(() => io.close());
      if (edited) saveOptions(env, edited);
      console.log(edited ? "ktx: options saved" : "ktx: no changes saved");
    } else {
      const lines = configCommand(env, [name, ...rest]);
      if (lines === null) usage();
      console.log(lines.join("\n"));
    }
  } else {
    usage();
  }
} catch (err) {
  console.error(`ktx: ${(err as Error).message}`);
  process.exit(2);
}
