// Swarm build conductor CLI — the stage finder, the wave gate and the transcript check.
//
//   bun <skill-dir>/scripts/cli.ts stage <project-root>
//   bun <skill-dir>/scripts/cli.ts gate <project-root> <wave>           (wave: W<N>)
//   bun <skill-dir>/scripts/cli.ts transcripts <project-root> <wave-id>  (D-W4-14)
//
// Exit codes: stage → 0 (informational); gate → 0 every check ok, 1 blocked;
// transcripts → 0 pass, 1 fail; 2 usage (unknown verb, missing argument, root
// not a directory, bad wave or wave id).
//
// transcripts (W4 gate track): load ./locate.ts beside this file (the build's own
// harness locator, D-W4-10), run checkTranscripts, write the verdict with
// writeVerdict, print `TRANSCRIPTS: wave=<id> result=<pass|fail> members=<n>` and
// one `TRANSCRIPTS: member=<agentId> ok=false detail=<why>` line per failing
// member. A wave id is one path segment: no "/", no "..", not empty.

import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWaveGate, nextStage } from "./gate";
import { checkTranscripts, isWaveId, writeVerdict, type Locator } from "./transcripts";

export function main(argv: string[], out: (line: string) => void = console.log, err: (line: string) => void = console.error): number {
  const [verb, rootArg, wave] = argv;
  const usage = "usage: cli.ts stage <project-root> | cli.ts gate <project-root> <W<N>> | cli.ts transcripts <project-root> <wave-id>";
  if (!rootArg || (verb !== "stage" && verb !== "gate" && verb !== "transcripts")) {
    err(usage);
    return 2;
  }
  const root = resolve(rootArg);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    err(`swarm-build: project root "${rootArg}" is not a directory`);
    return 2;
  }

  if (verb === "stage") {
    const next = nextStage(root);
    out(`STAGE: wave=${next.wave ?? "-"} next=${next.stage} name=${next.name} why=${next.why}`);
    return 0;
  }

  if (verb === "transcripts") {
    if (!wave || !isWaveId(wave)) {
      err(`swarm-build: wave id "${wave ?? ""}" is not one path segment`);
      return 2;
    }
    const locatorPath = join(dirname(fileURLToPath(import.meta.url)), "locate.ts");
    let locator: Locator;
    try {
      locator = createRequire(import.meta.url)(locatorPath) as Locator;
    } catch (e) {
      err(`swarm-build: cannot load the transcript locator ${locatorPath}: ${e instanceof Error ? e.message : String(e)}`);
      return 2;
    }
    const missing = (["locate", "finalMessage", "model"] as const).filter((k) => typeof locator?.[k] !== "function");
    if (missing.length > 0) {
      err(`swarm-build: ${locatorPath} exports no ${missing.join(", ")}`);
      return 2;
    }
    const verdict = checkTranscripts(root, wave, locator, process.env);
    writeVerdict(root, wave, verdict);
    out(`TRANSCRIPTS: wave=${wave} result=${verdict.result} members=${verdict.members.length}`);
    for (const member of verdict.members) if (!member.ok) out(`TRANSCRIPTS: member=${member.agentId} ok=false detail=${member.detail}`);
    return verdict.result === "pass" ? 0 : 1;
  }

  if (!wave || !/^W\d+$/.test(wave)) {
    err(`swarm-build: wave "${wave ?? ""}" is not W<N>`);
    return 2;
  }
  const gate = checkWaveGate(root, wave);
  for (const c of gate.checks) out(`GATE: wave=${wave} check=${c.id} state=${c.state} detail=${c.detail}`);
  out(`GATE: wave=${wave} result=${gate.complete ? "complete" : "blocked"}`);
  return gate.complete ? 0 : 1;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
