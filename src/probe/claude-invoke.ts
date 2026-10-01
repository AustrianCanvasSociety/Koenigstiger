// Claude Code probe of a procedure skill (D-W2-4). W2 claude track.
// Invoke leg: claudeProbeBuild(all), assert userOnly(build.plugin, skill) (seam S2
// consumer), then runClaudeIn(build, `/ktx:<skill> <args>`). Required checks:
//   listed   — init slash_commands has ktx:<skill>
//   expanded — the run has no tool_use block at all: the harness expanded the body
//              before the model ran (live L1, L5). A Skill call (L8) or a file read
//              of the body (L4's route) fails it. A probed procedure's body must
//              therefore be answerable without tools, as skills/selftest is.
//   answer   — the result text matches every expect pattern
// Offer leg (when probe.offer is set): runClaude(offer.prompt). Required checks:
//   offer-hook-fired — a UserPromptSubmit hook_response (exit 0) whose stdout has [ktx:<skill>]
//   offered          — the result text (the model's answer only, never hook output)
//                      contains invocation("claude", skill)
//   not-started      — the result text matches no expect pattern
// File leg (W3, D-W3-7) replaces the invoke leg when probe.file is set: the body
// uses tools, so runClaudeFile runs it in probeProject(build.tmp) as cwd, inside a
// fence. It keeps runClaudeIn's flags (--plugin-dir, --setting-sources project,
// --output-format stream-json --verbose --include-hook-events) and replaces
// --allowedTools with: --permission-mode bypassPermissions (the only mode that
// allows a .claude/ write, W3 invariant 26) and --settings holding sandbox
// {enabled: true, allowUnsandboxedCommands: false}, a PreToolUse hook on
// Write|Edit|MultiEdit|NotebookEdit running src/probe/claude-guard.ts (exit 2 when
// claudeWriteGuard refuses), and a UserPromptExpansion hook that echoes its stdin
// (live LC1, invariant 27). A writing run grants nothing beyond its project, so it
// passes no readDirs: --add-dir would widen the sandbox's writable set while the
// run holds bypassPermissions (runClaudeFile asserts that). Hooks run with
// process.execPath (bun); the project reaches the guard through the
// KTX_PROBE_PROJECT env var. No new dependency.
// Required checks:
//   listed   — as above
//   loaded   — a UserPromptExpansion hook_response whose stdout carries
//              "command_name":"ktx:<skill>": the harness expanded the body (LC1);
//              tool calls after it are allowed
//   finished — a result event with subtype "success" and no is_error: the harness
//              ends the run with it, so a run killed at run()'s 600 s timeout after
//              writing the file fails here instead of passing on the file alone
//   file     — fileCheck(project, probe.file, expect)
import { existsSync, lstatSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { Locator } from "../../shared/scripts/transcripts";
import { assert } from "../assert";
import { claudeProbeBuild, fileCheck, isProbeProject, missingPatterns, namesCommand, probeProject, run, runClaude, runClaudeIn, type Check, type ClaudeBuild, type PluginRun, type ProbeResult } from "../probe";
import { childrenCheck, recordsCheck, verdictCheck, waveArgs, waveMarkers } from "../probe/wave";
import { invocation, MARKERS_PLACEHOLDER, type Probe, type Skill } from "../skill";
import { PLUGIN_NAME, userOnly } from "../translators/claude";

/** Every tool_use block in the stream: the evidence that the body did not arrive by expansion. */
function toolCalls(events: any[]): any[] {
  return events
    .flatMap((e) => (Array.isArray(e.message?.content) ? e.message.content : []))
    .filter((c: any) => c?.type === "tool_use");
}

/** Whether init's slash_commands lists `command`: the harness lists the user-facing form, the leading slash is presentation. */
function listsCommand(events: any[], command: string): boolean {
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const commands = Array.isArray(init?.slash_commands) ? init.slash_commands : [];
  return commands.some((c: unknown) => String(c).replace(/^\//, "") === command);
}

/** The model's answer: only a result event carries it, so hook output can never satisfy a check. */
function answer(events: any[]): string {
  return String(events.find((e) => e.type === "result")?.result ?? "");
}

export function evaluateClaudeInvoke(events: any[], skill: string, expect: string[]): Check[] {
  const command = `${PLUGIN_NAME}:${skill}`;
  const listed = listsCommand(events, command);
  const calls = toolCalls(events);
  const missing = missingPatterns(answer(events), expect);

  // On an empty or truncated run `expanded` is true and `listed` and `answer` are
  // false, so the required checks still fail the probe closed (invariant 2).
  return [
    { name: "listed", ok: listed, required: true, detail: `init slash_commands has ${command}` },
    {
      name: "expanded",
      ok: calls.length === 0,
      required: true,
      detail: calls.length ? `the run called ${calls.map((c: any) => String(c.name)).join(", ")}` : "no tool call at all",
    },
    { name: "answer", ok: missing.length === 0, required: true, detail: missing.length ? `missing: ${missing.join(", ")}` : "all expect patterns matched" },
  ];
}

export function evaluateClaudeOffer(events: any[], skill: string, expect: string[]): Check[] {
  const marker = `[ktx:${skill}]`;
  const command = invocation("claude", skill);
  const hook = events.some((e) =>
    e.type === "system" && e.subtype === "hook_response" && e.hook_event === "UserPromptSubmit" &&
    e.exit_code === 0 && String(e.stdout ?? "").includes(marker),
  );
  // The offer is the model's own sentence: a hook_response is not a result event,
  // so the echo that already names the command cannot satisfy `offered`. The answer
  // must name this command, not a longer one that starts with it (namesCommand).
  const said = answer(events);
  const started = expect.find((p) => new RegExp(p, "i").test(said));

  return [
    { name: "offer-hook-fired", ok: hook, required: true, detail: `UserPromptSubmit output contains ${marker}` },
    { name: "offered", ok: namesCommand(said, command), required: true, detail: `the answer names ${command}` },
    { name: "not-started", ok: !started, required: true, detail: started ? `the answer matches ${started}` : "the answer matches no expect pattern" },
  ];
}

/** Whether `path` itself exists, a dangling symlink included (lstat never follows it). */
function lexists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The real path `path` would occupy: the real path of its nearest existing
 * ancestor plus the segments that do not exist yet. Walking to the nearest
 * existing ancestor is what makes a not-yet-written file checkable (the deepest
 * part that exists is the one a symlink could lead out through), and the appended
 * tail is what makes `<project>/.claude/lessons.md` checkable before it exists.
 * Undefined when that ancestor cannot be resolved (a dangling symlink on the way).
 */
function candidateReal(path: string): string | undefined {
  // dirname takes at most one step per segment of the path, so a longer walk is a
  // bug in this loop rather than a filesystem fact: the bound is asserted.
  const segments = path.split(sep).length;
  const tail: string[] = [];
  for (let cur = path, taken = 0; ; taken++) {
    if (lexists(cur)) {
      try {
        return join(realpathSync(cur), ...tail);
      } catch {
        return undefined;
      }
    }
    const parent = dirname(cur);
    if (parent === cur) return undefined;
    assert(taken < segments, `${path}: the walk to its nearest existing ancestor outran its ${segments} segments`);
    tail.unshift(basename(cur));
    cur = parent;
  }
}

/**
 * The file leg's write guard (seam S2 producer), a pure function so tests and the
 * stress pass can call it; src/probe/claude-guard.ts is its hook entry. `input` is
 * the PreToolUse stdin JSON. `project` is the fence: an absolute path, so the
 * refusal cases are an empty or relative project (the hook would otherwise resolve
 * the write against its own cwd and fence nothing), a tool_input.file_path (or
 * notebook_path) that is not a non-empty string, and a path — `..` included, which
 * resolve() removes — whose real path (candidateReal: the nearest existing
 * ancestor's real path plus the part that does not exist yet) leaves the project,
 * so a symlink inside it cannot lead out. That real path decides alone: a project
 * reached through a symlinked parent (macOS spells the same temp dir `/var/...`
 * and `/private/var/...`) is still the project.
 * Anything else, a missing path included, is refused with a reason.
 */
export function claudeWriteGuard(input: unknown, project: string): { ok: boolean; reason: string } {
  const refused = (reason: string) => ({ ok: false, reason: `ktx probe: write ${reason}` });
  const toolInput = (input as any)?.tool_input;
  // Every path field the input carries is checked: a tool writes the one it reads
  // (NotebookEdit writes notebook_path), so a file_path beside it vouches for nothing.
  const named = [toolInput?.file_path, toolInput?.notebook_path].filter((value) => value !== undefined);
  if (named.length === 0) return refused("refused: the tool input names no file_path or notebook_path");
  if (project.trim() === "" || !isAbsolute(project)) {
    return refused(`refused: KTX_PROBE_PROJECT "${project}" is not an absolute path, so it fences no project`);
  }
  const given = resolve(project);
  // The project is real in a probe (probeProject returns its real path); a project
  // that does not resolve at all cannot fence anything, so the write is refused.
  let root: string;
  try {
    root = realpathSync(given);
  } catch {
    return refused(`refused: the probe project ${project} does not resolve`);
  }
  const paths: string[] = [];
  for (const value of named) {
    if (typeof value !== "string" || value.trim() === "") return refused("refused: a file_path or notebook_path is not a non-empty string");
    // A NUL byte names no file the kernel can open, and lstat throws on it, which the
    // ancestor walk would read as "not written yet".
    if (value.includes("\0")) return refused("refused: a path holds a NUL byte");
    const path = resolve(given, value);
    // The real path the write would land on decides, never the spelling: resolve()
    // has already removed any `..`, and a symlinked parent on either side of the
    // comparison resolves to the same directory.
    const real = candidateReal(path);
    if (real === undefined) return refused(`refused: ${path} cannot be resolved`);
    // Strictly inside: `root + sep` cannot prefix `root` itself, so the project
    // directory is refused too.
    if (!real.startsWith(root + sep)) return refused(`outside the probe project refused: ${path} resolves to ${real}`);
    paths.push(path);
  }
  return { ok: true, reason: `${paths.join(", ")} ${paths.length === 1 ? "is" : "are"} inside the probe project` };
}

/** The file leg's echo hook: it writes the hook's stdin JSON back on stdout (LC1). */
const EXPANSION_HOOK = "expansion-hook.ts";

/** Write the echo hook into build.tmp (C18) and return its path. */
function writeExpansionHook(build: ClaudeBuild): string {
  const script = join(build.tmp, EXPANSION_HOOK);
  writeFileSync(script, '// The file leg\'s UserPromptExpansion hook (LC1): echo the hook input.\nprocess.stdout.write(`KTX-EXPANSION ${await Bun.stdin.text()}`);\n');
  return script;
}

/**
 * A path quoted into a hook command. The command reaches a shell, so the path
 * must be unable to end the quote or expand inside it. Only ktx's own paths land
 * here; a surprising one is a bug, so it is asserted rather than escaped.
 */
function quotedPath(path: string): string {
  assert(!/["$`\\]/.test(path), `${path}: a path quoted into a hook command holds no " or $ or \` or \\`);
  return `"${path}"`;
}

/**
 * The file leg's fence as argv and env (seam S2), exported so tests and the
 * L-fence stress pass read the shipped fence without spawning Claude. Pure: the
 * expansion hook's script path is a parameter (runClaudeFile writes it). Its mode
 * `bypassPermissions` is the only one that allows a `.claude/` write (invariant
 * 26), so it never comes without the sandbox and both hooks; the write guard
 * reaches the project through KTX_PROBE_PROJECT. Hooks run in a shell, so the
 * paths are quoted as the plugin's own prompt hook quotes its script.
 */
export function claudeFileArgs(build: ClaudeBuild, project: string, prompt: string, readDirs: string[], expansionHook: string): { args: string[]; env: Record<string, string | undefined> } {
  const hook = (script: string) => `${quotedPath(process.execPath)} ${quotedPath(script)}`;
  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{ type: "command", command: hook(join(import.meta.dir, "claude-guard.ts")) }] }],
      UserPromptExpansion: [{ hooks: [{ type: "command", command: hook(expansionHook) }] }],
    },
    sandbox: { enabled: true, allowUnsandboxedCommands: false },
  });
  const args = [
    "claude", "-p", prompt,
    "--plugin-dir", build.plugin,
    // Project-only settings from the project cwd: the user's own hooks and plugins stay out of the run.
    "--setting-sources", "project",
    "--settings", settings,
    "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--permission-mode", "bypassPermissions",
  ];
  if (readDirs.length) args.push("--add-dir", ...readDirs);
  return { args, env: { ...process.env, KTX_PROBE_PROJECT: project } };
}

