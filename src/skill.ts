// Load and validate a canonical ktx skill: a folder holding SKILL.md (Agent
// Skills spec, six frontmatter fields only) and an optional ktx.yaml sidecar
// that only translators read.
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { assert } from "./assert";
import { HARNESS_NAMES, type HarnessName } from "./install/paths";

/** Before the model sees a matching prompt: inject `instruction`, plus the output of `run` when set. */
export type PromptTrigger = { on: "prompt"; match: string; run?: string };
/** A procedure the user starts by name; the model may offer it but never starts it (D-W2-1). */
export type InvokeTrigger = { on: "invoke"; args?: string };
export type Trigger = PromptTrigger | InvokeTrigger;
/**
 * A prompt skill's probe sends `prompt`; a procedure's probe invokes it natively
 * with `args`, and `offer.prompt` (optional) checks the model offers it unprompted.
 * `file` (procedures only) makes it a probe of a body that uses tools: the run gets
 * a throwaway project inside an OS fence, and `expect` is matched against that
 * project-relative file after the run instead of the answer (D-W3-7).
 * `wave` (procedures only) runs the body in the same fenced project with the
 * harness's spawn tool granted, as a throwaway wave of `members` members, each
 * told to return one generated marker (D-W4-7); `args` holds `{markers}` once.
 * `tools` (procedures only) runs it in the fenced project with tools allowed and
 * matches `expect` against the answer (D-W4-13). `file`, `wave` and `tools` are
 * mutually exclusive. `seed` (with `file` only) starts the project with a small
 * committed source tree, for a body that reads the repo it runs in.
 */
export type Probe = {
  prompt?: string;
  args?: string;
  expect: string[];
  offer?: { prompt: string };
  file?: string;
  seed?: true;
  wave?: { members: number };
  tools?: true;
};
export type Sidecar = { schema: 1; instruction?: string; triggers?: Trigger[]; probe?: Probe };

/** Replaced in `instruction` by the harness's own invocation of the skill (see invocation()). */
export const INVOKE_PLACEHOLDER = "{invoke}";

/** Replaced in a wave probe's `args` by the generated member markers (src/probe/wave.ts). */
export const MARKERS_PLACEHOLDER = "{markers}";

/** A wave probe's member count: at least 2 (a wave), at most Codex's 6 threads (W4 invariant 21). */
export const WAVE_MEMBERS_MIN = 2;
export const WAVE_MEMBERS_MAX = 6;

/** Codex's TUI cuts a skill body at this many bytes (W3 invariant 3); detail belongs in files beside SKILL.md. */
export const SKILL_MD_MAX_BYTES = 8000;

/**
 * A per-harness variant file (D-W4-10): `<base>.<harness>.<ext>`, e.g.
 * `harness.kimi.md` or `scripts/locate.codex.ts`. Groups: 1 base, 2 harness, 3 ext.
 * A build copies its own harness's variant as `<base>.<ext>` and drops the others.
 */
export const HARNESS_VARIANT_RE = /^(.+)\.(claude|kimi|codex|opencode)(\.[A-Za-z0-9]+)$/;

/** The plain name a variant builds to (`harness.kimi.md` → `harness.md`), or null for a non-variant name. */
export function variantBase(name: string): string | null {
  const m = name.match(HARNESS_VARIANT_RE);
  return m ? `${m[1]}${m[3]}` : null;
}

/**
 * How many directory levels checkSkillFiles walks below a skill. Every shipped file
 * sits at most 1 level down (`references/…`, `scripts/…`, `lenses/…` through links
 * into shared/), so 8 leaves room and still stops a link loop inside shared/ (T5).
 */
export const SKILL_TREE_DEPTH_MAX = 8;

/**
 * The frozen `## ` headings of every harness sheet, `harness.<harness>.md`, in
 * order (D-W4-4, seam S2). Bodies cite a section as `harness.md § <heading>`.
 */
export const SHEET_HEADINGS = [
  "Spawn",
  "Wait and resume",
  "Member permissions",
  "Models",
  "Lens command",
  "Transcripts",
  "Notify and background",
] as const;

