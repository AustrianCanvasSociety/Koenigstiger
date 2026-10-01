// Kimi probe of a procedure skill (D-W2-4). W2 kimi track.
// Kimi print mode never expands a slash invocation (W2 invariant 9), so the
// invoke leg drives `kimi acp` (src/probe/acp.ts): kimiProbeHome(all), assert
// userOnly(home.plugin, skill) (seam S2 consumer), then runAcp with
// session/prompt `/skill:<skill> <args>`. Required checks, all failing closed
// on an empty or unfinished run (seam S5 consumer):
//   listed   — an available_commands_update lists skill:<skill>
//   expanded — stopReason is "end_turn", no session update is a tool_call or a
//              tool_call_update (live L6), and the agent made no request to the
//              client (permission, fs, terminal); a Skill call (L8) or a file read (L4) fails it
//   answer   — the agent_message_chunk texts, concatenated in order with no separator
//              (they are sub-word deltas: "MARK", "ER", "-", … in L6), match every expect pattern
// Recorded L6 messages: plans/w2-probe/acp-l6-log.json.
// Offer leg (when probe.offer is set): runKimi(offer.prompt), print mode, where
// the hook fires. Required checks:
//   offer-hook-fired — an assistant line headed "UserPromptSubmit hook" contains [ktx:<skill>]
//   offered          — the model's own lines (never the hook echo) name invocation("kimi", skill)
//                      as a whole command, so a longer skill name does not count
//   not-started      — the model's own lines match no expect pattern
// File leg (W3, D-W3-7) replaces the invoke leg when probe.file is set: the body
// uses tools, so runKimiFile makes the ACP session's cwd probeProject(home.tmp) and
// spawns the command kimiFileAcpOptions builds, ["sandbox-exec", "-p",
// kimiSandboxProfile(home.tmp), "kimi", "acp"]: writes allowed only under
// realpath(home.tmp) plus /dev/null, /dev/zero, /dev/tty* and /dev/fd (W3 invariant 29),
// with runAcp approve: true. Before spawning anything it refuses, on every platform, a
// cwd that is not a probe project, and then, on any platform but darwin, the run itself,
// which no fence there could hold. The load record is sessionWire(home, before). Required checks:
//   listed   — as above
//   loaded   — the session's wire.jsonl under <KIMI_CODE_HOME>/sessions/ has a
//              <skill-loaded name="<skill>" … dir="…"> whose dir is the probe build's
//              skill dir (home.plugin/skills/<skill>): Kimi loaded ktx's copy, not a
//              same-named skill from another root (invariants 30, 31)
//   finished — stopReason is "end_turn"
//   file     — fileCheck(project, probe.file, expect)
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as kimiLocate from "../../shared/scripts/locate.kimi";
import { assert } from "../assert";
import { invocation, MARKERS_PLACEHOLDER, type Skill } from "../skill";
import { fileCheck, isProbeProject, KIMI_HOOK_ECHO, kimiProbeHome, missingPatterns, namesCommand, probeProject, runKimiIn, type Check, type KimiHome, type ProbeResult } from "../probe";
import { userOnly } from "../translators/kimi";
import { runAcp, type AcpOptions, type AcpRun } from "./acp";
import { writeFenceProfile } from "./fence";
import { childrenCheck, recordsCheck, verdictCheck, waveArgs, waveMarkers } from "./wave";

/** Bound on the whole ACP exchange, the one the reference client proved live (L6). */
const ACP_TIMEOUT_MS = 240_000;
/**
 * Bound on the wave leg's whole ACP exchange, its own because a wave is not one
 * body: it covers the members' model time, the records the body writes and the
 * transcripts run it ends with. A marker wave is quick — the stage-6 spike's
 * two-member fenced wave took 8 s (invariant 31) — so this is the same 240 s the
 * file leg proved, kept named so a live wave that outgrows it changes one number.
 */
const WAVE_ACP_TIMEOUT_MS = 240_000;
/** Longest answer quoted in a check's detail: a probe line is a report, not a transcript. */
const CLIP = 120;

const clip = (text: string): string => JSON.stringify(text.length > CLIP ? `${text.slice(0, CLIP)}...` : text);

/** Every session update of a run, in order: the shape each check reads. */
function updates(run: Pick<AcpRun, "messages">): any[] {
  return run.messages.filter((m) => m?.method === "session/update").map((m) => m.params?.update ?? {});
}