/**
 * Run `claude -p <prompt>` fenced as the header's file leg describes, cwd = project.
 * Asserts isProbeProject(project, build.tmp) and an empty readDirs before spawning
 * (seam S2); the echo hook script is written into build.tmp. The only new repo file
 * is claude-guard.ts.
 */
export function runClaudeFile(build: ClaudeBuild, project: string, prompt: string, readDirs: string[]): PluginRun {
  // Seam S2: bypassPermissions widens the fence to the whole machine, so the cwd
  // must be a probe project under this build's tmp, never the tmp itself.
  assert(isProbeProject(project, build.tmp), `${project}: the file leg needs a probe project under the probe build's tmp`);
  // Seam S2: a writing run grants nothing beyond its project. --add-dir would widen
  // the sandbox's writable set while the run holds bypassPermissions, and the
  // caller's runbook roots are for reading legs (probeClaudeInvoke passes none).
  assert(readDirs.length === 0, `${readDirs.join(", ")}: the file leg grants no extra --add-dir beside its project`);
  const { args, env } = claudeFileArgs(build, project, prompt, readDirs, writeExpansionHook(build));
  const dir = mkdtempSync(join(build.tmp, "run-"));
  return { ...run(args, project, env, dir), plugin: build.plugin };
}

/** The expansion hook's echo, "KTX-EXPANSION <stdin JSON>" (lc1-claude-expansion.jsonl), or undefined. */
function expansionInput(stdout: unknown): any {
  const text = String(stdout ?? "");
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

/** W3 file leg checks: listed, loaded, finished, file (header). */
export function evaluateClaudeInvokeFile(events: any[], skill: string, project: string, file: string, expect: string[]): Check[] {
  // The first three checks are the ones every tool-using leg shares (header).
  return [listedCheck(events, skill), loadedCheck(events, skill), finishedCheck(events), fileCheck(project, file, expect)];
}

/** The `listed` check: init's slash_commands lists `ktx:<skill>`. */
function listedCheck(events: any[], skill: string): Check {
  const command = `${PLUGIN_NAME}:${skill}`;
  return { name: "listed", ok: listsCommand(events, command), required: true, detail: `init slash_commands has ${command}` };
}

/**
 * The `loaded` check (seam S3 consumer): the load record is the harness's own
 * expansion event, read as JSON, so a text that merely mentions this command_name
 * (an argument, say) is not load proof, and an empty stream fails closed.
 */
function loadedCheck(events: any[], skill: string): Check {
  const command = `${PLUGIN_NAME}:${skill}`;
  const loaded = events.some((e) =>
    e?.type === "system" && e?.subtype === "hook_response" && e?.hook_event === "UserPromptExpansion" &&
    e?.exit_code === 0 && expansionInput(e?.stdout)?.command_name === command);
  return { name: "loaded", ok: loaded, required: true, detail: `UserPromptExpansion output carries "command_name":"${command}"` };
}

/**
 * The `finished` check: the harness's own end-of-run record. A run killed at run()'s
 * 600 s timeout can leave files behind without ever ending, so the result event —
 * which arrives only at the end, and carries is_error when the run failed — is
 * required. One event decides and names the check: the last result.
 */
function finishedCheck(events: any[]): Check {
  const ended = events.findLast((e) => e?.type === "result");
  const ok = ended?.subtype === "success" && ended.is_error !== true;
  return {
    name: "finished",
    ok,
    required: true,
    detail: ended === undefined ? "the run has no result event: it did not end" : `the result event is subtype ${ended.subtype}${ended.is_error === true ? " with is_error" : ""}`,
  };
}

/**
 * The model's final answer: the last result event's text. A stream may hold several
 * results (the spike's does, plans/w4-probe/spike/claude.stream.jsonl), and the run's
 * end is the one that speaks for it.
 */
function finalAnswer(events: any[]): string {
  return String(events.findLast((e) => e?.type === "result")?.result ?? "");
}

/** The `answer` check: the final answer matches every expect pattern. */
function answerCheck(events: any[], expect: string[]): Check {
  const missing = missingPatterns(finalAnswer(events), expect);
  return { name: "answer", ok: missing.length === 0, required: true, detail: missing.length ? `missing: ${missing.join(", ")}` : "all expect patterns matched" };
}

/** The invoke leg's arguments: an invoked skill is probed by invocation, not by prompt. */
function invokeProbe(skill: Skill): Probe {
  const probe = skill.sidecar?.probe;
  if (!probe) throw new Error(`${skill.name}: ktx.yaml has no probe`);
  if (probe.args === undefined) throw new Error(`${skill.name}: a prompt skill is probed with its prompt (src/probe.ts)`);
  return probe;
}

/** Run the leg the probe asks for, then the offer leg when probe.offer is set; checks from both, raw paths joined by ", ". */
export async function probeClaudeInvoke(skill: Skill, allSkills: Skill[], readDirs: string[]): Promise<ProbeResult> {
  const probe = invokeProbe(skill);
  const build = claudeProbeBuild(allSkills);
  // Seam S2 consumer: an unmarked build would let the model start the procedure
  // itself, so the probe stops here rather than reading that as a pass.
  assert(userOnly(build.plugin, skill.name), `${skill.name}: probe build is not user-only (D-W2-3)`);

  const prompt = `${invocation("claude", skill.name)} ${probe.args}`.trim();
  const raw: string[] = [];
  let checks: Check[];
  if (probe.wave !== undefined) {
    // Wave leg (D-W4-7): a throwaway wave under the file leg's fence, judged on the
    // harness's own spawn records, each child's transcript, the records the lead's
    // body wrote, and the transcript verdict.
    const leg = await claudeWaveLeg(build, skill, probe);
    checks = leg.checks;
    raw.push(leg.raw);
  } else if (probe.tools === true) {
    // Tools leg (D-W4-13): the body runs with tools in the fenced project and its
    // answer alone is judged.
    const leg = claudeToolsLeg(build, skill, probe);
    checks = leg.checks;
    raw.push(leg.raw);
  } else if (probe.file === undefined) {
    const invokeRun = runClaudeIn(build, prompt, readDirs);
    checks = evaluateClaudeInvoke(invokeRun.events, skill.name, probe.expect);
    raw.push(invokeRun.raw);
  } else {
    // File leg (D-W3-7): the body uses tools, so the run gets a throwaway git
    // project as cwd and the fence, and the file it leaves there is the evidence.
    // A writing run grants nothing beyond its project, so the runbook roots the
    // reading legs take stay out of it (no --add-dir under bypassPermissions).
    const project = probeProject(build.tmp, probe.seed);
    const fileRun = runClaudeFile(build, project, prompt, []);
    checks = evaluateClaudeInvokeFile(fileRun.events, skill.name, project, probe.file, probe.expect);
    raw.push(fileRun.raw);
  }
  if (probe.offer) {
    // The offer only fires on the prompt path, so it gets a run of its own.
    const offerRun = runClaude(probe.offer.prompt, allSkills, readDirs);
    checks.push(...evaluateClaudeOffer(offerRun.events, skill.name, probe.expect));
    raw.push(offerRun.raw);
  }
  return { checks, raw: raw.join(", ") };
}

// W4 claude track (D-W4-7, D-W4-13). Wave leg when probe.wave is set, tools leg
// when probe.tools is set; both run on the file leg's fence and flags
// (runClaudeFile in probeProject(build.tmp)), with no --add-dir.
// Wave leg: the prompt is `/ktx:<skill> ${waveArgs(probe.args, markers)}` with
// markers = waveMarkers(probe.wave.members); before spawning, assert the prompt
// holds no {markers} and markers.length === probe.wave.members (seam S5 consumer).
// evaluateClaudeWave checks, all required:
//   listed   — init slash_commands has ktx:<skill>
//   loaded   — the UserPromptExpansion echo carries "command_name":"ktx:<skill>"
//   finished — the last result event is subtype success without is_error
//   spawned  — at least `members` tool_use blocks named Agent or Task in the
//              top-level assistant messages (the key parent_tool_use_id present
//              and null; a subagent's lines carry the spawning toolu_ id), each
//              matched by a tool_result (invariant 30; the fenced spike's stream
//              names it Agent, invariant 31, plans/w4-probe/spike/claude.stream.jsonl)
// The leg appends recordsCheck, childrenCheck (this build's locate), verdictCheck
// from src/probe/wave.ts and `answer` (expect on the last result text).
// evaluateClaudeTools checks, all required: listed, loaded, finished, answer.

/** The legs' runner: runClaudeFile in every real probe; a test injects a fake, so no leg spawns Claude. */
export type ClaudeFileRunner = (build: ClaudeBuild, project: string, prompt: string, readDirs: string[]) => PluginRun;

/**
 * The src/probe/wave.ts checks a wave leg composes (W4 gate track, § 6). A real probe
 * takes the defaults; a test injects fakes, which is what makes this leg's own wiring
 * — the prompt it builds, the order of its checks, the locator it loads — checkable on
 * its own, without a live harness.
 */
export type WaveTools = {
  markers: (n: number) => string[];
  args: (args: string, markers: string[]) => string;
  records: (project: string, markers: string[]) => Check;
  children: (project: string, markers: string[], locator: Locator, env: Record<string, string | undefined>) => Check;
  verdict: (project: string, plugin: string, skill: string, env: Record<string, string | undefined>) => Promise<Check>;
};

const DEFAULT_WAVE: WaveTools = {
  markers: waveMarkers,
  args: waveArgs,
  records: recordsCheck,
  children: childrenCheck,
  verdict: verdictCheck,
};

/**
 * The ids of the top-level spawn calls, each matched with its own tool_result: a
 * `tool_use` block named Agent (Task in older streams) in an assistant line whose
 * `parent_tool_use_id` key is present and null, with a `user` line holding a tool_result
 * for that id. A subagent's own lines carry the spawning `toolu_` id in that key, so its
 * calls are not the wave's, and a call whose result never arrived launched nothing
 * (invariants 30, 31; plans/w4-probe/spike/claude.stream.jsonl).
 */
function spawnCalls(events: any[]): string[] {
  const answered = new Set<string>();
  for (const e of events) {
    if (e?.type !== "user") continue;
    for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (c?.type === "tool_result" && typeof c.tool_use_id === "string") answered.add(c.tool_use_id);
    }
  }
  const calls: string[] = [];
  for (const e of events) {
    if (e?.type !== "assistant" || !("parent_tool_use_id" in e) || e.parent_tool_use_id !== null) continue;
    for (const c of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (c?.type === "tool_use" && (c.name === "Agent" || c.name === "Task") && typeof c.id === "string" && answered.has(c.id)) {
        calls.push(c.id);
      }
    }
  }
  return calls;
}