export type Skill = {
  name: string;
  description: string;
  dir: string;
  frontmatter: Record<string, unknown>;
  sidecar?: Sidecar;
};

const SPEC_KEYS = ["name", "description", "license", "compatibility", "metadata", "allowed-tools"];
export const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

class SkillError extends Error {
  constructor(dir: string, message: string) {
    super(`${basename(dir)}: ${message}`);
  }
}

function parseFrontmatter(dir: string): Record<string, unknown> {
  const raw = readFileSync(join(dir, "SKILL.md"));
  if (raw.byteLength > SKILL_MD_MAX_BYTES) {
    throw new SkillError(dir, `SKILL.md is ${raw.byteLength} bytes; the limit is ${SKILL_MD_MAX_BYTES} (Codex's TUI truncates a skill body there) — move detail into files beside it`);
  }
  const text = raw.toString("utf8");
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) throw new SkillError(dir, "SKILL.md must start with --- frontmatter ---");
  const data = Bun.YAML.parse(m[1]);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SkillError(dir, "frontmatter must be a YAML mapping");
  }
  return data as Record<string, unknown>;
}

function validateFrontmatter(dir: string, fm: Record<string, unknown>): void {
  const extra = Object.keys(fm).filter((k) => !SPEC_KEYS.includes(k));
  if (extra.length) {
    throw new SkillError(dir, `frontmatter keys outside the Agent Skills spec: ${extra.join(", ")} (put extensions in ktx.yaml)`);
  }
  const { name, description, compatibility, metadata } = fm;
  if (typeof name !== "string" || name.length < 1 || name.length > 64 || !NAME_RE.test(name)) {
    throw new SkillError(dir, "name must be 1-64 lowercase letters, digits and single hyphens");
  }
  if (name !== basename(dir)) throw new SkillError(dir, `name "${name}" must match its directory`);
  if (typeof description !== "string" || description.length < 1 || description.length > 1024) {
    throw new SkillError(dir, "description must be 1-1024 characters");
  }
  if (compatibility !== undefined && (typeof compatibility !== "string" || compatibility.length > 500)) {
    throw new SkillError(dir, "compatibility must be a string of at most 500 characters");
  }
  if (metadata !== undefined) {
    const ok = typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) &&
      Object.values(metadata).every((v) => typeof v === "string");
    if (!ok) throw new SkillError(dir, "metadata must map strings to strings");
  }
}

function onlyKeys(dir: string, where: string, obj: Record<string, unknown>, allowed: string[]): void {
  const extra = Object.keys(obj).filter((k) => !allowed.includes(k));
  if (extra.length) throw new SkillError(dir, `ktx.yaml ${where}: unknown keys ${extra.join(", ")}`);
}

function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function checkPromptTrigger(dir: string, t: Record<string, unknown>, i: number): void {
  onlyKeys(dir, `triggers[${i}]`, t, ["on", "match", "run"]);
  if (typeof t.match !== "string" || !t.match) throw new SkillError(dir, `triggers[${i}].match must be a pattern`);
  try {
    new RegExp(t.match, "i");
  } catch {
    throw new SkillError(dir, `triggers[${i}].match is not a valid pattern: ${t.match}`);
  }
  if (t.run === undefined) return;
  if (typeof t.run !== "string" || !t.run) throw new SkillError(dir, `triggers[${i}].run must be a path when set`);
  // The same rule the triggers.json producer and the runtime apply: skill-relative, no "..".
  if (t.run.startsWith("/") || t.run.includes("..")) {
    throw new SkillError(dir, `triggers[${i}].run must stay inside the skill directory`);
  }
  const target = resolve(dir, t.run);
  if (!existsSync(target) || !statSync(target).isFile() || !(statSync(target).mode & 0o111)) {
    throw new SkillError(dir, `triggers[${i}].run ${t.run} is missing or not executable`);
  }
}

function checkInvokeTrigger(dir: string, t: Record<string, unknown>, i: number): void {
  onlyKeys(dir, `triggers[${i}]`, t, ["on", "args"]);
  if (t.args !== undefined && (typeof t.args !== "string" || !t.args.trim() || /[\r\n]/.test(t.args))) {
    throw new SkillError(dir, `triggers[${i}].args must be a one-line argument hint`);
  }
}

