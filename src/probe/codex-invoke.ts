// Codex probe of a procedure skill (D-W2-4). W2 codex track.
// Invoke leg: codexProbeBuild(all), assert userOnly(build.plugin, skill) (seam S2
// consumer), codexProbeInstall(build), then runCodexIn(home, `$ktx:<skill> <args>`).
// The assertion runs on the build, before Codex's CLI is spawned, so a build
// that does not mark the procedure user-only is refused without a harness run.
// Required checks:
//   injected — the rollout has a user-role message whose text starts
//              "<skill>\n<name>ktx:<skill></name>" (live L2): Codex itself loaded the body
//   answer   — the agent_message text matches every expect pattern
// Offer leg (when probe.offer is set): runCodex(offer.prompt). Required checks:
//   offer-hook-fired — a non-assistant rollout message contains [ktx:<skill>]
//   offered          — the agent_message text (never the hook's context) names
//                      invocation("codex", skill) as a whole command: a longer
//                      skill name, such as $ktx:swarm-build, does not name $ktx:swarm
//   not-started      — the agent_message text matches no expect pattern
// File leg (W3, D-W3-7) replaces the invoke leg when probe.file is set: the body
// uses tools, so runCodexIn(home, prompt, [], {sandbox: "workspace-write",
// cwd: probeProject(home.tmp)}) — Codex's own fence is cwd, /tmp and $TMPDIR with
// no network (W3 invariant 32); runCodexIn asserts the cwd is a probe project under
// home.tmp. It gets no readDirs: --add-dir widens workspace-write, so the owner's
// runbook roots stay out of the fence (runCodexIn refuses them there). The sandbox
// does not change the injection record, so W2's rollout fixtures
// (tests/probe-codex-invoke.test.ts, live L2) keep their shape. Required checks:
//   injected — as above
//   file     — fileCheck(project, probe.file, expect)
//   finished — the harness process ended on its own (exit code 0) after Codex's own
//              turn.completed event. A run killed at run()'s 600 s timeout (exitCode
//              null), or one that died mid-body, still leaves the file it wrote, so the
//              file alone is not proof it finished.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "../assert";
import { invocation, invokeTrigger, MARKERS_PLACEHOLDER, type Probe, type Skill } from "../skill";
import {
  codexProbeBuild, codexProbeInstall, fileCheck, isProbeProject, missingPatterns, namesCommand, parseLines, probeProject, runCodex, runCodexIn,
  type Check, type CodexHome, type CodexRun, type CodexRunOptions, type ProbeResult,
} from "../probe";
import { childrenCheck, recordsCheck, verdictCheck, waveArgs, waveMarkers } from "./wave";
import type { Locator } from "../../shared/scripts/transcripts";
import { userOnly } from "../translators/codex";

/** The text Codex writes before an injected SKILL.md (live L2). */
function injectionPrefix(skill: string): string {
  return `<skill>\n<name>ktx:${skill}</name>`;
}

/** The text of one rollout message payload, or "" when it carries none. */
function messageText(payload: any): string {
  const content = payload?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((c: any) => (typeof c?.text === "string" ? c.text : "")).join("");
}

/** A rollout message item; `role` narrows it (the hook's context lands as a developer message). */
function isMessage(item: any, role?: string): boolean {
  if (item?.type !== "response_item" || item?.payload?.type !== "message") return false;
  return role === undefined ? item.payload.role !== "assistant" : item.payload.role === role;
}

/** The model's own words: the agent_message items, never the context it was given. */
function modelText(events: any[]): string {
  return events
    .filter((e) => e?.type === "item.completed" && e.item?.type === "agent_message")
    .map((e) => String(e.item.text ?? ""))
    .join("\n");
}

/** Whether `text` matches every expect pattern, with the check's detail either way. */
function matches(text: string, expect: string[]): { ok: boolean; detail: string } {
  const missing = missingPatterns(text, expect);
  return { ok: !missing.length, detail: missing.length ? `missing: ${missing.join(", ")}` : "all expect patterns matched" };
}

