// OpenCode live probe, procedure leg (D-W5-13). `opencode run` does not expand a
// command (W5 invariant 44), so the leg reads the built commands/ktx/<n>.md,
// replaces $ARGUMENTS with the probe's args (expandCommand) and sends that
// text, in a probeProject (D-W3-7) inside the probe home.
// File leg checks: provider, user-only and command (seam S3 consumer: the built
// SKILL.md is userOnlyOpencode, the command body starts `/ktx/<n> $ARGUMENTS`,
// and the expanded text holds no $ARGUMENTS), finished, file (fileCheck).
// File-leg permissions: the project stays writable; allow read and
// external_directory on the probe home's skills/ dir; deny question, subagent,
// webfetch, websearch. Never --auto. Those rules do not see a path handed to a
// shell command, so every run in a probeProject (file, wave and tools legs) is
// spawned inside the sandbox-exec write fence (runOpencodeIn, ./fence.ts).
// The wave leg (D-W4-7, D-W6-5) runs the expanded command with `{markers}` replaced
// by fresh markers, in a probeProject, under wavePolicy (D-W6-2); its checks are
// loaded, spawned, finished, records, children, verdict, answer. The tools leg
// (D-W4-13) runs the expanded command in a probeProject under the file policy; its
// checks are loaded, finished, answer. Both follow the provider, user-only and
// command head. Seams (W6 § 6): W1 the wave policy → runOpencodeIn; W2 checkEnv →
// childrenCheck and verdictCheck (never home.env, D-W6-3); W3 the stream → spawned
// (distinct completed child session ids, D-W6-4); W4 probeOpencodeInvoke → the legs.
// A procedure with no probe (swarm-gate) throws "<skill>: ktx.yaml has no probe",
// as the sibling legs do — never an empty, passing check list.
// The prompt goes on stdin (W5 invariant 34, L13), so the admitted prompt starts
// with `/ktx/<n>` and ktx-help.sh's D-W2-6 prefix check holds headless too.
//
// The invoke leg is the same minus the project, with `answer` in place of `file`,
// and the offer leg (probe.offer) follows it: a prompt run of the offer prompt whose
// checks are offer-hook-fired (the run's export), offered (the model names the whole
// command) and not-started (no expect pattern in its own text). Both legs compose
// `provider` (S6) and `finished` (the process's exit code); the evaluators below
// judge what the stream, the export and the build alone can show.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { assert } from "../assert";
import { fileCheck, isProbeProject, namesCommand, probeProject, type Check, type ProbeResult } from "../probe";
import type { Locator } from "../../shared/scripts/transcripts";
import { invocation, invokeTrigger, MARKERS_PLACEHOLDER, type Probe, type Skill } from "../skill";
import { userOnlyOpencode } from "../translators/opencode";
import {
  answerCheck, answerText, checkEnv, clip, finalText, finishedCheck, hookFiredCheck, isCheck, okProviderCheck,
  opencodeProbeHome, probeProvider, runExport, runOpencodeIn, wavePolicy, type ExportRead, type OpencodeHome,
} from "./opencode";
import { childrenCheck, recordsCheck, verdictCheck, waveArgs, waveMarkers } from "./wave";

/** The command file's frontmatter block: what buildOpencode writes above the body (S3). */
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
/** The base directory a skill tool result names: OpenCode's own skill output (packages/core/src/skill.ts). */
const BASE_DIR = /Base directory for this skill: (.+)/;

/** The command body with $ARGUMENTS replaced by args (D-W5-13). */
export function expandCommand(text: string, args: string): string {
  // A function replacement, not a string one: arguments are inserted verbatim, so a
  // `$&` or `$1` inside them is never read as a replacement pattern.
  return text.replaceAll("$ARGUMENTS", () => args);
}