/** The agent's answer: its message chunks, concatenated in order with no separator (they are sub-word deltas). */
function answerText(run: Pick<AcpRun, "messages">): string {
  return updates(run)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => (typeof u.content?.text === "string" ? u.content.text : ""))
    .join("");
}

/** The `answer` check: every expect pattern matched against the run's own message text. */
function answerCheck(run: Pick<AcpRun, "messages">, expect: string[]): Check {
  const missing = missingPatterns(answerText(run), expect);
  return {
    name: "answer",
    ok: missing.length === 0,
    required: true,
    detail: missing.length ? `missing: ${missing.join(", ")} — read: ${clip(answerText(run))}` : `all expect patterns matched: ${clip(answerText(run))}`,
  };
}

/** The `finished` check: the run's prompt ended (end_turn), never an empty or killed exchange. */
function finishedCheck(run: Pick<AcpRun, "stopReason">): Check {
  const finished = run.stopReason === "end_turn";
  return {
    name: "finished",
    ok: finished,
    required: true,
    detail: finished ? "the prompt finished with end_turn" : `the prompt did not finish with end_turn (stopReason: ${run.stopReason || "empty"})`,
  };
}

/**
 * The `loaded` check (invariants 30, 31): every `<skill-loaded>` block naming this
 * skill in the session's wire must be the probe build's own copy. A same-named skill
 * from another root — the owner's ~/.agents/skills, say — loaded a different body, so
 * the probe fails closed and the detail names that dir, which is the only way the
 * owner can see the shadow.
 */
function loadedCheck(wire: string, skill: string, plugin: string): Check {
  const want = join(plugin, "skills", skill);
  const own = skillLoadedTags(wire).filter((tag) => tag.name === skill);
  const shadows = own.filter((tag) => resolved(tag.dir ?? "") !== resolved(want));
  const loaded = own.length > 0 && shadows.length === 0;
  const detail = !own.length
    ? `the session's wire.jsonl has no <skill-loaded name="${skill}">`
    : shadows.length
      ? `Kimi loaded ${skill} from ${shadows.map((tag) => tag.dir ?? "(no dir attribute)").join(", ")}, not from the probe build's ${want}`
      : `Kimi loaded ${skill} from the probe build's ${want}`;
  return { name: "loaded", ok: loaded, required: true, detail };
}

/** Whether an available_commands_update lists this procedure: the `listed` check's evidence, both legs. */
function listsSkill(messages: any[], skill: string): boolean {
  return messages
    .filter((m) => m?.method === "session/update")
    .map((m) => m.params?.update ?? {})
    .filter((u) => u.sessionUpdate === "available_commands_update")
    .flatMap((u) => u.availableCommands ?? [])
    .some((c) => c?.name === `skill:${skill}`);
}

