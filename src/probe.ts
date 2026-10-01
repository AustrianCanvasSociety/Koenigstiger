// Live probes: run a real harness headlessly on a skill's probe prompt and
// judge the run from the harness's own event stream. A correct answer alone
// is not evidence of wiring (the model may find the files unaided), so the
// required checks are harness events: plugin loaded, hook fired with this
// skill's marker, plus the answer matching every expect pattern.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { assert } from "./assert";
import type { Skill } from "./skill";
import { buildClaude, PLUGIN_NAME } from "./translators/claude";
import { buildKimi } from "./translators/kimi";
import { buildCodex, CODEX_MARKETPLACE } from "./translators/codex";

export type Check = { name: string; ok: boolean; required: boolean; detail: string };

export function evaluateClaude(events: any[], skill: string, expect: string[]): Check[] {
  const marker = `[ktx:${skill}]`;
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const pluginLoaded = !!init?.plugins?.some((p: any) => p.name === PLUGIN_NAME) &&
    !!init?.skills?.includes(`${PLUGIN_NAME}:${skill}`);
  const hook = events.find((e) =>
    e.type === "system" && e.subtype === "hook_response" && e.hook_event === "UserPromptSubmit" &&
    e.exit_code === 0 && String(e.stdout ?? "").includes(marker),
  );
  const skillCall = events.some((e) =>
    e.type === "assistant" &&
    e.message?.content?.some((c: any) => c.type === "tool_use" && c.name === "Skill" && c.input?.skill === `${PLUGIN_NAME}:${skill}`),
  );
  const answer = String(events.find((e) => e.type === "result")?.result ?? "");
  const missing = missingPatterns(answer, expect);

  return [
    { name: "plugin-loaded", ok: pluginLoaded, required: true, detail: `init lists ${PLUGIN_NAME}:${skill}` },
    { name: "hook-fired", ok: !!hook, required: true, detail: `UserPromptSubmit output contains ${marker}` },
    { name: "skill-invoked", ok: skillCall, required: false, detail: "model called the Skill tool (informational)" },
    { name: "answer", ok: missing.length === 0, required: true, detail: missing.length ? `missing: ${missing.join(", ")}` : "all expect patterns matched" },
  ];
}

// Kimi's stream-json has no hook events; the hook's stdout arrives as an
// assistant-role line headed "UserPromptSubmit hook" (observed on Kimi 2.1.0).
export const KIMI_HOOK_ECHO = "UserPromptSubmit hook";

export function evaluateKimi(events: any[], skill: string, expect: string[]): Check[] {
  const marker = `[ktx:${skill}]`;
  const said = events.filter((e) => e.role === "assistant" && typeof e.content === "string");
  const hook = said.some((e) => e.content.startsWith(KIMI_HOOK_ECHO) && e.content.includes(marker));
  const answer = said.filter((e) => !e.content.startsWith(KIMI_HOOK_ECHO)).map((e) => e.content).join("\n");
  const missing = missingPatterns(answer, expect);
  return [
    { name: "hook-fired", ok: hook, required: true, detail: `hook output in stream contains ${marker}` },
    { name: "answer", ok: missing.length === 0, required: true, detail: missing.length ? `missing: ${missing.join(", ")}` : "all expect patterns matched" },
  ];
}

/**
 * Whether `text` names `command` as a whole command: `/ktx:swarm` is not named by
 * `/ktx:swarm-build`. A skill-name character right after it means a longer name.
 */
export function namesCommand(text: string, command: string): boolean {
  let at = text.indexOf(command);
  while (at >= 0) {
    if (!/[a-z0-9-]/.test(text[at + command.length] ?? "")) return true;
    at = text.indexOf(command, at + 1);
  }
  return false;
}

/** The expect patterns (case-insensitive regexes) that `text` does not match. */
export function missingPatterns(text: string, expect: string[]): string[] {
  return expect.filter((p) => !new RegExp(p, "i").test(text));
}

export function verdict(checks: Check[]): "pass" | "fail" {
  return checks.every((c) => c.ok || !c.required) ? "pass" : "fail";
}

export type ProbeResult = { checks: Check[]; raw: string };
/**
 * `exitCode` is the harness process's own: null when it was killed (the 600 s timeout
 * included), so a check can tell a finished run from a truncated stream.
 */