/** The `user-only` check (seam S3 consumer): the built SKILL.md hides the procedure from the model's list. */
export function userOnlyCheck(root: string, skill: string): Check {
  const ok = userOnlyOpencode(root, skill);
  return {
    name: "user-only",
    ok,
    required: true,
    detail: ok
      ? `${join(root, "skills", skill, "SKILL.md")} carries metadata.opencode/autoinvoke: false (invariant 43)`
      : `${skill}'s built SKILL.md carries no metadata.opencode/autoinvoke: false, so OpenCode would advertise the procedure to the model (invariant 43)`,
  };
}

/**
 * The `command` check (seam S3 consumer) and the prompt it yields: the built command
 * file's frontmatter is stripped and $ARGUMENTS replaced, which is the text the TUI
 * submits for `/ktx/<n>` (D-W5-13). A build whose file is missing, whose first body
 * line is not this skill's own invocation, or whose body is empty fails, and no
 * prompt is returned — a leg never sends half a command.
 */
export function commandCheck(root: string, skill: Skill, args: string): { check: Check; prompt: string } {
  const path = join(root, "commands", "ktx", `${skill.name}.md`);
  const fail = (detail: string): { check: Check; prompt: string } => ({ check: { name: "command", ok: false, required: true, detail }, prompt: "" });

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return fail(`${path} is missing or unreadable: the build has no command file for ${skill.name} (D-W5-6)`);
  }
  const frontmatter = text.match(FRONTMATTER);
  // OpenCode reads a command's description from its frontmatter; the body alone is
  // what the TUI submits, so the block is required and then dropped.
  if (!frontmatter) return fail(`${path} has no frontmatter block: OpenCode reads the command's description from one (D-W5-6)`);

  const body = text.slice(frontmatter[0].length);
  const first = body.split("\n")[0];
  const want = `/ktx/${skill.name} $ARGUMENTS`;
  if (first !== want) return fail(`${path}'s body starts ${JSON.stringify(first)}, not ${JSON.stringify(want)} (S3, D-W5-13)`);

  const prompt = expandCommand(body, args);
  // S3's consumer side: the text this leg sends starts with the invocation the hook
  // checks for (D-W2-6), which needs every placeholder gone.
  assert(!prompt.includes("$ARGUMENTS"), `opencode probe: ${path} still holds $ARGUMENTS after expandCommand (args: ${JSON.stringify(args)})`);
  return { check: { name: "command", ok: true, required: true, detail: `${path} starts ${JSON.stringify(first)} and expands to a ${prompt.length}-byte prompt for args ${JSON.stringify(args.slice(0, 40))}` }, prompt };
}

/** The `skill` tool calls of a run: the id each asked for and the directories each result names. */
function skillCalls(events: any[]): { id: string; dirs: string[] }[] {
  return events.flatMap((event) => {
    const part = event?.part;
    if (event?.type !== "tool_use" || part?.tool !== "skill") return [];
    const state = part.state ?? {};
    // A skill tool result reports the body's base directory twice: in its output text
    // (OpenCode's own toModelOutput line) and in its metadata, which survives the
    // tool-output truncator that a long body's text would not (invariant 10).
    const metadata = state.metadata?.metadata ?? state.metadata ?? {};
    const dirs = [
      typeof state.output === "string" ? state.output.match(BASE_DIR)?.[1]?.trim() : undefined,
      typeof metadata?.directory === "string" ? metadata.directory : undefined,
    ].filter((dir): dir is string => dir !== undefined && dir !== "");
    return [{ id: typeof state.input?.id === "string" ? state.input.id : "", dirs }];
  });
}

/** The path as the kernel spells it, when it exists: the two sides are written by different processes (macOS /var → /private/var, contract lens B8). */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The `loaded` check (invariants 8, 10, 14): the run's own skill tool call for this
 * skill loaded the probe build's copy — the body OpenCode reports a base directory
 * for. A call that names no directory, one for another skill, and one whose directory
 * is a same-named skill from another root all fail closed, and the detail names the
 * root that won so the owner can see the shadow.
 */