/** The `injected` check, shared by both legs: Codex itself gave the model this skill's body (live L2). */
function injectedCheck(rollout: any[], skill: string): Check {
  const prefix = injectionPrefix(skill);
  const ok = rollout.some((item) => isMessage(item, "user") && messageText(item.payload).startsWith(prefix));
  return { name: "injected", ok, required: true, detail: `a user-role rollout message starts <skill> and names ktx:${skill}` };
}

export function evaluateCodexInvoke(events: any[], rollout: any[], skill: string, expect: string[]): Check[] {
  const answer = matches(modelText(events), expect);
  return [
    injectedCheck(rollout, skill),
    { name: "answer", ok: answer.ok, required: true, detail: answer.detail },
  ];
}

export function evaluateCodexOffer(events: any[], rollout: any[], skill: string, expect: string[]): Check[] {
  const marker = `[ktx:${skill}]`;
  const hook = rollout.some((item) => isMessage(item) && messageText(item.payload).includes(marker));
  const said = modelText(events);
  // Whole command only: `$ktx:swarm-build` does not name `$ktx:swarm` (namesCommand).
  const command = invocation("codex", skill);
  // Any expect pattern in the model's own text is a start, not an offer. The offer
  // prompt carries no arguments, so a model that starts the procedure anyway prints
  // the marker but not the args: one match is enough to fail `not-started`.
  const started = missingPatterns(said, expect).length < expect.length;
  return [
    { name: "offer-hook-fired", ok: hook, required: true, detail: `context given to the model contains ${marker}` },
    { name: "offered", ok: namesCommand(said, command), required: true, detail: `the model's own text names ${command} as a whole command` },
    { name: "not-started", ok: !started, required: true, detail: started ? "the model's own text matches an expect pattern: it started the procedure" : "no expect pattern in the model's own text" },
  ];
}

/** W3 file leg checks: injected, file (header). */
export function evaluateCodexInvokeFile(events: any[], rollout: any[], skill: string, project: string, file: string, expect: string[]): Check[] {
  // `events` carries the answer, which this leg does not judge (D-W3-7): the entry
  // the body left in the project is the evidence that it ran.
  void events;
  return [injectedCheck(rollout, skill), fileCheck(project, file, expect)];
}

/**
 * The `finished` check: the run ended on its own. `exitCode` is the harness
 * process's own (StreamRun), so null is a run `run()` killed at its 600 s timeout,
 * which can still have written the file the `file` check reads.
 */
function finishedCheck(exitCode: number | null, events: any[]): Check {
  // Codex's own turn record, like Kimi's end_turn and Claude's result event: a process
  // that exits 0 after a failed turn has still not finished the body. The last turn
  // event decides, so an earlier completed turn cannot vouch for a later one.
  const lastTurn = events.findLast((e) => typeof e?.type === "string" && e.type.startsWith("turn."));
  const turnCompleted = lastTurn?.type === "turn.completed";
  const detail = exitCode === null
    ? "the run did not finish: codex was killed (run()'s 600 s timeout)"
    : exitCode !== 0
      ? `the run did not finish: codex exited ${exitCode}`
      : turnCompleted
        ? "the run finished: codex exited 0 after turn.completed"
        : "the run did not finish: codex exited 0 with no turn.completed event";
  return { name: "finished", ok: exitCode === 0 && turnCompleted, required: true, detail };
}

/** Runs one Codex probe run. `runCodexIn` in every real probe; a test injects a fake, so no leg spawns Codex. */
export type CodexRunner = (home: CodexHome, prompt: string, readDirs: string[], opts: CodexRunOptions) => CodexRun;

/**
 * The file leg (D-W3-7) for a probe whose body uses tools: run it in a fresh probe
 * project under `home.tmp`, in Codex's own fence — workspace-write, which is cwd,
 * /tmp and $TMPDIR with no network (invariant 32) — and judge the injection record,
 * the file left behind and that the run finished. `run` is runCodexIn in every real
 * probe; a test injects a fake so the leg's arguments can be checked without spawning
 * Codex. `readDirs` is the owner's runbook roots, which every other leg passes on (a
 * read-only run may read them); this leg drops them, because --add-dir makes a dir
 * writable under workspace-write, and the body must not reach beyond its project.
 */