function checkProbe(dir: string, probe: Record<string, any>, invoked: boolean, prompted: boolean): void {
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) throw new SkillError(dir, "ktx.yaml probe must be a mapping");
  onlyKeys(dir, "probe", probe, ["prompt", "args", "expect", "offer", "file", "seed", "wave", "tools"]);
  const { prompt, args, expect, offer, file, seed, wave, tools } = probe;
  if (!Array.isArray(expect) || !expect.length || !expect.every((e) => typeof e === "string" && e)) {
    throw new SkillError(dir, "ktx.yaml probe needs a non-empty expect list");
  }
  for (const e of expect) {
    try {
      new RegExp(e, "i");
    } catch {
      throw new SkillError(dir, `ktx.yaml probe.expect is not a valid pattern: ${e}`);
    }
  }
  if (!invoked) {
    if (typeof prompt !== "string" || !prompt || args !== undefined || offer !== undefined || file !== undefined ||
      seed !== undefined || wave !== undefined || tools !== undefined) {
      throw new SkillError(dir, "ktx.yaml probe of a prompt skill takes a prompt, not args, offer, file, wave or tools");
    }
    return;
  }
  if ([file, wave, tools].filter((v) => v !== undefined).length > 1) {
    throw new SkillError(dir, "ktx.yaml probe takes at most one of file, wave and tools");
  }
  if (file !== undefined) checkProbeFile(dir, file);
  if (seed !== undefined && seed !== true) throw new SkillError(dir, "ktx.yaml probe.seed must be true when set");
  if (seed !== undefined && file === undefined) throw new SkillError(dir, "ktx.yaml probe.seed needs probe.file: only the file leg's project is seeded");
  if (typeof args !== "string" || prompt !== undefined) {
    throw new SkillError(dir, "ktx.yaml probe of an invoked skill takes args (a string, may be empty), not a prompt");
  }
  if (wave !== undefined) checkProbeWave(dir, wave, args);
  if (tools !== undefined && tools !== true) throw new SkillError(dir, "ktx.yaml probe.tools must be true when set");
  if (offer === undefined) return;
  if (!offer || typeof offer !== "object" || Array.isArray(offer)) throw new SkillError(dir, "ktx.yaml probe.offer must be a mapping");
  onlyKeys(dir, "probe.offer", offer, ["prompt"]);
  if (typeof offer.prompt !== "string" || !offer.prompt) throw new SkillError(dir, "ktx.yaml probe.offer needs a prompt");
  if (!prompted) throw new SkillError(dir, "ktx.yaml probe.offer needs a prompt trigger to fire the offer");
}

/**
 * Seam S1 producer: a probe file is a plain relative path to a file strictly inside the
 * probe project. Every segment must name something, so `.`, `a/./b`, `a//b` and a
 * trailing `/` are refused here rather than tripping fileCheck's assertion mid-probe.
 */
function checkProbeFile(dir: string, file: unknown): void {
  const refuse = (why: string) => new SkillError(dir, `ktx.yaml probe.file must be a relative path to a file inside the probe project: ${why}`);
  if (typeof file !== "string" || file.trim() === "") throw refuse("it is empty or not a string");
  if (file.startsWith("/")) throw refuse("no leading /");
  if (file.includes("\\")) throw refuse("no \\");
  if (file.includes("\0")) throw refuse("no NUL byte");
  for (const segment of file.split("/")) {
    if (segment === "..") throw refuse("no ..");
    if (segment === "" || segment === ".") throw refuse("no empty or . segment, no trailing /");
  }
}