function loadedCheck(events: any[], skill: string, dir: string): Check {
  const mine = skillCalls(events).filter((call) => call.id === skill);
  // Both sides are real paths: ktx writes the build under a temp dir and OpenCode
  // reports whatever path it scanned, so the two spellings must be compared as one.
  const own = mine.filter((call) => call.dirs.some((found) => resolved(found) === resolved(dir)));
  const shadows = mine.filter((call) => !own.includes(call));
  const detail = !mine.length
    ? `the run made no skill tool call for ${skill}: the model never loaded the body`
    : shadows.length
      ? `OpenCode loaded ${skill} from ${shadows.flatMap((call) => (call.dirs.length ? call.dirs : ["(a result naming no base directory)"])).join(", ")}, not from the probe build's ${dir}`
      : `OpenCode loaded ${skill} from the probe build's ${dir}`;
  return { name: "loaded", ok: mine.length > 0 && shadows.length === 0, required: true, detail };
}

/** The invoke leg's checks: loaded, finished, answer (header). */
export function evaluateOpencodeInvoke(events: any[], exitCode: number | null, skill: string, dir: string, expect: string[]): Check[] {
  return [loadedCheck(events, skill, dir), finishedCheck(exitCode, events), answerCheck(answerText(events), expect)];
}

/** The file leg's checks: loaded, finished, file (header, D-W3-7). */
export function evaluateOpencodeInvokeFile(events: any[], exitCode: number | null, skill: string, dir: string, project: string, file: string, expect: string[]): Check[] {
  // The answer is not judged here: the entry the body left in its project is the
  // evidence that it ran (D-W3-7).
  return [loadedCheck(events, skill, dir), finishedCheck(exitCode, events), fileCheck(project, file, expect)];
}

/**
 * The offer leg's checks (header): offer-hook-fired (the run's export carries the
 * marker), offered (the model's own text names this harness's whole command), and
 * not-started (no expect pattern in that text — the offer prompt carries no
 * arguments, so a model that started the procedure prints the marker but not them).
 */
export function evaluateOpencodeOffer(events: any[], exported: ExportRead, skill: string, expect: string[]): Check[] {
  const said = answerText(events);
  const started = expect.some((p) => new RegExp(p, "i").test(said));
  const command = invocation("opencode", skill);
  return [
    hookFiredCheck(exported, skill, "offer-hook-fired"),
    // The whole command only: /ktx/swarm-build does not name /ktx/swarm (namesCommand).
    { name: "offered", ok: namesCommand(said, command), required: true, detail: `the model's own text names ${command} as a whole command: ${JSON.stringify(said.slice(0, 120))}` },
    { name: "not-started", ok: !started, required: true, detail: started ? "the model's own text matches an expect pattern: it started the procedure" : "no expect pattern in the model's own text" },
  ];
}

/** The runner a wave or tools leg spawns through: runOpencodeIn in every real probe; a test injects a fake, so no leg test spawns OpenCode. */
export type OpencodeRunner = typeof runOpencodeIn;

/**
 * The seams a wave leg crosses (D-W6-5), CodexWaveSeams' plus the check env: the
 * marker generator and the prompt substitution (wave.ts, seam S5), the run, the
 * build's locator, the three cross-checks, and the env those checks read (seam W2).
 */
export type OpencodeWaveSeams = {
  markers?: typeof waveMarkers;
  waveArgs?: typeof waveArgs;
  run?: OpencodeRunner;
  locator?: Locator;
  records?: typeof recordsCheck;
  children?: typeof childrenCheck;
  verdict?: typeof verdictCheck;
  env?: typeof checkEnv;
};

/** A child session id as OpenCode spells it: `ses_` and 26 characters of [0-9A-Za-z] (D-W6-4). */
const CHILD_SESSION_ID = /^ses_[0-9A-Za-z]{26}$/;
/** How many failed calls a `spawned` detail names before it counts the rest (T2). */
const FAILED_NAMED = 3;