export function codexFileLeg(home: CodexHome, skill: Skill, probe: Probe, readDirs: string[], run: CodexRunner = runCodexIn): ProbeResult {
  const file = probe.file;
  assert(file !== undefined, `${skill.name}: the file leg needs probe.file (D-W3-7)`);
  const project = probeProject(home.tmp, probe.seed);
  // Seam S2 consumer: the fence is Codex's own sandbox, and workspace-write is only
  // as wide as cwd, so cwd must be a probe project under this home's tmp.
  assert(isProbeProject(project, home.tmp), `${skill.name}: the file leg's cwd ${project} is not a probe project under ${home.tmp}`);
  // A1: --add-dir widens workspace-write, so this run is handed no readDirs.
  void readDirs;
  const result = run(home, codexInvokePrompt(skill), [], { sandbox: "workspace-write", cwd: project });
  return {
    checks: [...evaluateCodexInvokeFile(result.events, result.rollout, skill.name, project, file, probe.expect), finishedCheck(result.exitCode, result.events)],
    raw: result.raw,
  };
}

/** What the probe types to start this procedure in Codex: `$ktx:<skill> <args>` (invariant 13). */
export function codexInvokePrompt(skill: Skill): string {
  assert(invokeTrigger(skill), `${skill.name}: codexInvokePrompt needs an invoke trigger`);
  return `${invocation("codex", skill.name)} ${skill.sidecar?.probe?.args ?? ""}`.trim();
}

/** Run the invoke leg, then the offer leg when probe.offer is set; checks from both, raw paths joined by ", ". */
export async function probeCodexInvoke(skill: Skill, allSkills: Skill[], readDirs: string[]): Promise<ProbeResult> {
  const probe = skill.sidecar?.probe;
  if (!probe) throw new Error(`${skill.name}: ktx.yaml has no probe`);
  const build = codexProbeBuild(allSkills);
  // A procedure the harness does not mark user-only would let the model start it
  // itself, so the probe stops here rather than reading that as a pass. This runs
  // before codexProbeInstall, so no Codex process is spawned for such a build.
  assert(userOnly(build.plugin, skill.name), `${skill.name}: probe build is not user-only (D-W2-3)`);
  const home = codexProbeInstall(build);
  // Wave leg (D-W4-7) and tools leg (D-W4-13) run as the file leg does, in a
  // throwaway project Codex may write to; the file leg (D-W3-7) judges a body that
  // reaches for tools by the file it leaves there, not by its answer.
  switch (codexProbeLeg(probe)) {
    case "wave": return codexWaveLeg(home, skill, probe);
    case "tools": return codexToolsLeg(home, skill, probe);
    case "file": return codexFileLeg(home, skill, probe, readDirs);
    default: break;
  }
  const run = runCodexIn(home, codexInvokePrompt(skill), readDirs);
  const checks = evaluateCodexInvoke(run.events, run.rollout, skill.name, probe.expect);
  if (!probe.offer) return { checks, raw: run.raw };
  const offer = runCodex(probe.offer.prompt, allSkills, readDirs);
  return { checks: [...checks, ...evaluateCodexOffer(offer.events, offer.rollout, skill.name, probe.expect)], raw: `${run.raw}, ${offer.raw}` };
}

// W4 codex track (D-W4-7, D-W4-13). Wave leg when probe.wave is set, tools leg
// when probe.tools is set; both run as the file leg does (runCodexIn with
// sandbox workspace-write and cwd probeProject(home.tmp), no --add-dir). A wave
// run writes one rollout per thread, so the leg reads every new rollout and
// pickParentRollout chooses the lead's. Before spawning, the seam S5 consumer
// asserts as for Claude.
// pickParentRollout: of the new rollouts, the one whose session_meta has no
//   parent_thread_id; null when there is not exactly one.
// evaluateCodexWave checks, all required:
//   injected — the parent rollout carries the ktx:<skill> injection (as W2)
//   spawned  — at least `members` distinct child rollouts whose session_meta
//              parent_thread_id is the parent's thread id. `codex exec --json`
//              never shows the spawn itself (invariant 33), and one call may start
//              several children, so children are counted, not calls (contract
//              lens B5); `events` is kept for the answer and the wait records.
// The leg appends finishedCheck(exitCode, events) (the exit code is the leg's, not
// the evaluator's, as codexFileLeg does; contract lens B4), the src/probe/wave.ts
// checks and `answer`.
// evaluateCodexTools checks, all required: injected, answer; the leg appends finished.