/** Seam S5 producer: a wave probe names its member count and leaves one slot for the markers. */
function checkProbeWave(dir: string, wave: unknown, args: string): void {
  if (!wave || typeof wave !== "object" || Array.isArray(wave)) throw new SkillError(dir, "ktx.yaml probe.wave must be a mapping");
  onlyKeys(dir, "probe.wave", wave as Record<string, unknown>, ["members"]);
  const members = (wave as Record<string, unknown>).members;
  if (!Number.isInteger(members) || (members as number) < WAVE_MEMBERS_MIN || (members as number) > WAVE_MEMBERS_MAX) {
    throw new SkillError(dir, `ktx.yaml probe.wave.members must be an integer from ${WAVE_MEMBERS_MIN} to ${WAVE_MEMBERS_MAX}`);
  }
  if (args.split(MARKERS_PLACEHOLDER).length !== 2) {
    throw new SkillError(dir, `ktx.yaml probe.args of a wave probe must hold ${MARKERS_PLACEHOLDER} exactly once`);
  }
}

/**
 * Seam S1 producer (D-W4-10, D-W4-11): every symlink in the skill resolves to an
 * existing path inside `sharedRoot`; every variant set names all three harnesses,
 * with no plain `<base>.<ext>` beside it; every harness sheet has SHEET_HEADINGS.
 */
export function checkSkillFiles(dir: string, sharedRoot: string): void {
  const shared = realOrNull(sharedRoot);
  const variants = new Map<string, Set<string>>(); // plain relative path -> harnesses seen
  const plain = new Set<string>();
  const walk = (rel: string, depth: number): void => {
    // The walk follows links into shared/, so a link there that points back up would
    // recurse without end; a real skill tree is a few levels deep (TigerStyle T5).
    if (depth > SKILL_TREE_DEPTH_MAX) {
      throw new SkillError(dir, `${rel} is deeper than ${SKILL_TREE_DEPTH_MAX} levels; a link inside shared/ may point back up`);
    }
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const abs = join(dir, relPath);
      if (e.isSymbolicLink()) {
        const target = realOrNull(abs);
        if (target === null) throw new SkillError(dir, `${relPath} is a dangling symlink`);
        if (shared === null || !(target === shared || target.startsWith(shared + sep))) {
          throw new SkillError(dir, `${relPath} links outside shared/ (${target}); a skill links only into shared/ (D-W4-11)`);
        }
      }
      if (statSync(abs).isDirectory()) {
        walk(relPath, depth + 1);
        continue;
      }
      const m = e.name.match(HARNESS_VARIANT_RE);
      if (!m) {
        plain.add(relPath);
        continue;
      }
      const base = rel ? `${rel}/${variantBase(e.name)}` : (variantBase(e.name) as string);
      variants.set(base, (variants.get(base) ?? new Set()).add(m[2]));
      if (basename(base) === "harness.md" && !rel) checkSheet(dir, relPath);
    }
  };
  walk("", 0);
  for (const [base, seen] of variants) {
    const missing = HARNESS_NAMES.filter((h) => !seen.has(h));
    if (missing.length) throw new SkillError(dir, `variant set ${base} has no ${missing.join(", ")} variant (D-W4-10)`);
    if (plain.has(base)) throw new SkillError(dir, `${base} sits beside its per-harness variants; keep only the variants (D-W4-10)`);
  }
}

/**
 * Seam S2 producer: a harness sheet's `## ` headings are exactly SHEET_HEADINGS, in
 * order, and each section carries text — a body's `harness.md § X` cite into a bare
 * heading answers nothing (adversarial lens C3).
 */