export type StreamRun = { events: any[]; raw: string; exitCode: number | null };
/** A run against a freshly built plugin: `plugin` is that build's plugin root. */
export type PluginRun = StreamRun & { plugin: string };

/** The probe of a prompt-triggered skill: its sidecar must carry `probe.prompt`. */
function promptProbe(skill: Skill): { prompt: string; expect: string[] } {
  const probe = skill.sidecar?.probe;
  if (!probe) throw new Error(`${skill.name}: ktx.yaml has no probe`);
  if (probe.prompt === undefined) throw new Error(`${skill.name}: an invoked skill is probed with its args (src/probe/*-invoke.ts)`);
  return { prompt: probe.prompt, expect: probe.expect };
}

export type ClaudeBuild = { tmp: string; plugin: string };

/** Build the Claude plugin into a fresh temp dir, without running anything. */
export function claudeProbeBuild(allSkills: Skill[]): ClaudeBuild {
  const tmp = mkdtempSync(join(tmpdir(), "ktx-probe-"));
  return { tmp, plugin: buildClaude(allSkills, join(tmp, "out")) };
}

/** Build the plugin and run `claude -p <prompt>` against it; return the stream. */
export function runClaude(prompt: string, allSkills: Skill[], readDirs: string[]): PluginRun {
  return runClaudeIn(claudeProbeBuild(allSkills), prompt, readDirs);
}

/** Run `claude -p <prompt>` against an existing probe build (see claudeProbeBuild). */
export function runClaudeIn({ tmp, plugin }: ClaudeBuild, prompt: string, readDirs: string[]): PluginRun {
  const args = [
    "claude", "-p", prompt,
    "--plugin-dir", plugin,
    // Project-only settings from an empty cwd: the user's own hooks and plugins stay out of the run.
    "--setting-sources", "project",
    "--output-format", "stream-json", "--verbose", "--include-hook-events",
    "--allowedTools", "Read", "Grep", "Glob", "Bash(rg:*)",
  ];
  if (readDirs.length) args.push("--add-dir", ...readDirs);
  const { work, dir } = runDir(tmp);
  return { ...run(args, work, process.env, dir), plugin };
}

/** Probe a prompt-triggered skill in Claude Code. */
export function probeClaude(skill: Skill, allSkills: Skill[], readDirs: string[]): ProbeResult {
  const probe = promptProbe(skill);
  const { events, raw } = runClaude(probe.prompt, allSkills, readDirs);
  return { checks: evaluateClaude(events, skill.name, probe.expect), raw };
}

/** Codex's own session ids in its lead's shell (W4 invariant 35); Claude Code's all start `CLAUDE_CODE_`, Kimi sets none. */
const CODEX_SESSION_VARS = ["CODEX_THREAD_ID", "CODEX_SESSION_ID"];

/**
 * The caller's env without the session variables of the harness the probe was
 * started from, for the Kimi and Codex legs: a check or body reading one there
 * would read the caller's session, not the run's. The OpenCode legs have their
 * own (probe/opencode.ts probeEnv).
 */
export function withoutCallerSession(env: Record<string, string | undefined>): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(env).filter(([k]) => !k.startsWith("CLAUDE_CODE_") && !CODEX_SESSION_VARS.includes(k)));
}

export type KimiHome = { tmp: string; plugin: string; env: Record<string, string | undefined> };

/**
 * Build the Kimi plugin and a throwaway KIMI_CODE_HOME: config and login are
 * symlinked from the real home and the plugin is registered in a fresh
 * plugins/installed.json. config.toml is the exception: the probe gets a
 * derived copy (probeKimiConfig) without the owner's permission rules and hooks,
 * because a yolo mode or a catch-all allow rule would let a probed procedure run
 * tools unasked over ACP (W2 SEC-001, live: a shell `touch` ran with no request).
 */