/**
 * `spawned` (D-W6-4, seam W3): the distinct child session ids — `ses_` plus 26
 * characters of [0-9A-Za-z] — in `subagent` `tool_use` parts whose `state.status` and
 * `state.metadata.metadata.status` are both `completed`, read from
 * `state.metadata.metadata.sessionID`; ok when there are at least `members`. The detail
 * names the count found and wanted, and up to FAILED_NAMED failed calls (`state.status`
 * "error", invariant 3) by their clipped `state.error` text. Never throws on stream
 * data; a `members` that is not a positive integer is a caller bug and asserts.
 */
export function spawnedCheck(events: any[], members: number): Check {
  // The count the wave is judged on is the caller's to state: a zero, negative or
  // fractional one would pass a wave that spawned nothing (T1).
  assert(Number.isInteger(members), `spawnedCheck: ${members} is not a positive member count`);
  assert(members > 0, `spawnedCheck: ${members} is not a positive member count`);
  const ids = new Set<string>();
  const failed: string[] = [];
  for (const event of events) {
    const part = event?.part;
    if (event?.type !== "tool_use" || part?.tool !== "subagent") continue;
    const state = part.state ?? {};
    // Invariant 3: a failed call has no metadata to carry the child id, so it is
    // evidence for the owner, never a spawn.
    if (state.status === "error") {
      failed.push(typeof state.error === "string" && state.error !== "" ? state.error : "(no error text)");
      continue;
    }
    // Only a settled member counts (invariant 2: the stream prints the spawn once the
    // member has settled). A background member's call completes while its session runs
    // — `state.status` "completed" with `state.metadata.metadata.status` "running"
    // (subagent.ts:19-27, :264) — so both places must say completed. Only a well-formed
    // id counts too: a malformed one would inflate the count.
    const meta = state.metadata?.metadata;
    if (state.status !== "completed" || meta?.status !== "completed") continue;
    const id = meta.sessionID;
    if (typeof id === "string" && CHILD_SESSION_ID.test(id)) ids.add(id);
  }
  return {
    name: "spawned",
    ok: ids.size >= members,
    required: true,
    detail: `spawned ${ids.size} distinct child session ids; the wave wanted ${members}${failedNamed(failed)}`,
  };
}

/** `spawned`'s note on failed calls: how many, the first FAILED_NAMED by their clipped text, and how many it left out (T2). */
function failedNamed(failed: string[]): string {
  if (failed.length === 0) return "";
  const calls = failed.length === 1 ? "call" : "calls";
  const shown = failed.slice(0, FAILED_NAMED).map(clip).join("; ");
  const rest = failed.length > FAILED_NAMED ? ` and ${failed.length - FAILED_NAMED} more` : "";
  return `; ${failed.length} subagent ${calls} failed: ${shown}${rest}`;
}

/** The wave leg's own evidence from the run: loaded, spawned, finished (D-W6-5). */
export function evaluateOpencodeWave(events: any[], exitCode: number | null, skill: string, dir: string, members: number): Check[] {
  return [loadedCheck(events, skill, dir), spawnedCheck(events, members), finishedCheck(exitCode, events)];
}

/**
 * The build's transcript locator (D-W4-10): an OpenCode build ships
 * shared/scripts/locate.opencode.ts as scripts/locate.ts, which finds a member's
 * session in this home's own database. A build whose skill carries no locator, or one
 * belonging to another harness, is refused before the harness is spawned rather than
 * checking transcripts against the wrong home. Dynamic, because the file exists only
 * in a build.
 */
async function builtLocator(plugin: string, skill: string): Promise<Locator> {
  const path = join(plugin, "skills", skill, "scripts", "locate.ts");
  assert(existsSync(path), `${path}: the build ships no scripts/locate.ts, so no member transcript can be checked (D-W4-10)`);
  const mod: any = await import(path);
  assert(mod?.HARNESS === "opencode", `${path}: HARNESS is ${String(mod?.HARNESS)}, not opencode`);
  for (const fn of ["locate", "finalMessage", "model"]) {
    assert(typeof mod?.[fn] === "function", `${path}: ${fn} is not a function`);
  }
  return mod as Locator;
}