function checkSheet(dir: string, relPath: string): void {
  const lines = readFileSync(join(dir, relPath), "utf8").split(/\r?\n/);
  const starts = lines.flatMap((l, i) => (l.startsWith("## ") ? [i] : []));
  const headings = starts.map((i) => lines[i]!.slice(3).trim());
  if (headings.join("\n") !== SHEET_HEADINGS.join("\n")) {
    throw new SkillError(dir, `${relPath} must have exactly the ## headings ${SHEET_HEADINGS.join(" / ")}, in order; it has ${headings.join(" / ") || "none"}`);
  }
  starts.forEach((start, k) => {
    const body = lines.slice(start + 1, starts[k + 1] ?? lines.length);
    if (!body.some((l) => l.trim() !== "")) {
      throw new SkillError(dir, `${relPath} section "## ${headings[k]}" is empty; each section answers the body's cites into it (S2)`);
    }
  });
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function loadSidecar(dir: string): Sidecar | undefined {
  const path = join(dir, "ktx.yaml");
  if (!existsSync(path)) return undefined;
  const data = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, any>;
  if (!data || typeof data !== "object") throw new SkillError(dir, "ktx.yaml must be a YAML mapping");
  onlyKeys(dir, "top level", data, ["schema", "instruction", "triggers", "probe"]);
  if (data.schema !== 1) throw new SkillError(dir, "ktx.yaml schema must be 1");

  const triggers: Trigger[] = data.triggers ?? [];
  if (!Array.isArray(triggers)) throw new SkillError(dir, "ktx.yaml triggers must be a list");
  triggers.forEach((t, i) => {
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new SkillError(dir, `triggers[${i}] must be a mapping`);
    if (t.on === "invoke") return checkInvokeTrigger(dir, t, i);
    if (t.on === "prompt") return checkPromptTrigger(dir, t, i);
    throw new SkillError(dir, `triggers[${i}].on must be "prompt" or "invoke"`);
  });
  const invokes = triggers.filter((t) => t.on === "invoke").length;
  if (invokes > 1) throw new SkillError(dir, "ktx.yaml may declare at most one invoke trigger");
  const prompts = triggers.length - invokes;
  if (prompts && (typeof data.instruction !== "string" || !data.instruction.trim())) {
    throw new SkillError(dir, "ktx.yaml instruction is required when prompt triggers are declared");
  }
  if (typeof data.instruction === "string" && data.instruction.includes(INVOKE_PLACEHOLDER) && !invokes) {
    throw new SkillError(dir, `ktx.yaml instruction uses ${INVOKE_PLACEHOLDER} but the skill has no invoke trigger`);
  }
  // lstat, not exists: a dangling symlink counts too, since a build would write through it.
  if (invokes && lstatOrNull(join(dir, "agents", "openai.yaml"))) {
    throw new SkillError(dir, "agents/openai.yaml is generated for a procedure's Codex build; remove it from the canonical skill");
  }
  if (data.probe !== undefined) checkProbe(dir, data.probe, invokes > 0, prompts > 0);
  return { schema: 1, instruction: data.instruction, triggers, probe: data.probe };
}

export function loadSkill(dir: string): Skill {
  const frontmatter = parseFrontmatter(dir);
  validateFrontmatter(dir, frontmatter);
  // Canonical shared files sit beside the skills root (D-W4-11): <repo>/shared.
  checkSkillFiles(dir, resolve(dir, "..", "..", "shared"));
  return {
    name: frontmatter.name as string,
    description: frontmatter.description as string,
    dir,
    frontmatter,
    sidecar: loadSidecar(dir),
  };
}

export function loadSkills(root: string): Skill[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md")))
    .map((e) => loadSkill(join(root, e.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The skill's prompt triggers, in declaration order. */
export function promptTriggers(skill: Skill): PromptTrigger[] {
  return (skill.sidecar?.triggers ?? []).filter((t): t is PromptTrigger => t.on === "prompt");
}

/** The skill's invoke trigger, if it is a procedure. */
export function invokeTrigger(skill: Skill): InvokeTrigger | undefined {
  return (skill.sidecar?.triggers ?? []).find((t): t is InvokeTrigger => t.on === "invoke");
}

/**
 * What a user types to start a procedure skill in each harness (W2 invariants 5, 8, 13):
 * Claude `/ktx:<skill>`, Kimi `/skill:<skill>` (unqualified), Codex `$ktx:<skill>`,
 * OpenCode `/ktx/<skill>` (the command file commands/ktx/<skill>.md, D-W5-6).
 * runtime/ktx-help.sh maps {invoke} the same way; tests/runtime.test.ts pairs the two.
 */
export function invocation(harness: HarnessName, skill: string): string {
  assert(skill.length <= 64 && NAME_RE.test(skill), `invocation: not a skill name: ${skill}`);
  if (harness === "claude") return `/ktx:${skill}`;
  if (harness === "kimi") return `/skill:${skill}`;
  if (harness === "codex") return `$ktx:${skill}`;
  // No catch-all: a new harness needs its own form (W5 invariant 35).
  assert(harness === "opencode", `invocation: unknown harness ${harness}`);
  return `/ktx/${skill}`;
}