export function evaluateClaudeWave(events: any[], skill: string, members: number): Check[] {
  const calls = spawnCalls(events);
  return [
    listedCheck(events, skill),
    loadedCheck(events, skill),
    finishedCheck(events),
    {
      name: "spawned",
      ok: calls.length >= members,
      required: true,
      detail: `${calls.length} top-level Agent or Task calls with a tool_result, for a wave of ${members}`,
    },
  ];
}

export function evaluateClaudeTools(events: any[], skill: string, expect: string[]): Check[] {
  return [listedCheck(events, skill), loadedCheck(events, skill), finishedCheck(events), answerCheck(events, expect)];
}

/**
 * The build's transcript locator (seam S3 producer): a Claude build ships
 * shared/scripts/locate.claude.ts as scripts/locate.ts (D-W4-10). A build whose skill
 * carries no locator, or one belonging to another harness, fails the wave leg before
 * the harness is spawned rather than checking transcripts against the wrong home.
 * Dynamic, because the file exists only in a build.
 */
async function locateModule(build: ClaudeBuild, skill: string): Promise<Locator> {
  const path = join(build.plugin, "skills", skill, "scripts", "locate.ts");
  assert(existsSync(path), `${path}: the build ships no scripts/locate.ts, so no member transcript can be checked (D-W4-10)`);
  const mod: any = await import(path);
  assert(mod?.HARNESS === "claude", `${path}: HARNESS is ${String(mod?.HARNESS)}, not claude`);
  for (const fn of ["locate", "finalMessage", "model"]) {
    assert(typeof mod?.[fn] === "function", `${path}: ${fn} is not a function`);
  }
  return mod as Locator;
}

