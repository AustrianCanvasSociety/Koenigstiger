// OpenCode live probe, prompt leg (D-W5-10, D-W5-12). One hermetic
// `opencode run --standalone -m <model> --format json` with the prompt on STDIN
// and no message argument — as an argument, a prompt with a space is admitted
// wrapped in quotes (run.ts formatMessage); piped it is admitted verbatim
// (W5 invariant 34, L13) — in a throwaway
// home: the four XDG_* roots and OPENCODE_TEST_HOME inside a temp dir, the build
// placed into its config dir with placeBuild, the provider and permissions in
// OPENCODE_CONFIG_CONTENT (W5 invariants 19, 45, 46). Afterwards
// `opencode session export --standalone <sessionID>` in the same env.
// Checks: provider (S6), finished (exit 0 and a text event), hook-fired (the
// exported user message contains [ktx:<skill>]), answer (expect patterns over
// the text events). Prompt-leg permissions: deny edit, question, shell, subagent,
// webfetch, websearch; allow read and external_directory on each readDirs entry. Never --auto.
// The wave leg's rules are wavePolicy (D-W6-2, seam W1), passed to runOpencodeIn by
// its caller; the env its transcript checks read is checkEnv (D-W6-3, seam W2).
//
// Seam S6 producer (probeProvider): {model, config} only when
// KTX_OPENCODE_PROBE_MODEL matches ^[^/\s]+/\S+$ and KTX_OPENCODE_PROBE_CONFIG
// parses as a JSON object whose `providers` object names the model's provider;
// otherwise a failing `provider` check naming both variables.
// Seam S6 consumer (probeRunEnv, used by runOpencodeIn): env = probeEnv(env)
// FIRST, then XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_CACHE_HOME, XDG_STATE_HOME set
// under home.tmp, OPENCODE_TEST_HOME and OPENCODE_CONFIG_CONTENT added; it asserts
// that those four roots lie under home.tmp and that the only OPENCODE_* variables
// are those two (other XDG_* variables are left alone). The spawn is the probe's
// own Bun.spawnSync with the prompt on stdin and timeout 600_000 (run()'s bound;
// exitCode null when killed; stdout saved as <run dir>/stream.jsonl). Always
// --standalone; afterwards no `opencode serve` of this home is left (invariant 45).
// The home is placed with placeBuild (install track); opencodeProbeHome and
// runOpencodeIn are exercised live by the lead, the checks by unit tests.
//
// `finished` reads the process's own exit code and `provider` the S6 producer, so a
// leg composes both (probeOpencode, probeOpencodeInvoke) and evaluateOpencode judges
// what the stream and the export alone can show. An answer is the `text` events
// joined as lines: each is a whole part (invariant 33), not Kimi's sub-word delta.
// That is the prompt, invoke, file and offer legs' rule; the wave and tools legs
// judge finalText, the run's final message (W6 invariants 7, 19).
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { assert } from "../assert";
import { harnessHome } from "../install/paths";
import { placeBuild } from "../install/opencode";
import { isProbeProject, parseLines, type Check, type PluginRun, type ProbeResult } from "../probe";
import type { Skill } from "../skill";
import { buildOpencode } from "../translators/opencode";
import { writeFenceProfile } from "./fence";

export type Env = Record<string, string | undefined>;
export type OpencodeHome = { tmp: string; plugin: string; env: Env };
export type ProbeProvider = { model: string; config: Record<string, unknown> };

/** One OpenCode v2 permission rule: {action, resource, effect}; last match wins, unmatched is `ask` (permissions.mdx). */
export type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" };

/** Bound on one `opencode run`: run()'s own (src/probe.ts:425-430), in milliseconds. */
const RUN_TIMEOUT_MS = 600_000;
/** Bound on one `opencode session export`: a private server start plus one query (the L6/L7 exports took about a second). */
const EXPORT_TIMEOUT_MS = 60_000;
/** The four XDG_* roots a probe home moves and the dir each holds inside it (invariant 19). */
const XDG_ROOTS = [["XDG_CONFIG_HOME", "config"], ["XDG_DATA_HOME", "data"], ["XDG_CACHE_HOME", "cache"], ["XDG_STATE_HOME", "state"]] as const;
/** OpenCode's config dir under XDG_CONFIG_HOME (install/paths.ts harnessHome). */
const CONFIG_DIR = "opencode";
/** The only OPENCODE_* variables a probe run may hold (S6 consumer). */
const RUN_VARS = ["OPENCODE_TEST_HOME", "OPENCODE_CONFIG_CONTENT"];
/** Longest answer quoted in a check's detail: a probe line is a report, not a transcript. */
const CLIP = 120;
/** What D-W5-12's two variables are for; every failing provider check names both. */
const S6 = "set KTX_OPENCODE_PROBE_MODEL to provider/model and KTX_OPENCODE_PROBE_CONFIG to a JSON config document naming that provider";