export function evaluateKimiInvoke(run: Pick<AcpRun, "messages" | "stopReason">, skill: string, expect: string[]): Check[] {
  const seen = updates(run);
  const listed = listsSkill(run.messages, skill);

  const calls = seen.filter((u) => u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update");
  // A request with an id is the agent asking the client to do something for it
  // (permission, fs, terminal): a tool was reached for, whether or not a tool_call
  // update followed. The probe home strips the owner's allow rules, so it is the model's.
  const requests = run.messages.filter((m) => m?.method !== undefined && m?.id !== undefined);
  const expanded = run.stopReason === "end_turn" && calls.length === 0 && requests.length === 0;
  const expandedDetail = run.stopReason !== "end_turn"
    ? `the prompt did not finish with end_turn (stopReason: ${run.stopReason || "empty"})`
    : calls.length
      ? `${calls.length} session update(s) are a tool call`
      : requests.length
        ? `${requests.length} agent-to-client request(s): the agent asked to use a tool`
        : "the prompt finished with end_turn and made no tool call";

  return [
    { name: "listed", ok: listed, required: true, detail: `available_commands_update lists skill:${skill}` },
    { name: "expanded", ok: expanded, required: true, detail: expandedDetail },
    answerCheck(run, expect),
  ];
}

/** `events`: the `kimi -p --output-format stream-json` stream (runKimi). */
export function evaluateKimiOffer(events: any[], skill: string, expect: string[]): Check[] {
  const marker = `[ktx:${skill}]`;
  const said = events.filter((e) => e?.role === "assistant" && typeof e.content === "string");
  const hook = said.some((e) => e.content.startsWith(KIMI_HOOK_ECHO) && e.content.includes(marker));
  // The hook echo carries the instruction, and so the command itself: only the
  // model's own lines can show that the model offered the procedure.
  const own = said
    .filter((e) => !e.content.startsWith(KIMI_HOOK_ECHO))
    .map((e) => e.content)
    .join("\n");
  const started = expect.filter((p) => new RegExp(p, "i").test(own));

  const command = invocation("kimi", skill);
  return [
    { name: "offer-hook-fired", ok: hook, required: true, detail: `hook output in stream contains ${marker}` },
    // The whole command, not a longer name that starts with it: /skill:swarm-build is not /skill:swarm.
    { name: "offered", ok: namesCommand(own, command), required: true, detail: `the model's own text names ${command}` },
    {
      name: "not-started",
      ok: started.length === 0,
      required: true,
      detail: started.length ? `the model's own text matched: ${started.join(", ")}` : "the model's own text matches no expect pattern",
    },
  ];
}

/**
 * The sandbox-exec profile for the Kimi file leg (seam S2 producer): the shared write
 * fence (writeFenceProfile), which allows writes only under realpath(tmp) plus exactly
 * /dev/null, /dev/zero, /dev/tty* and /dev/fd.
 */
export function kimiSandboxProfile(tmp: string): string {
  return writeFenceProfile(tmp, "kimi");
}

/** Every session's wire log under a Kimi home, at sessions/, agents/main/wire.jsonl (invariant 30). */
function wirePaths(kimiHome: string): string[] {
  if (!existsSync(kimiHome)) return [];
  return [...new Bun.Glob("sessions/**/agents/main/wire.jsonl").scanSync({ cwd: kimiHome, absolute: true })];
}

/**
 * Seam S3 producer: the text of the one agents/main/wire.jsonl under
 * <kimiHome>/sessions/ that is not in `before`, or "" when there are none or
 * several (as runRollout does for Codex). The checks that read the wire fail
 * closed on "", so an unattributable run never passes.
 */
export function sessionWire(kimiHome: string, before: Set<string>): string {
  const fresh = wirePaths(kimiHome).filter((path) => !before.has(path));
  return fresh.length === 1 ? readFileSync(fresh[0], "utf8") : "";
}

/**
 * The file leg's ACP options (seams S2 and S4 producers): the one command a file run may
 * spawn — `sandbox-exec -p` holding kimiSandboxProfile(home.tmp), which denies every
 * write outside realpath(home.tmp), around `kimi acp` — with the project as the session's
 * cwd and `approve: true`, because inside the fence the client answers the body's
 * permission requests with their `allow_once` option. Pure, so a test reads the shipped
 * options without spawning anything.
 */
export function kimiFileAcpOptions(home: KimiHome, project: string, prompt: string, timeoutMs: number, rawPath: string): AcpOptions {
  return {
    command: ["sandbox-exec", "-p", kimiSandboxProfile(home.tmp), "kimi", "acp"],
    cwd: project,
    env: home.env,
    prompt,
    timeoutMs,
    rawPath,
    approve: true,
  };
}

/**
 * Run the fenced file leg's ACP session (header) and return the run with its wire text.
 * On any platform but darwin this throws before spawning: the fence is macOS's
 * sandbox-exec, and a body that writes must never run without one. The ACP session's
 * cwd is the project, inside the fence's one writable subpath; the client approves
 * each permission request there (seam S4), and the run's wire is the session log the
 * run created (seam S3 producer).
 */
export async function runKimiFile(home: KimiHome, project: string, prompt: string, timeoutMs: number): Promise<{ run: AcpRun; wire: string }> {
  // Seam S2 consumer: the fence opens the probe tmp and nothing else, so the session's
  // cwd — the project the body writes into and fileCheck reads — must be a probe
  // project inside it. A cwd outside the fence would fail every write, silently.
  // Both refusals below are pre-spawn, and this one comes first: a cwd outside the
  // fence is a caller's mistake on every platform, so a host without sandbox-exec
  // must report it as that, never as a platform problem.
  assert(isProbeProject(project, home.tmp), `kimi probe: ${project} is not a probe project under ${home.tmp}`);
  assert(process.platform === "darwin", "kimi probe: the fenced file leg needs macOS sandbox-exec, so it refuses on this platform");
  const kimiHome = home.env.KIMI_CODE_HOME;
  assert(kimiHome !== undefined, "kimi probe: the probe home carries no KIMI_CODE_HOME");
  // The run's own wire is the session log that was not here before it (seam S3 producer).
  const before = new Set(wirePaths(kimiHome));
  const rawPath = join(mkdtempSync(join(home.tmp, "acp-")), "acp.jsonl");
  const run = await runAcp(kimiFileAcpOptions(home, project, prompt, timeoutMs, rawPath));
  return { run, wire: sessionWire(kimiHome, before) };
}

/**
 * Bound on the values one wire line may hold. A wire line is written by the agent under
 * test, so how much of it there is to walk is not ktx's to trust; the recorded lines
 * (invariant 30, plans/w2-probe/acp-l6-log.json) hold a handful.
 */
export const WIRE_NODE_BOUND = 100_000;

/**
 * Every string in a parsed JSON value, in the order the value lists them: a wire line's
 * message text is one of them. Iterative with an explicit stack, because a line nests as
 * deeply as the agent wrote it and JSON.parse takes levels a recursive walk does not; and
 * bounded, so the work one line can cost the probe is capped rather than the agent's.
 */
function stringLeaves(value: unknown): string[] {
  const out: string[] = [];
  const stack: unknown[] = [value];
  let walked = 0;
  while (stack.length) {
    const node = stack.pop();
    walked += 1;
    assert(walked <= WIRE_NODE_BOUND, `kimi probe: a wire line holds more than ${WIRE_NODE_BOUND} values, so it is not a session log`);
    if (typeof node === "string") {
      out.push(node);
      continue;
    }
    // Children are pushed in reverse, so they pop in the order they are written:
    // the leaves come out as the recursive walk gave them.
    const children = Array.isArray(node) ? node : node && typeof node === "object" ? Object.values(node) : [];
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i]);
  }
  return out;
}