/**
 * The wave leg (D-W4-7): a throwaway wave in a probe project under this build's tmp,
 * run with the file leg's fence and flags (D-W3-7). `run` is runClaudeFile and `wave`
 * is src/probe/wave.ts in every real probe; a test injects fakes, so no leg spawns
 * Claude. A writing run grants nothing beyond its project (seam S2), so the runner
 * gets no readDirs: --add-dir would widen a bypassPermissions run's sandbox past it.
 */
export async function claudeWaveLeg(
  build: ClaudeBuild,
  skill: Skill,
  probe: Probe,
  run: ClaudeFileRunner = runClaudeFile,
  wave: WaveTools = DEFAULT_WAVE,
): Promise<ProbeResult> {
  const members = probe.wave?.members;
  assert(members !== undefined, `${skill.name}: the wave leg needs probe.wave (D-W4-7)`);
  // Seam S5 consumer: the markers and the prompt are built and asserted before the
  // harness is spawned, so a wave that cannot name its members never starts one.
  const markers = wave.markers(members);
  const args = wave.args(probe.args ?? "", markers);
  assert(!args.includes(MARKERS_PLACEHOLDER), `${skill.name}: waveArgs left ${MARKERS_PLACEHOLDER} in the prompt: the harness would be handed a placeholder, not markers`);
  assert(markers.length === members, `${skill.name}: waveMarkers returned ${markers.length} markers for a wave of ${members} members`);
  const project = probeProject(build.tmp);
  assert(isProbeProject(project, build.tmp), `${project}: the wave leg needs a probe project under the probe build's tmp`);
  const locator = await locateModule(build, skill.name);
  const result = run(build, project, `${invocation("claude", skill.name)} ${args}`.trim(), []);
  const env = process.env;
  return {
    checks: [
      ...evaluateClaudeWave(result.events, skill.name, members),
      wave.records(project, markers),
      wave.children(project, markers, locator, env),
      await wave.verdict(project, build.plugin, skill.name, env),
      answerCheck(result.events, probe.expect),
    ],
    raw: result.raw,
  };
}

/** The tools leg (D-W4-13): the body runs with tools in a fenced probe project and its answer is judged (header). */
export function claudeToolsLeg(build: ClaudeBuild, skill: Skill, probe: Probe, run: ClaudeFileRunner = runClaudeFile): ProbeResult {
  const project = probeProject(build.tmp);
  assert(isProbeProject(project, build.tmp), `${project}: the tools leg needs a probe project under the probe build's tmp`);
  const result = run(build, project, `${invocation("claude", skill.name)} ${probe.args ?? ""}`.trim(), []);
  return { checks: evaluateClaudeTools(result.events, skill.name, probe.expect), raw: result.raw };
}