/** The caller's env without any OPENCODE_* or CLAUDE_CODE_* variable (D-W5-10). */
export function probeEnv(env: Env): Env {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("OPENCODE_") && !k.startsWith("CLAUDE_CODE_")));
}

/** The probe's provider from the two KTX_OPENCODE_PROBE_* variables, or a failing check (S6, D-W5-12). */
export function probeProvider(env: Env): ProbeProvider | Check {
  const fail = (reason: string): Check => ({ name: "provider", ok: false, required: true, detail: `${S6}: ${reason}` });
  const model = env.KTX_OPENCODE_PROBE_MODEL ?? "";
  if (!/^[^/\s]+\/\S+$/.test(model)) return fail(`KTX_OPENCODE_PROBE_MODEL is ${model ? JSON.stringify(model) : "unset"}, not provider/model`);

  const raw = env.KTX_OPENCODE_PROBE_CONFIG;
  if (!raw) return fail("KTX_OPENCODE_PROBE_CONFIG is unset");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("KTX_OPENCODE_PROBE_CONFIG is not JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return fail("KTX_OPENCODE_PROBE_CONFIG is not a JSON object");
  const providers = (parsed as Record<string, unknown>).providers;
  if (providers === null || typeof providers !== "object" || Array.isArray(providers)) return fail("KTX_OPENCODE_PROBE_CONFIG holds no providers object");

  // The provider is the part before the first slash; the document must declare it (invariant 46)
  // as its own key — `__proto__` would otherwise find Object.prototype (w5-stress F1).
  const provider = model.slice(0, model.indexOf("/"));
  const entry = Object.hasOwn(providers, provider) ? (providers as Record<string, unknown>)[provider] : undefined;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail(`KTX_OPENCODE_PROBE_CONFIG declares no provider ${JSON.stringify(provider)} for model ${model}`);
  return { model, config: parsed as Record<string, unknown> };
}

/** Whether the S6 producer refused, so a caller can tell a check from a provider. */
export const isCheck = (value: ProbeProvider | Check): value is Check => "ok" in value;

/** The `provider` check for a provider the producer accepted (§ 9's first check). */
export function okProviderCheck(provider: ProbeProvider): Check {
  return { name: "provider", ok: true, required: true, detail: `KTX_OPENCODE_PROBE_MODEL and KTX_OPENCODE_PROBE_CONFIG name model ${provider.model}` };
}

/** The run's environment (S6 consumer): see the header. */
export function probeRunEnv(home: OpencodeHome, config: Record<string, unknown>, env: Env): Env {
  const out = probeEnv(env);
  for (const [name, dir] of XDG_ROOTS) out[name] = homeRoot(home.tmp, dir);
  out.OPENCODE_TEST_HOME = homeRoot(home.tmp, "home");
  out.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  // Postcondition: probeEnv dropped the caller's own OpenCode variables, so the only
  // ones left are the two set above; a stray one would reconfigure the run.
  const stray = Object.keys(out).filter((k) => k.startsWith("OPENCODE_") && !RUN_VARS.includes(k));
  assert(stray.length === 0, `opencode probe: the run env still holds ${stray.join(", ")} — probeEnv drops every OPENCODE_* variable (D-W5-10)`);
  return out;
}

/**
 * A root the probe home holds. A relative or unnormalised home would put OpenCode's
 * config, data, cache and state somewhere other than the throwaway dir — the caller's
 * own tree, in the worst case — so the home is asserted before the roots are built.
 */
function homeRoot(tmp: string, name: string): string {
  assert(isAbsolute(tmp), `opencode probe: the probe home ${tmp} is not an absolute path`);
  const root = join(tmp, name);
  assert(resolve(root) === root && dirname(root) === tmp, `opencode probe: the probe home ${tmp} is not normalised, so ${name} would not be a root it holds`);
  return root;
}

/** The prompt leg's rules: read-only — Kimi's read-only agent, in OpenCode's terms (D-W5-10). */
export function promptPermissions(readDirs: string[]): PermissionRule[] {
  return [
    // `question` too: headless, an allowed call opens a form nothing answers, the run is
    // cancelled and exits 1 — a failure that says nothing about ktx (W-B2).
    ...["edit", "question", "shell", "subagent", "webfetch", "websearch"].map((action): PermissionRule => ({ action, resource: "*", effect: "deny" })),
    // A path outside the project needs both rules (permissions.mdx): the read itself,
    // and the external_directory boundary it sits under.
    ...readDirs.flatMap((dir): PermissionRule[] => [
      { action: "read", resource: join(dir, "*"), effect: "allow" },
      { action: "external_directory", resource: join(dir, "*"), effect: "allow" },
    ]),
  ];
}

/**
 * The file leg's rules: OpenCode's built-in agent ruleset (`* * allow`, with
 * external_directory asking) keeps the project writable; this narrows it — the body's
 * own scripts stay readable, and the question, spawn and network actions are denied.
 * What keeps a write inside the project is that built-in `ask`, OpenCode's path
 * heuristic, not a rule of ktx's; `shell` and `edit` stay allowed because the body
 * needs them, so the leg's real bound is the throwaway home and its pinned PWD
 * (W-B1, accepted; a rule set's last match wins, permission.ts:88-96).
 */
export function filePermissions(skillsDir: string): PermissionRule[] {
  return [
    { action: "read", resource: join(skillsDir, "*"), effect: "allow" },
    { action: "external_directory", resource: join(skillsDir, "*"), effect: "allow" },
    ...["question", "subagent", "webfetch", "websearch"].map((action): PermissionRule => ({ action, resource: "*", effect: "deny" })),
  ];
}

/** The rules a run is given: the config's top-level `permissions`, and per-agent ones appended after them (W6 invariant 13). */
export type ProbePolicy = { permissions: PermissionRule[]; agents?: Record<string, { permissions: PermissionRule[] }> };

/** The member agent a wave lead spawns (shared/harness.opencode.md § Spawn). */
const MEMBER_AGENT = "general";

/**
 * The wave leg's rules (D-W6-2; seam W1 producer): the file leg's, minus its
 * `subagent` deny — a `*` deny removes the spawn tool from the lead (W6 invariant 11) —
 * with no top-level `subagent` rule at all: config rules land after every agent's own,
 * so an allow there would also undo `general`'s deny (invariant 13). The base
 * `allow *` lets the lead spawn, and the per-agent rule keeps each member spawn-free.
 * `skillsDir` is a normalised absolute path below the root: the read and
 * external_directory allows are `<skillsDir>/*`, and `join` would turn an empty,
 * relative, root or `..`-climbing dir into an allow wider than the build (W6 stress S-1).
 */
export function wavePolicy(skillsDir: string): ProbePolicy {
  assert(isAbsolute(skillsDir), `opencode probe: the wave policy's skills dir ${JSON.stringify(skillsDir)} is not an absolute path`);
  assert(resolve(skillsDir) === skillsDir, `opencode probe: the wave policy's skills dir ${skillsDir} is not normalised`);
  assert(dirname(skillsDir) !== skillsDir, `opencode probe: the wave policy's skills dir ${skillsDir} is the filesystem root`);
  const permissions = filePermissions(skillsDir).filter((rule) => rule.action !== "subagent");
  const policy: ProbePolicy = { permissions, agents: { [MEMBER_AGENT]: { permissions: [{ action: "subagent", resource: "*", effect: "deny" }] } } };
  // Seam W1 producer: the lead may spawn, and a member may not.
  assert(!policy.permissions.some((rule) => rule.action === "subagent"), "opencode probe: the wave policy holds a top-level subagent rule, which would undo the member agent's own deny (D-W6-2)");
  const member = policy.agents![MEMBER_AGENT].permissions.at(-1);
  assert(member?.action === "subagent" && member.resource === "*" && member.effect === "deny", `opencode probe: the wave policy's last ${MEMBER_AGENT} rule is not a subagent deny (D-W6-2)`);
  return policy;
}

/** Build and place ktx into a throwaway OpenCode home. */
export function opencodeProbeHome(allSkills: Skill[]): OpencodeHome {
  const tmp = mkdtempSync(join(tmpdir(), "ktx-probe-"));
  const root = buildOpencode(allSkills, join(tmp, "out"));
  const home: OpencodeHome = { tmp, plugin: join(tmp, "config", CONFIG_DIR), env: probeEnv(process.env) };
  // Seam S1's consumer places the build exactly where OpenCode looks for its config
  // dir, and subcommandEnv re-asserts that before every spawn: a build placed
  // elsewhere is a refusal, never a silent run against nothing.
  placeBuild(root, home.plugin, allSkills);
  return home;
}

/**
 * The command one run spawns. A writing run (`fenced`) is the same `opencode run`
 * inside `sandbox-exec -p` holding writeFenceProfile(home.tmp), which denies every
 * write outside realpath(home.tmp): OpenCode's `external_directory` check covers file
 * tools and a shell's working directory, not a path handed to a shell command, so
 * without the fence `echo hi > <outside>/f` lands (plans/m4-probe/live/fence-opencode.json).
 * Pure, so a test reads the shipped command without spawning anything.
 */
export function opencodeRunCommand(home: OpencodeHome, model: string, fenced: boolean): string[] {
  const run = ["opencode", "run", "--standalone", "-m", model, "--format", "json"];
  return fenced ? ["sandbox-exec", "-p", writeFenceProfile(home.tmp, "opencode"), ...run] : run;
}

/**
 * One `opencode run --standalone` in a probe home; cwd defaults to a fresh run dir.
 * `policy` is the caller's rule set (D-W6-2); without one, a cwd gets the file
 * policy and no cwd the read-only prompt policy, as before W6. A run with a cwd
 * writes, so it is spawned inside the write fence (opencodeRunCommand) and refuses
 * on any platform but darwin, as Kimi's file leg does.
 */
export function runOpencodeIn(home: OpencodeHome, prompt: string, readDirs: string[], cwd?: string, policy?: ProbePolicy): PluginRun {
  const provider = providerFor(home.env);
  // Seam S3: a cwd is the file leg, and it is where the body writes (fileCheck reads
  // the project afterwards), so it must be a throwaway probe project under this home's
  // tmp — never the tmp itself, and never anything of the owner's.
  if (cwd !== undefined) assert(isProbeProject(cwd, home.tmp), `opencode probe: the file leg's cwd ${cwd} is not a probe project under ${home.tmp}`);
  // Seam W1 consumer: a rule set that widens a member agent's rules is a writing run's
  // (the wave leg), so it runs in a probe project, never in a bare run dir.
  assert(policy?.agents === undefined || cwd !== undefined, "opencode probe: a policy with per-agent rules needs a probe project as its cwd (D-W6-2)");
  // After the cwd refusal, which is the caller's mistake on every platform: the fence
  // is macOS's sandbox-exec, and a body that writes must never run without one.
  const fenced = cwd !== undefined;
  assert(!fenced || process.platform === "darwin", "opencode probe: a writing run needs macOS sandbox-exec, so it refuses on this platform");
  // The file leg gets the file policy and the prompt leg the read-only one.
  const rules = policy ?? { permissions: cwd === undefined ? promptPermissions(readDirs) : filePermissions(join(home.plugin, "skills")) };
  const dir = mkdtempSync(join(home.tmp, "run-"));
  const workdir = cwd ?? dir;
  const env = spawnEnv(home, { ...provider.config, permissions: rules.permissions, ...(rules.agents ? { agents: rules.agents } : {}) }, workdir);

  const proc = Bun.spawnSync(opencodeRunCommand(home, provider.model, fenced), {
    cwd: workdir,
    env,
    // The prompt goes on stdin: as an argument, `opencode run` admits a multi-word
    // prompt wrapped in quotes, and headless it never expands a command
    // (invariants 34 and 44, D-W5-13).
    stdin: Buffer.from(prompt),
    timeout: RUN_TIMEOUT_MS,
  });
  const raw = join(dir, "stream.jsonl");
  writeFileSync(raw, proc.stdout);
  return { events: parseLines(proc.stdout.toString()), raw, exitCode: proc.exitCode, plugin: home.plugin };
}

/** A session export as read, or why there is none — the hook check names the reason (W-T4). */
export type ExportRead = { doc: unknown } | { why: string };

/** `opencode session export --standalone <id>` in the probe home (D-W5-7, D-W5-15). */
export function sessionExport(home: OpencodeHome, id: string): ExportRead {
  // The export is a server-side read of the run's own session, so it takes the
  // provider document alone: the permissions are a model-run concern.
  const provider = probeProvider(home.env);
  if (isCheck(provider)) return { why: `no provider to export with: ${provider.detail}` };
  if (!id.startsWith("ses_")) return { why: `${JSON.stringify(id)} is not an OpenCode session id` };
  const workdir = mkdtempSync(join(home.tmp, "export-"));
  const proc = Bun.spawnSync(["opencode", "session", "export", "--standalone", id], { cwd: workdir, env: spawnEnv(home, provider.config, workdir), timeout: EXPORT_TIMEOUT_MS });
  if (proc.exitCode !== 0) {
    const said = proc.stderr.toString().trim().split("\n")[0] ?? "";
    return { why: `opencode session export ${id} exited ${proc.exitCode ?? "on a signal"}${said ? `: ${said}` : ""}` };
  }
  try {
    return { doc: JSON.parse(proc.stdout.toString()) };
  } catch (err) {
    return { why: `opencode session export ${id} printed no JSON: ${(err as Error).message}` };
  }
}

/**
 * The env a wave's transcript checks run in (D-W6-3; seam W2 producer): the provider
 * document and this home's four roots, PWD at the project. `home.env` is the caller's
 * env with no XDG_* root, so the locator handed it would export from the owner's own
 * opencode.db, where no probe session exists (W6 invariant 9, D-W5-7).
 */
export function checkEnv(home: OpencodeHome, project: string): Env {
  const env = spawnEnv(home, providerFor(home.env).config, project);
  assert(env.XDG_DATA_HOME === homeRoot(home.tmp, "data"), `opencode probe: the check env's data root ${env.XDG_DATA_HOME} is not the probe home's (D-W6-3)`);
  return env;
}

/** A run's own export: a stream with no session id has none to read. */
export function runExport(home: OpencodeHome, events: any[]): ExportRead {
  const id = sessionID(events);
  return id === null ? { why: "the run's --format json stream carries no session id" } : sessionExport(home, id);
}

/** The S6 producer's provider, or a thrown error: no leg reaches a spawn without one (D-W5-12). */
function providerFor(env: Env): ProbeProvider {
  const provider = probeProvider(env);
  if (isCheck(provider)) throw new Error(`opencode probe: ${provider.detail}`);
  return provider;
}

/**
 * The env a subcommand runs in: S6's consumer, plus the assertion that the config dir
 * OpenCode will read is this home's and the one placeBuild put the build into
 * (invariant 42). A run against the owner's own config dir would probe nothing ktx owns.
 */
function subcommandEnv(home: OpencodeHome, config: Record<string, unknown>): Env {
  const env = probeRunEnv(home, config, home.env);
  const found = harnessHome("opencode", env);
  assert(found === home.plugin, `opencode probe: OpenCode would read ${found}, not the probe home's build at ${home.plugin}`);
  return env;
}

/**
 * The env for one spawn whose cwd is `workdir`. `opencode run` takes its project
 * directory from PWD before its real cwd (packages/cli/src/run/run.ts:73,
 * `options.root ?? process.env.PWD ?? process.cwd()`; W5 invariant 47), and the
 * caller's PWD is the owner's own checkout — a live lessons probe wrote into it
 * before this existed. So PWD is set to the spawn's own dir, which must lie inside
 * the probe home.
 */
export function spawnEnv(home: OpencodeHome, config: Record<string, unknown>, workdir: string): Env {
  // Real paths on both sides: macOS temp dirs sit behind /var -> /private/var, and a
  // probe project is handed over as its real path (probeProject).
  const inside = isAbsolute(workdir) && resolve(workdir) === workdir && existsSync(workdir) &&
    realpathSync(workdir).startsWith(realpathSync(home.tmp) + sep);
  assert(inside, `opencode probe: the spawn's directory ${workdir} is not inside the probe home ${home.tmp}`);
  return { ...subcommandEnv(home, config), PWD: workdir };
}

/** The session id a stream belongs to (invariant 33: every line carries one), or null. */
export function sessionID(events: any[]): string | null {
  for (const event of events) if (typeof event?.sessionID === "string") return event.sessionID;
  return null;
}

/** The model's own answer: the `text` events' parts, in stream order, one per line (invariant 33). */
export function answerText(events: any[]): string {
  return events.filter((e) => e?.type === "text" && typeof e.part?.text === "string").map((e) => e.part.text).join("\n");
}

/**
 * The run's final message (W6 invariants 7, 19): the assistant message the last
 * `step_start` opened — each step is one assistant message, `part.messageID` — with its
 * text parts joined with "" as OpenCode joins them. A final step with no text is "",
 * as OpenCode answers NO_TEXT for it, never an earlier step's text (W6 lens W-L2); an
 * errored final step is `finished`'s to fail. answerText is every step's text, a
 * superset — a lead that wrote the expected line before running a check would pass on
 * it; the wave and tools legs judge this.
 */
export function finalText(events: any[]): string {
  const last = events.filter((e) => e?.type === "step_start").at(-1)?.part?.messageID;
  if (typeof last !== "string") return "";
  return events
    .filter((e) => e?.type === "text" && e.part?.messageID === last && typeof e.part?.text === "string")
    .map((e) => e.part.text)
    .join("");
}

/** Longest answer a detail quotes, so a check line stays a report. */
export const clip = (text: string): string => JSON.stringify(text.length > CLIP ? `${text.slice(0, CLIP)}...` : text);

/** The `answer` check: every expect pattern matched against the run's own text. */
export function answerCheck(text: string, expect: string[]): Check {
  const missing = expect.filter((p) => !new RegExp(p, "i").test(text));
  return {
    name: "answer",
    ok: missing.length === 0,
    required: true,
    detail: missing.length ? `missing: ${missing.join(", ")} — read: ${clip(text)}` : `all expect patterns matched: ${clip(text)}`,
  };
}

/**
 * The `finished` check: the harness process ended on its own (exit 0) after answering.
 * `exitCode` is the process's own (runOpencodeIn), so null is a run killed at the
 * 600 s bound; an `error` line (invariant 33 — L11's provider error, out-ds1.jsonl)
 * is a run whose step never reached the model, whatever the exit code says.
 */
export function finishedCheck(exitCode: number | null, events: any[]): Check {
  const text = events.some((e) => e?.type === "text" && typeof e.part?.text === "string" && e.part.text !== "");
  const errored = events.some((e) => e?.type === "error");
  const detail = exitCode === null
    ? "the run did not finish: opencode was killed (the 600 s bound)"
    : exitCode !== 0
      ? `the run did not finish: opencode exited ${exitCode}`
      : errored
        ? "the run did not finish: its stream carries an error event"
        : text
          ? "the run finished: opencode exited 0 after a text event"
          : "the run did not finish: opencode exited 0 with no text event";
  return { name: "finished", ok: exitCode === 0 && text && !errored, required: true, detail };
}

/** The user messages of a session export (invariant 29), or "" when it holds none. */
function userText(exported: any): string {
  const messages = Array.isArray(exported?.messages) ? exported.messages : [];
  return messages.filter((m) => m?.type === "user").map((m) => (typeof m.text === "string" ? m.text : "")).join("\n");
}

/**
 * The hook's evidence in a run's own export: the prompt hook's edit becomes the
 * persisted user message (invariant 2), so the injected `[ktx:<skill>]` marker is in
 * there when the trigger fired. `name` is the check's — `hook-fired` on the prompt
 * leg, `offer-hook-fired` on a procedure's offer leg.
 */
export function hookFiredCheck(exported: ExportRead, skill: string, name: string): Check {
  const marker = `[ktx:${skill}]`;
  if ("why" in exported) {
    return { name, ok: false, required: true, detail: `no session export to look for ${marker} in: ${exported.why}` };
  }
  const fired = userText(exported.doc).includes(marker);
  return {
    name,
    ok: fired,
    required: true,
    detail: fired ? `the run's own user message carries ${marker}` : `the run's own user message carries no ${marker}: the prompt trigger did not fire (D-W5-5)`,
  };
}

/** Judge a prompt-leg run from its --format json stream and its session export. */
export function evaluateOpencode(events: any[], exported: ExportRead, skill: string, expect: string[]): Check[] {
  return [hookFiredCheck(exported, skill, "hook-fired"), answerCheck(answerText(events), expect)];
}

/** Probe a prompt-triggered skill in OpenCode. */
export function probeOpencode(skill: Skill, allSkills: Skill[], readDirs: string[]): ProbeResult {
  const probe = skill.sidecar?.probe;
  if (!probe) throw new Error(`${skill.name}: ktx.yaml has no probe`);
  if (probe.prompt === undefined) throw new Error(`${skill.name}: an invoked skill is probed with its args (src/probe/opencode-invoke.ts)`);

  // Seam S6 producer: a missing or malformed provider answers one failing check and
  // runs nothing at all, so no home is built and no process is spawned (D-W5-12).
  const provider = probeProvider(process.env);
  if (isCheck(provider)) return { checks: [provider], raw: "" };

  const home = opencodeProbeHome(allSkills);
  const run = runOpencodeIn(home, probe.prompt, readDirs);
  return {
    checks: [okProviderCheck(provider), finishedCheck(run.exitCode, run.events), ...evaluateOpencode(run.events, runExport(home, run.events), skill.name, probe.expect)],
    raw: run.raw,
  };
}