/**
 * The wire's searchable text. A wire log is JSONL and the `<skill-loaded>` block is a
 * string inside it, where its quotes are escaped; a line that is not JSON at all is
 * searched as it stands, so neither shape can hide a load record.
 */
function wireText(wire: string): string {
  return wire
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Only a line that is not JSON at all is searched as it stands; the walk's own
        // refusal (a line past its bound) is about the wire and must reach the caller.
        return line;
      }
      return stringLeaves(parsed).join("\n");
    })
    .join("\n");
}

/** The attributes of every `<skill-loaded …>` block in a wire log (invariant 31): name, trigger, source, dir, args. */
function skillLoadedTags(wire: string): Record<string, string>[] {
  return [...wireText(wire).matchAll(/<skill-loaded\b([^>]*)>/g)].map((tag) =>
    Object.fromEntries([...tag[1].matchAll(/([a-z_]+)="([^"]*)"/g)].map((attr) => [attr[1], attr[2]])),
  );
}

/**
 * Where a recorded dir points, compared the way the probe build's own dir is: a leading
 * ~ is the user's home (Kimi keeps an extra root's spelling, invariant 30), and a path
 * that exists is its real path, because the two sides are written by different processes.
 */
function resolved(path: string): string {
  const full = path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
  return existsSync(full) ? realpathSync(full) : full;
}

/**
 * W3 file leg checks: listed, loaded, finished, file (header). `wire` is the session's
 * wire.jsonl text and `plugin` the probe build's plugin root, so `loaded` can require the
 * skill dir a load record names to be that build's own: a same-named skill from another
 * root is a shadow, and the check fails closed on it (invariants 30, 31).
 */
export function evaluateKimiInvokeFile(run: Pick<AcpRun, "messages" | "stopReason">, wire: string, skill: string, plugin: string, project: string, file: string, expect: string[]): Check[] {
  // The client approved the run's permission requests inside the fence (seam S4), so
  // unlike the invoke leg's `expanded`, a request is not held against the run: the
  // checks below read the file the body wrote and the record Kimi wrote themselves.
  return [
    { name: "listed", ok: listsSkill(run.messages, skill), required: true, detail: `available_commands_update lists skill:${skill}` },
    loadedCheck(wire, skill, plugin),
    finishedCheck(run),
    fileCheck(project, file, expect),
  ];
}

/** Run the invoke leg, then the offer leg when probe.offer is set; checks from both, raw paths joined by ", ". */
export async function probeKimiInvoke(skill: Skill, allSkills: Skill[], readDirs: string[]): Promise<ProbeResult> {
  const probe = skill.sidecar?.probe;
  if (probe?.args === undefined) throw new Error(`${skill.name}: an invoked skill's probe takes args (ktx.yaml probe.args)`);

  const home = kimiProbeHome(allSkills);
  // Seam S2 consumer: the harness never runs against a build that is not user-only.
  assert(userOnly(home.plugin, skill.name), `kimi probe: ${skill.name} is not user-only in the built plugin`);

  const prompt = `${invocation("kimi", skill.name)} ${probe.args}`.trim();
  let invoked: { checks: Check[]; raw: string };
  if (probe.wave !== undefined) {
    // Wave leg (D-W4-7): the body runs a throwaway wave of probe.wave.members
    // members, each answering one generated marker; it runs on the file leg's fence.
    invoked = await kimiWaveLeg(home, skill, probe.wave, probe.expect);
  } else if (probe.tools !== undefined) {
    // Tools leg (D-W4-13): the body uses tools in the fence's project and is judged
    // on its answer; the run is the file leg's, only the checks differ.
    invoked = await kimiToolsLeg(home, skill, prompt, probe.expect);
  } else if (probe.file !== undefined) {
    // File leg (D-W3-7): the body uses tools, so it runs in a throwaway project inside
    // the sandbox fence, which approves what it asks for there; the file it leaves is
    // the evidence (seam S1 consumer: only fileCheck reads it).
    const project = probeProject(home.tmp, probe.seed);
    const { run, wire } = await runKimiFile(home, project, prompt, ACP_TIMEOUT_MS);
    invoked = { checks: evaluateKimiInvokeFile(run, wire, skill.name, home.plugin, project, probe.file, probe.expect), raw: run.raw };
  } else {
    // Each run gets its own cwd and recorded exchange, as the other probe runs do (R3).
    const cwd = mkdtempSync(join(home.tmp, "acp-"));
    const run = await runAcp({
      command: ["kimi", "acp"],
      cwd,
      env: home.env,
      prompt,
      timeoutMs: ACP_TIMEOUT_MS,
      rawPath: join(cwd, "acp.jsonl"),
    });
    invoked = { checks: evaluateKimiInvoke(run, skill.name, probe.expect), raw: run.raw };
  }
  if (!probe.offer) return invoked;

  const offer = runKimiIn(home, probe.offer.prompt, readDirs);
  return { checks: [...invoked.checks, ...evaluateKimiOffer(offer.events, skill.name, probe.expect)], raw: `${invoked.raw}, ${offer.raw}` };
}

// W4 kimi track (D-W4-7, D-W4-8, D-W4-13). Wave leg when probe.wave is set, tools
// leg when probe.tools is set; both run on the file leg's fence (runKimiFile under
// sandbox-exec, ACP approve allow_once only). The wave leg's ACP timeout is its own
// named constant. Before spawning, the seam S5 consumer asserts as for Claude.
// evaluateKimiWave checks, all required:
//   listed   — as the file leg
//   loaded   — the session wire's skill-loaded record names <skill> from `plugin`
//   finished — stopReason end_turn
//   spawned  — at least one ACP tool_call titled AgentSwarm or Agent (the spike's
//              lead called Agent twice, invariant 31), each such call completed (its
//              last tool_call_update status). One AgentSwarm call may start every
//              member and the ACP record need not list them, so the member count is
//              childrenCheck's, through the locator, not here (contract lens B2,
//              re-verdict).
// The leg appends the src/probe/wave.ts checks and `answer`.
// evaluateKimiTools checks, all required: listed, loaded, finished, answer.

/** The ACP title of a call that starts members: Kimi titles a tool call with the tool's own name. */
const SPAWN_TOOLS = ["AgentSwarm", "Agent"];
/** The status an ACP tool call reaches when it ran to its end (the fence's recorded exchange). */
const COMPLETED = "completed";

export function evaluateKimiWave(run: Pick<AcpRun, "messages" | "stopReason">, wire: string, skill: string, plugin: string, members: number): Check[] {
  const seen = updates(run);
  const calls = seen.filter((u) => u.sessionUpdate === "tool_call" && SPAWN_TOOLS.includes(String(u.title)));
  const status = callStatus(seen);
  const unfinished = calls.filter((call) => status.get(String(call.toolCallId)) !== COMPLETED);
  const spawned = calls.length > 0 && unfinished.length === 0;
  const spawnedDetail = !calls.length
    ? `the run made no ${SPAWN_TOOLS.join(" or ")} tool call, for a wave of ${members} members`
    : unfinished.length
      ? `${unfinished.length} of ${calls.length} spawn call(s) did not complete: ` +
        unfinished.map((call) => `${call.title} ${status.get(String(call.toolCallId)) || "no status"}`).join(", ")
      : // One call may start every member and the ACP record need not list them, so the
        // count is the children check's, through this build's locator (contract lens B2).
        `${calls.length} completed spawn call(s) (${[...new Set(calls.map((call) => String(call.title)))].join(", ")}) for a wave of ${members} members`;

  return [
    { name: "listed", ok: listsSkill(run.messages, skill), required: true, detail: `available_commands_update lists skill:${skill}` },
    loadedCheck(wire, skill, plugin),
    finishedCheck(run),
    { name: "spawned", ok: spawned, required: true, detail: spawnedDetail },
  ];
}

export function evaluateKimiTools(run: Pick<AcpRun, "messages" | "stopReason">, wire: string, skill: string, plugin: string, expect: string[]): Check[] {
  return [
    { name: "listed", ok: listsSkill(run.messages, skill), required: true, detail: `available_commands_update lists skill:${skill}` },
    loadedCheck(wire, skill, plugin),
    finishedCheck(run),
    answerCheck(run, expect),
  ];
}

/**
 * The last status of every ACP tool call, by its toolCallId: a `tool_call` announces
 * the call (Kimi sends `pending`) and each `tool_call_update` that carries a status
 * is the newer word, so the last one wins. A call nothing ever updated keeps the
 * status it was announced with.
 */
function callStatus(seen: any[]): Map<string, string> {
  const status = new Map<string, string>();
  for (const u of seen) {
    if (u.sessionUpdate !== "tool_call" && u.sessionUpdate !== "tool_call_update") continue;
    if (u.toolCallId === undefined) continue;
    const id = String(u.toolCallId);
    if (u.sessionUpdate === "tool_call" && !status.has(id)) status.set(id, typeof u.status === "string" && u.status !== "" ? u.status : "pending");
    else if (typeof u.status === "string" && u.status !== "") status.set(id, u.status);
  }
  return status;
}

/**
 * Seam S5 consumer: the wave prompt is built from generated markers, and this is the
 * leg's own check of what it is about to send — no placeholder left for the harness
 * to read as text, one marker per member, and every marker in the prompt. It runs
 * before runKimiFile spawns anything, so a prompt the producer got wrong is refused
 * rather than probed.
 */
export function assertWavePrompt(prompt: string, markers: string[], members: number): void {
  assert(!prompt.includes(MARKERS_PLACEHOLDER), `kimi probe: the wave prompt still holds ${MARKERS_PLACEHOLDER}`);
  assert(markers.length === members, `kimi probe: the wave prompt carries ${markers.length} marker(s) for ${members} member(s)`);
  for (const marker of markers) assert(prompt.includes(marker), `kimi probe: the wave prompt does not carry ${marker}`);
}

/**
 * The wave leg: `/skill:<skill> <args with the markers>` in a throwaway project inside
 * the file leg's fence, judged by evaluateKimiWave plus the harness-agnostic wave
 * checks. The markers are generated here, one per member, and the prompt is asserted
 * (seam S5 consumer) before runKimiFile spawns anything.
 */
async function kimiWaveLeg(home: KimiHome, skill: Skill, wave: { members: number }, expect: string[]): Promise<{ checks: Check[]; raw: string }> {
  const args = skill.sidecar?.probe?.args;
  assert(args !== undefined, `kimi probe: ${skill.name} is a wave probe without probe.args (ktx check refuses this earlier)`);
  const markers = waveMarkers(wave.members);
  const prompt = `${invocation("kimi", skill.name)} ${waveArgs(args, markers)}`.trim();
  assertWavePrompt(prompt, markers, wave.members);

  const project = probeProject(home.tmp);
  const { run, wire } = await runKimiFile(home, project, prompt, WAVE_ACP_TIMEOUT_MS);
  // The leg appends the harness-agnostic wave checks (D-W4-7, seam S4 consumer) and
  // the answer the body prints, which is what the probe's expect patterns name.
  return {
    checks: [
      ...evaluateKimiWave(run, wire, skill.name, home.plugin, wave.members),
      recordsCheck(project, markers),
      childrenCheck(project, markers, kimiLocate, home.env),
      await verdictCheck(project, home.plugin, skill.name, home.env),
      answerCheck(run, expect),
    ],
    raw: run.raw,
  };
}

/** The tools leg: the file leg's fenced run, judged on listed / loaded / finished / answer. */
async function kimiToolsLeg(home: KimiHome, skill: Skill, prompt: string, expect: string[]): Promise<{ checks: Check[]; raw: string }> {
  const project = probeProject(home.tmp);
  const { run, wire } = await runKimiFile(home, project, prompt, ACP_TIMEOUT_MS);
  return { checks: evaluateKimiTools(run, wire, skill.name, home.plugin, expect), raw: run.raw };
}