export function kimiProbeHome(allSkills: Skill[]): KimiHome {
  const tmp = mkdtempSync(join(tmpdir(), "ktx-probe-"));
  const plugin = buildKimi(allSkills, join(tmp, "out"));

  const realHome = process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
  const home = join(tmp, "kimi-home");
  mkdirSync(join(home, "plugins"), { recursive: true });
  for (const entry of ["tui.toml", "credentials", "oauth", "device_id", "region"]) {
    if (existsSync(join(realHome, entry))) symlinkSync(join(realHome, entry), join(home, entry));
  }
  if (existsSync(join(realHome, "config.toml"))) {
    // It may hold provider API keys: owner-only, inside the owner-only temp dir.
    writeFileSync(join(home, "config.toml"), probeKimiConfig(readFileSync(join(realHome, "config.toml"), "utf8")), { mode: 0o600 });
  }
  // Kimi's own install record format (read from a real ~/.kimi-code/plugins/installed.json);
  // `/plugins install` does not complete in print mode.
  const now = new Date().toISOString();
  writeFileSync(join(home, "plugins", "installed.json"), JSON.stringify({
    version: 1,
    plugins: [{ id: PLUGIN_NAME, root: plugin, source: "local-path", enabled: true, installedAt: now, updatedAt: now, originalSource: plugin }],
  }, null, 2));
  return { tmp, plugin, env: { ...withoutCallerSession(process.env), KIMI_CODE_HOME: home } };
}