/**
 * A rollout's own header: the first `session_meta` line. Only the first decides:
 * a child's rollout repeats its parent's header further down (the fork it started
 * from), so a later line names the parent's thread, never this rollout's.
 */
function threadMeta(rollout: any[]): any | undefined {
  const payload = rollout.find((line) => line?.type === "session_meta")?.payload;
  return payload !== null && typeof payload === "object" ? payload : undefined;
}

/** This rollout's own thread id (invariant 25). */
function threadId(rollout: any[]): string | undefined {
  const id = threadMeta(rollout)?.id;
  return typeof id === "string" ? id : undefined;
}

/** The thread this rollout was spawned from, or null when it is a lead's own (invariant 25). */
function parentThread(rollout: any[]): string | null {
  const parent = threadMeta(rollout)?.parent_thread_id;
  return typeof parent === "string" ? parent : null;
}

/** Every rollout file a Codex home holds; a wave writes one per thread. [] before the home exists. */
function rolloutFiles(home: string): string[] {
  if (!existsSync(home)) return [];
  return [...new Bun.Glob("sessions/**/rollout-*.jsonl").scanSync({ cwd: home, absolute: true })];
}

/** The build's own transcript locator, scripts/locate.ts, as the built tree lays it out (D-W4-10). */
async function builtLocator(plugin: string, skill: string): Promise<Locator> {
  const path = join(plugin, "skills", skill, "scripts", "locate.ts");
  assert(existsSync(path), `${skill}: the build has no ${path} to locate this harness's transcripts`);
  return (await import(path)) as Locator;
}

/**
 * Of the rollouts one run wrote, the lead's own: the one whose header names no
 * `parent_thread_id`. A child's rollout repeats its parent's header below its own,
 * so only the first `session_meta` counts; a rollout without one cannot be
 * attributed and is not a candidate. null when there is not exactly one — several
 * parents (a nested run) or none.
 */
export function pickParentRollout(rollouts: any[][]): any[] | null {
  const parents = rollouts.filter((rollout) => threadId(rollout) !== undefined && parentThread(rollout) === null);
  return parents.length === 1 ? parents[0] : null;
}

export function evaluateCodexWave(events: any[], rollouts: any[][], skill: string, members: number): Check[] {
  // `events` carries the answer, which the leg judges; the spawn evidence is the
  // rollouts the harness wrote, not the stream (invariant 33).
  void events;
  const parent = pickParentRollout(rollouts);
  const parentId = parent ? threadId(parent) : undefined;
  // Children are counted, not calls: `codex exec --json` shows only the wait, and
  // one call starts one child, so the children under this parent are the spawns.
  const children = new Set<string>();
  for (const rollout of rollouts) {
    if (parentId === undefined || rollout === parent) continue;
    const id = threadId(rollout);
    if (id !== undefined && parentThread(rollout) === parentId) children.add(id);
  }
  const detail = parentId === undefined
    ? `the run left ${rollouts.length} rollouts, none of them a lead's: no rollout header without a parent_thread_id`
    : `${children.size} child rollouts name ${parentId} as their parent_thread_id; the wave wanted ${members}`;
  return [
    parent === null
      ? { name: "injected", ok: false, required: true, detail: `no rollout carries this skill's injection: it has no lead rollout to read (${detail})` }
      : injectedCheck(parent, skill),
    { name: "spawned", ok: children.size >= members, required: true, detail },
  ];
}

/** The tools leg's checks: the same two as the invoke leg, because the same two facts are the evidence (D-W4-13). */
export function evaluateCodexTools(events: any[], rollout: any[], skill: string, expect: string[]): Check[] {
  return evaluateCodexInvoke(events, rollout, skill, expect);
}

/** Which leg a probe runs (D-W4-7, D-W4-13). `checkProbe` keeps the three exclusive. */
export function codexProbeLeg(probe: Probe): "wave" | "tools" | "file" | "invoke" {
  if (probe.wave !== undefined) return "wave";
  if (probe.tools !== undefined) return "tools";
  if (probe.file !== undefined) return "file";
  return "invoke";
}