/**
 * The wave leg (D-W4-7, D-W6-5): asserts before spawning, as codexWaveLeg does —
 * probe.wave set, the markers number its members, no `{markers}` left in the args, a
 * probe project under home.tmp, the built `skills/<skill>/scripts/locate.ts` present
 * and declaring HARNESS "opencode" — then runs commandCheck's prompt for the wave args
 * under wavePolicy in that project, and returns evaluateOpencodeWave's checks, then
 * records, children and verdict (each given `(seams.env ?? checkEnv)(home, project)`,
 * asserted to hold the probe home's XDG_DATA_HOME — seam W2 consumer), then answer
 * (answerCheck over finalText: the run's final message, contract lens C-2).
 */
export async function opencodeWaveLeg(home: OpencodeHome, skill: Skill, probe: Probe, seams: OpencodeWaveSeams = {}): Promise<ProbeResult> {
  const wave = probe.wave;
  assert(wave !== undefined, `${skill.name}: the wave leg needs probe.wave (D-W4-7)`);
  // Seam S5 consumer: the markers and the prompt are built and asserted before the
  // harness is spawned, so a wave that cannot name its members never starts one.
  const markers = (seams.markers ?? waveMarkers)(wave.members);
  const args = (seams.waveArgs ?? waveArgs)(probe.args ?? "", markers);
  assert(markers.length === wave.members, `${skill.name}: the wave wants ${wave.members} markers, and ${markers.length} were made`);
  assert(!args.includes(MARKERS_PLACEHOLDER), `${skill.name}: the wave args still carry ${MARKERS_PLACEHOLDER}`);
  const project = probeProject(home.tmp);
  assert(isProbeProject(project, home.tmp), `${skill.name}: the wave leg's cwd ${project} is not a probe project under ${home.tmp}`);
  // Seam W4 consumer: the build's own locator, loaded and checked once, before the run.
  const locator = seams.locator ?? await builtLocator(home.plugin, skill.name);
  // D-W5-13: the prompt is the built command expanded with the probe's args and the
  // markers — the text the TUI submits for /ktx/<n>, never `invocation + args`.
  const command = commandCheck(home.plugin, skill, args);
  assert(command.check.ok, `${skill.name}: ${command.check.detail}`);
  // Seam W2 consumer: the cross-checks read the run's own env (D-W6-3, invariant 9).
  // home.env carries no XDG_* root, so a locator handed it would export from the
  // owner's own opencode.db. Read before the spawn: an env ktx refuses runs nothing.
  const env = (seams.env ?? checkEnv)(home, project);
  assert(env.XDG_DATA_HOME === join(home.tmp, "data"), `opencode probe: the wave leg's check env holds XDG_DATA_HOME ${String(env.XDG_DATA_HOME)}, not the probe home's ${join(home.tmp, "data")} (D-W6-3)`);
  // Seam W1 consumer: the wave's own rule set, handed over rather than inferred from
  // the cwd — a lead that cannot spawn would prove nothing about a wave.
  const result = (seams.run ?? runOpencodeIn)(home, command.prompt, [], project, wavePolicy(join(home.plugin, "skills")));
  const dir = join(home.plugin, "skills", skill.name);
  return {
    checks: [
      ...evaluateOpencodeWave(result.events, result.exitCode, skill.name, dir, wave.members),
      (seams.records ?? recordsCheck)(project, markers),
      (seams.children ?? childrenCheck)(project, markers, locator, env),
      await (seams.verdict ?? verdictCheck)(project, home.plugin, skill.name, env),
      // The run's final message, not every step's text (contract lens C-2).
      answerCheck(finalText(result.events), probe.expect),
    ],
    raw: result.raw,
  };
}

/**
 * The tools leg (D-W4-13, D-W6-5): asserts probe.tools set and a probe project under
 * home.tmp, runs commandCheck's prompt for `probe.args` there under the file policy
 * (runOpencodeIn with that cwd and no policy), and returns loaded, finished, answer
 * (answerCheck over finalText).
 */