/** Tables (and their sub-tables) a probe must never inherit from the owner's Kimi config. */
const KIMI_UNSAFE_TABLE = /^\s*\[\[?\s*"?(permission|hooks)"?\s*[.\]]/;
/**
 * Root keys a probe must never inherit, including dotted forms such as permission.rules = [...].
 * The extra skill and agent roots are here because a same-named skill in one of them
 * wins over the plugin's copy (W3 invariant 30; D-W3-10).
 */
const KIMI_UNSAFE_KEY = /^\s*"?(default_permission_mode|permission|hooks|extra_skill_dirs|extra_agent_dirs)"?\s*[.=]/;
const TOML_TABLE = /^\s*\[/;

/** Net open brackets and braces on a line: > 0 while a multi-line inline value continues. */
function openBrackets(line: string): number {
  let depth = 0;
  for (const c of line) {
    if (c === "[" || c === "{") depth += 1;
    else if (c === "]" || c === "}") depth -= 1;
  }
  return depth;
}

/**
 * The owner's Kimi config.toml with every permission setting, hook and extra
 * skill or agent root removed and the permission mode forced to manual, so each
 * tool call has to ask (the probe's ACP client decides) and only the plugin's
 * skills can load. Models and providers are kept.
 * A config this line-level filter cannot clean fails the postconditions: the
 * probe stops rather than run with the owner's rules.
 */
export function probeKimiConfig(text: string): string {
  const kept: string[] = [];
  let root = true;
  let dropping = false;
  let continuing = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (continuing > 0) {
      continuing += openBrackets(line);
      continue;
    }
    if (TOML_TABLE.test(line)) {
      root = false;
      dropping = KIMI_UNSAFE_TABLE.test(line);
    } else if (root && KIMI_UNSAFE_KEY.test(line)) {
      continuing = Math.max(0, openBrackets(line.slice(line.indexOf("=") + 1)));
      continue;
    }
    if (!dropping) kept.push(line);
  }
  const out = `default_permission_mode = "manual"\n${kept.join("\n")}`;
  const parsed = Bun.TOML.parse(out) as Record<string, any>;
  // Postconditions: what makes the probe safe, read back the way Kimi reads it.
  assert(parsed.default_permission_mode === "manual", "probe Kimi config: permission mode is not manual");
  assert(parsed.permission === undefined, "probe Kimi config: permission settings survived");
  assert(parsed.hooks === undefined, "probe Kimi config: the owner's hooks survived");
  assert(parsed.extra_skill_dirs === undefined, "probe Kimi config: the owner's extra skill roots survived");
  assert(parsed.extra_agent_dirs === undefined, "probe Kimi config: the owner's extra agent roots survived");
  return out;
}

/**
 * Run `kimi -p <prompt>` in a throwaway home, with a read-only agent file that
 * limits the model to Read / Grep / Glob / Skill — print mode auto-approves
 * every tool, and a runbook answer must never turn into running the runbook.
 */
export function runKimi(prompt: string, allSkills: Skill[], readDirs: string[]): PluginRun {
  return runKimiIn(kimiProbeHome(allSkills), prompt, readDirs);
}

/** Run `kimi -p <prompt>` in an existing probe home (see kimiProbeHome). */
export function runKimiIn({ tmp, plugin, env }: KimiHome, prompt: string, readDirs: string[]): PluginRun {
  const agent = join(tmp, "ktx-probe.md");
  writeFileSync(agent, "---\nname: ktx-probe\ndescription: Read-only agent for ktx live probes.\ntools: Read, Grep, Glob, Skill\n---\n${base_prompt}\n");

  const args = ["kimi", "-p", prompt, "--output-format", "stream-json", "--agent-file", agent];
  for (const dir of readDirs) args.push("--add-dir", dir);
  const { work, dir } = runDir(tmp);
  return { ...run(args, work, env, dir), plugin };
}

/** Probe a prompt-triggered skill in Kimi print mode. */
export function probeKimi(skill: Skill, allSkills: Skill[], readDirs: string[]): ProbeResult {
  const probe = promptProbe(skill);
  const { events, raw } = runKimi(probe.prompt, allSkills, readDirs);
  return { checks: evaluateKimi(events, skill.name, probe.expect), raw };
}

// Codex's exec --json stream carries no hook events, so the evidence is the
// session rollout file, which records every message the model was given.
export function evaluateCodex(events: any[], rollout: any[], skill: string, expect: string[]): Check[] {
  const marker = `[ktx:${skill}]`;
  const hook = rollout.some((r) =>
    r.type === "response_item" && r.payload?.type === "message" && r.payload?.role !== "assistant" &&
    JSON.stringify(r.payload.content ?? "").includes(marker),
  );
  const answer = events
    .filter((e) => e.type === "item.completed" && e.item?.type === "agent_message")
    .map((e) => String(e.item.text ?? ""))
    .join("\n");
  const missing = missingPatterns(answer, expect);
  return [
    { name: "hook-fired", ok: hook, required: true, detail: `context given to the model contains ${marker}` },
    { name: "answer", ok: missing.length === 0, required: true, detail: missing.length ? `missing: ${missing.join(", ")}` : "all expect patterns matched" },
  ];
}

export type CodexHome = { tmp: string; home: string; plugin: string; env: Record<string, string | undefined> };
export type CodexRun = PluginRun & { rollout: any[] };

export type CodexBuild = { tmp: string; out: string; plugin: string };

/** Build the Codex plugin and its marketplace into a fresh temp dir, without running Codex. */
export function codexProbeBuild(allSkills: Skill[]): CodexBuild {
  const tmp = mkdtempSync(join(tmpdir(), "ktx-probe-"));
  const out = join(tmp, "out");
  return { tmp, out, plugin: buildCodex(allSkills, out) };
}

/** Build the Codex plugin and install it into a throwaway home (see codexProbeInstall). */
export function codexProbeHome(allSkills: Skill[]): CodexHome {
  return codexProbeInstall(codexProbeBuild(allSkills));
}

/**
 * Install a probe build with Codex's own CLI into a throwaway CODEX_HOME
 * (login symlinked, model settings carried over from the real config).
 */
export function codexProbeInstall({ tmp, out, plugin }: CodexBuild): CodexHome {
  const realHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const home = join(tmp, "codex-home");
  mkdirSync(home);
  symlinkSync(join(realHome, "auth.json"), join(home, "auth.json"));
  const real = existsSync(join(realHome, "config.toml")) ? Bun.TOML.parse(readFileSync(join(realHome, "config.toml"), "utf8")) as Record<string, unknown> : {};
  const carried = ["model", "model_reasoning_effort"].filter((k) => typeof real[k] === "string").map((k) => `${k} = ${JSON.stringify(real[k])}`);
  writeFileSync(join(home, "config.toml"), [...carried, "", "[features]", "hooks = true", ""].join("\n"));

  const env = { ...withoutCallerSession(process.env), CODEX_HOME: home };
  for (const step of [["codex", "plugin", "marketplace", "add", out], ["codex", "plugin", "add", `${PLUGIN_NAME}@${CODEX_MARKETPLACE}`]]) {
    const r = Bun.spawnSync(step, { env });
    if (r.exitCode !== 0) throw new Error(`${step.join(" ")} failed: ${r.stderr.toString().trim()}`);
  }
  return { tmp, home, plugin, env };
}

/**
 * Run `codex exec <prompt>` in a read-only sandbox in a throwaway home; return
 * the stream and the session rollout. Hook trust review is bypassed for this one run only.
 */
export function runCodex(prompt: string, allSkills: Skill[], readDirs: string[]): CodexRun {
  return runCodexIn(codexProbeHome(allSkills), prompt, readDirs);
}

/**
 * How a Codex probe run is sandboxed. `read-only` (the default) for every probe that
 * judges an answer; `workspace-write` with `cwd` = a probeProject for a procedure
 * whose body writes files (D-W3-7): Codex's fence is then cwd, /tmp and $TMPDIR,
 * with no network (W3 invariant 32). Nothing wider exists here on purpose.
 */
export type CodexRunOptions = { sandbox?: "read-only" | "workspace-write"; cwd?: string };

/** Run `codex exec <prompt>` in an existing probe home (see codexProbeHome). */
export function runCodexIn({ tmp, home, plugin, env }: CodexHome, prompt: string, readDirs: string[], opts: CodexRunOptions = {}): CodexRun {
  const sandbox = opts.sandbox ?? "read-only";
  assert(sandbox === "read-only" || sandbox === "workspace-write", `codex probe: sandbox ${sandbox} is not allowed`);
  // Seam S2: workspace-write widens the fence to cwd, so cwd must be a probe project
  // under this home's tmp (probeProject), never the tmp itself or anything outside it.
  assert(sandbox === "read-only" || isProbeProject(opts.cwd, tmp), "codex probe: workspace-write needs a probe project under the home's tmp as cwd");
  // Codex's --add-dir makes a dir writable under workspace-write, so a writing run grants
  // nothing beyond its project: the owner's runbook roots stay out of the fence.
  if (sandbox === "workspace-write") assert(readDirs.length === 0, "codex probe: workspace-write takes no --add-dir");
  const args = ["codex", "exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-hook-trust", "-s", sandbox];
  for (const dir of readDirs) args.push("--add-dir", dir);
  args.push(prompt);
  const { dir, work: runWork } = runDir(tmp);
  const work = opts.cwd ?? runWork;
  const before = new Set(rollouts(home));
  const { events, raw, exitCode } = run(args, work, env, dir);
  // This run's session: the one rollout that was not there before it (a home may
  // serve several runs). None or several new ones cannot be attributed, so the
  // run's checks see no rollout and fail closed.
  const own = runRollout(before, rollouts(home));
  const rollout = own ? parseLines(readFileSync(own, "utf8")) : [];
  return { events, raw, exitCode, rollout, plugin };
}

/** Probe a prompt-triggered skill in Codex. */
export function probeCodex(skill: Skill, allSkills: Skill[], readDirs: string[]): ProbeResult {
  const probe = promptProbe(skill);
  const { events, rollout, raw } = runCodex(probe.prompt, allSkills, readDirs);
  return { checks: evaluateCodex(events, rollout, skill.name, probe.expect), raw };
}

/**
 * A throwaway git checkout for a procedure probe (D-W3-7), under `tmp`. The real
 * path is returned so fences and path checks compare like with like (macOS
 * resolves /var to /private/var).
 */
export function probeProject(tmp: string, seed = false): string {
  const dir = realpathSync(mkdtempSync(join(tmp, "project-")));
  const r = Bun.spawnSync(["git", "init", "-q", dir]);
  assert(r.exitCode === 0, `probe project: git init failed in ${dir}`);
  if (seed) seedProject(dir);
  return dir;
}

/** What a seeded probe project holds: code that imports code, a test that reaches it, a manifest and a readme. */
const SEED_FILES: Record<string, string> = {
  "README.md": "# greeter\n\nA tiny command-line greeter. Run it with `bun src/cli.ts <name>`.\n",
  "package.json": '{ "name": "greeter", "scripts": { "start": "bun src/cli.ts", "test": "bun test" } }\n',
  "src/cli.ts": 'import { greet } from "./greet";\n\nconsole.log(greet(process.argv[2] ?? "world"));\n',
  "src/greet.ts": "/** The greeting for one name. */\nexport const greet = (name: string): string => `hello, ${name}`;\n",
  "tests/greet.test.ts": 'import { expect, test } from "bun:test";\nimport { greet } from "../src/greet";\n\ntest("greets by name", () => expect(greet("ada")).toBe("hello, ada"));\n',
  "docs/usage.md": "# Usage\n\nStart from `src/cli.ts`; the greeting itself is in `src/greet.ts`.\n",
};

/** Write SEED_FILES into a probe project and commit them under the probe's own identity (`probe.seed`). */
function seedProject(dir: string): void {
  for (const [rel, text] of Object.entries(SEED_FILES)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  // The owner's git config (name, signing, hooks) stays out of a throwaway commit.
  const git = ["git", "-C", dir, "-c", "user.name=ktx probe", "-c", "user.email=probe@ktx.invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null"];
  for (const args of [["add", "-A"], ["commit", "-q", "-m", "seed"]]) {
    const r = Bun.spawnSync([...git, ...args]);
    assert(r.exitCode === 0, `probe project: git ${args[0]} failed in ${dir}: ${r.stderr.toString().trim()}`);
  }
}

/** Whether `dir` is a probeProject under `tmp`: a real path strictly inside it with its own .git. */
export function isProbeProject(dir: string | undefined, tmp: string): boolean {
  if (dir === undefined || !existsSync(dir) || !existsSync(join(dir, ".git"))) return false;
  const real = realpathSync(dir);
  return real === dir && real.startsWith(realpathSync(tmp) + sep);
}

/** The `file` check (D-W3-7): the project file exists and matches every expect pattern. */
export function fileCheck(project: string, file: string, expect: string[]): Check {
  const path = resolve(project, file);
  // Seam S1 consumer: skill.ts already refuses such a path; a probe never reads outside its project.
  assert(path.startsWith(project + sep), `probe file ${file} leaves the probe project ${project}`);
  if (!existsSync(path)) return { name: "file", ok: false, required: true, detail: `${file} does not exist in the probe project` };
  // The body may leave a directory where the file belongs; that fails the check, it does not throw.
  if (!statSync(path).isFile()) return { name: "file", ok: false, required: true, detail: `${file} is not a regular file` };
  // The body could leave a symlink (the file or a directory on the way); a probe
  // reads only a file whose real path is still inside the project.
  if (!realpathSync(path).startsWith(project + sep)) {
    return { name: "file", ok: false, required: true, detail: `${file} resolves outside the probe project (a symlink)` };
  }
  const missing = missingPatterns(readFileSync(path, "utf8"), expect);
  return {
    name: "file",
    ok: missing.length === 0,
    required: true,
    detail: missing.length ? `${file}: missing: ${missing.join(", ")}` : `${file} matches all expect patterns`,
  };
}

/** A fresh directory per run under a probe build or home: its own cwd and stream file, so runs never overwrite each other. */
function runDir(tmp: string): { dir: string; work: string } {
  const dir = mkdtempSync(join(tmp, "run-"));
  const work = join(dir, "work");
  mkdirSync(work);
  return { dir, work };
}

/** The one rollout a run created: the path in `after` not in `before`, or undefined when there are none or several. */
export function runRollout(before: Set<string>, after: string[]): string | undefined {
  const fresh = after.filter((f) => !before.has(f));
  return fresh.length === 1 ? fresh[0] : undefined;
}

function rollouts(home: string): string[] {
  return [...new Bun.Glob("sessions/**/rollout-*.jsonl").scanSync({ cwd: home, absolute: true })];
}

export function parseLines(text: string): any[] {
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/** Run a harness command to completion (stdin closed) and save its stdout next to the probe. */
export function run(args: string[], cwd: string, env: Record<string, string | undefined>, tmp: string): StreamRun {
  const proc = Bun.spawnSync(args, { cwd, env, timeout: 600_000, stdin: "ignore" });
  const raw = join(tmp, "stream.jsonl");
  writeFileSync(raw, proc.stdout);
  return { events: parseLines(proc.stdout.toString()), raw, exitCode: proc.exitCode };
}