/**
 * The seams a wave leg crosses: the marker generator and the prompt substitution
 * (src/probe/wave.ts, seam S5), the harness run, the build's locator (D-W4-10) and
 * the three cross-checks the leg appends. They are parameters for the reason
 * codexFileLeg's `run` is — a test checks what the leg asks for without spawning
 * Codex, and without the gate track's modules, which land in parallel.
 */
export type CodexWaveSeams = {
  markers?: typeof waveMarkers;
  waveArgs?: typeof waveArgs;
  run?: CodexRunner;
  locator?: Locator;
  records?: typeof recordsCheck;
  children?: typeof childrenCheck;
  verdict?: typeof verdictCheck;
};

/**
 * The wave leg (D-W4-7): run the body as the file leg does — a throwaway project
 * under the probe home, Codex's own workspace-write fence, no --add-dir — with the
 * probe's `{markers}` replaced by `members` fresh markers, then judge the harness's
 * own spawn evidence and append the records, children and verdict checks and the
 * answer. Before the harness is spawned (seam S5 consumer): the markers number the
 * probe's members, and the substitution left no `{markers}` behind.
 */
export async function codexWaveLeg(home: CodexHome, skill: Skill, probe: Probe, seams: CodexWaveSeams = {}): Promise<ProbeResult> {
  const wave = probe.wave;
  assert(wave !== undefined, `${skill.name}: the wave leg needs probe.wave (D-W4-7)`);
  const markers = (seams.markers ?? waveMarkers)(wave.members);
  const args = (seams.waveArgs ?? waveArgs)(probe.args ?? "", markers);
  assert(markers.length === wave.members, `${skill.name}: the wave wants ${wave.members} markers, and ${markers.length} were made`);
  assert(!args.includes(MARKERS_PLACEHOLDER), `${skill.name}: the wave args still carry ${MARKERS_PLACEHOLDER}`);
  const project = probeProject(home.tmp);
  assert(isProbeProject(project, home.tmp), `${skill.name}: the wave leg's cwd ${project} is not a probe project under ${home.tmp}`);
  const locator = seams.locator ?? await builtLocator(home.plugin, skill.name);
  const before = new Set(rolloutFiles(home.home));
  const result = (seams.run ?? runCodexIn)(home, `${invocation("codex", skill.name)} ${args}`.trim(), [], { sandbox: "workspace-write", cwd: project });
  // Every rollout this run wrote, in file order: runCodexIn's own picker wants
  // exactly one new rollout and a wave writes one per thread, so the leg reads
  // the home itself and pickParentRollout names the lead's (D-W4-7).
  const rollouts = rolloutFiles(home.home).filter((file) => !before.has(file)).sort()
    .map((file) => parseLines(readFileSync(file, "utf8")));
  const answer = matches(modelText(result.events), probe.expect);
  return {
    checks: [
      ...evaluateCodexWave(result.events, rollouts, skill.name, wave.members),
      finishedCheck(result.exitCode, result.events),
      (seams.records ?? recordsCheck)(project, markers),
      (seams.children ?? childrenCheck)(project, markers, locator, home.env),
      await (seams.verdict ?? verdictCheck)(project, home.plugin, skill.name, home.env),
      { name: "answer", ok: answer.ok, required: true, detail: answer.detail },
    ],
    raw: result.raw,
  };
}

/**
 * The tools leg (D-W4-13): run the body in the same thrown-away project with tools
 * allowed and judge what it said, as the file leg judges what it left. `run` is
 * runCodexIn in every real probe; a test injects a fake, so no leg spawns Codex.
 */
export function codexToolsLeg(home: CodexHome, skill: Skill, probe: Probe, run: CodexRunner = runCodexIn): ProbeResult {
  assert(probe.tools !== undefined, `${skill.name}: the tools leg needs probe.tools (D-W4-13)`);
  const project = probeProject(home.tmp);
  assert(isProbeProject(project, home.tmp), `${skill.name}: the tools leg's cwd ${project} is not a probe project under ${home.tmp}`);
  const result = run(home, codexInvokePrompt(skill), [], { sandbox: "workspace-write", cwd: project });
  return {
    checks: [...evaluateCodexTools(result.events, result.rollout, skill.name, probe.expect), finishedCheck(result.exitCode, result.events)],
    raw: result.raw,
  };
}