export function opencodeToolsLeg(home: OpencodeHome, skill: Skill, probe: Probe, run: OpencodeRunner = runOpencodeIn): ProbeResult {
  assert(probe.tools !== undefined, `${skill.name}: the tools leg needs probe.tools (D-W4-13)`);
  const project = probeProject(home.tmp);
  assert(isProbeProject(project, home.tmp), `${skill.name}: the tools leg's cwd ${project} is not a probe project under ${home.tmp}`);
  const command = commandCheck(home.plugin, skill, probe.args ?? "");
  assert(command.check.ok, `${skill.name}: ${command.check.detail}`);
  // Invariant 16: no policy — runOpencodeIn gives a writing run the file policy, which
  // leaves the shell and edit the body's stage finder needs allowed and subagent denied.
  const result = run(home, command.prompt, [], project);
  const dir = join(home.plugin, "skills", skill.name);
  return {
    checks: [loadedCheck(result.events, skill.name, dir), finishedCheck(result.exitCode, result.events), answerCheck(finalText(result.events), probe.expect)],
    raw: result.raw,
  };
}

/** Probe a procedure skill in OpenCode. */
export async function probeOpencodeInvoke(skill: Skill, allSkills: Skill[], readDirs: string[]): Promise<ProbeResult> {
  const probe = skill.sidecar?.probe;
  if (!probe) throw new Error(`${skill.name}: ktx.yaml has no probe`);
  // A prompt-triggered skill is probed by probeOpencode; cli.ts routes on invokeTrigger,
  // so reaching here without one is a defect rather than a run to judge.
  assert(invokeTrigger(skill) !== undefined, `${skill.name}: a procedure probe needs an invoke trigger (ktx.yaml's on: invoke)`);
  // Seam S6 producer: without its two variables the leg answers one failing check and
  // runs nothing, so no home is built and no process is spawned (D-W5-12).
  const provider = probeProvider(process.env);
  if (isCheck(provider)) return { checks: [provider], raw: "" };

  const home = opencodeProbeHome(allSkills);
  const userOnly = userOnlyCheck(home.plugin, skill.name);
  const command = commandCheck(home.plugin, skill, probe.args ?? "");
  // Seam S3 consumer: both readings happen before the model is spawned, so a build
  // that is not user-only or whose command file is wrong never reaches a model.
  assert(userOnly.ok, `opencode probe: ${skill.name}: ${userOnly.detail}`);
  assert(command.check.ok, `opencode probe: ${skill.name}: ${command.check.detail}`);
  const head = [okProviderCheck(provider), userOnly, command.check];
  const dir = join(home.plugin, "skills", skill.name);

  // Seam W4: the legs get the home and the probe after the head, and return only their own checks.
  if (probe.wave !== undefined) {
    const leg = await opencodeWaveLeg(home, skill, probe);
    return { checks: [...head, ...leg.checks], raw: leg.raw };
  }
  if (probe.tools !== undefined) {
    const leg = opencodeToolsLeg(home, skill, probe);
    return { checks: [...head, ...leg.checks], raw: leg.raw };
  }

  if (probe.file !== undefined) {
    const project = probeProject(home.tmp, probe.seed);
    const run = runOpencodeIn(home, command.prompt, readDirs, project);
    return { checks: [...head, ...evaluateOpencodeInvokeFile(run.events, run.exitCode, skill.name, dir, project, probe.file, probe.expect)], raw: run.raw };
  }

  const run = runOpencodeIn(home, command.prompt, readDirs);
  const checks = [...head, ...evaluateOpencodeInvoke(run.events, run.exitCode, skill.name, dir, probe.expect)];
  if (!probe.offer) return { checks, raw: run.raw };

  // The offer leg: a prompt run of the offer prompt, judged on the export it leaves.
  const offer = runOpencodeIn(home, probe.offer.prompt, readDirs);
  return { checks: [...checks, ...evaluateOpencodeOffer(offer.events, runExport(home, offer.events), skill.name, probe.expect)], raw: `${run.raw}, ${offer.raw}` };
}
