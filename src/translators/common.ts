// Steps every plugin-style translator shares: copy skills (body unchanged), add
// harness-native frontmatter, and install the ktx-help runtime plus the
// triggers it reads.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { assert } from "../assert";
import type { HarnessName } from "../install/paths";
import { HARNESS_VARIANT_RE, promptTriggers, SKILL_TREE_DEPTH_MAX, variantBase, type Skill } from "../skill";

export const PLUGIN_NAME = "ktx";
/** Seconds a prompt hook may run before the harness gives up; the default is 600 on Codex. */
export const HOOK_TIMEOUT_S = 30;
/** Local marketplace name every harness registers ktx under: install ids are `ktx@ktx-local`. */
export const MARKETPLACE = "ktx-local";
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE}`;
const RUNTIME = join(import.meta.dir, "..", "..", "runtime", "ktx-help.sh");
/**
 * What every hook command starts with: the runtime runs as `bash <path> <harness>`,
 * never by its own path. macOS holds a newly written executable at its first launch,
 * and each build writes the runtime anew; a file handed to its interpreter is never
 * launched itself (Backlog 2026-10-01-hook-first-run-stall). OpenCode's plugin spawns
 * `bash` the same way (runtime/opencode-plugin.ts).
 */
export const HOOK_INTERPRETER = "bash";

/** Empty <outDir>/ktx (a rebuild must not keep a renamed or deleted file) and return it. */
export function resetPluginRoot(outDir: string): string {
  const root = join(outDir, PLUGIN_NAME);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

/** Whether any skill declares prompt triggers, i.e. whether the plugin ships a prompt hook. */
export function hasPromptTriggers(skills: Skill[]): boolean {
  return skills.some((s) => promptTriggers(s).length > 0);
}

/** One triggers.json entry, as runtime/ktx-help.sh reads it. `run` is "" for an instruction-only trigger. */
export type TriggerEntry = { skill: string; match: string; run: string; instruction: string };

/**
 * Copy each skill folder to <root>/skills/<name>, leaving out the translator-only
 * sidecar, for one harness's build.
 *
 * W4 translate track (D-W4-10, seam S1 consumer): a file named
 * `<base>.<harness>.<ext>` (HARNESS_VARIANT_RE) is copied as `<base>.<ext>` when
 * its harness is this build's, and left out otherwise; every other file is copied
 * under its own name. Postcondition, asserted on the built tree: no symlink, no
 * file whose name matches HARNESS_VARIANT_RE, and each variant base present under
 * its plain name with exactly the bytes of this harness's canonical variant.
 * The copy also refuses a canonical skill that keeps a plain name beside its
 * variants, and a variant set that names no variant for this harness (D-W4-10).
 */
export function copySkills(skills: Skill[], root: string, harness: HarnessName): void {
  const named = new Set<string>();
  for (const skill of skills) {
    // Two skills of one name share one build dir, and the second copy would meet
    // the first's settled names — a build tree no variant check could make sense of.
    assert(!named.has(skill.name), `copySkills: two skills named ${skill.name}`);
    named.add(skill.name);
    const dest = join(root, "skills", skill.name);
    // A link here would take the whole copy outside the build tree ktx wrote.
    assert(!lstatOrNull(dest)?.isSymbolicLink(), `built skill ${skill.name}: ${dest} is a symlink; ktx never writes through one`);
    const leftOut = new Set<string>(); // plain relative paths whose variant set has no build-harness member
    cpSync(skill.dir, dest, {
      recursive: true,
      // dereference: a symlink in a canonical skill is copied as its content, so no
      // build step (frontmatter, side files) can ever write through it to the source.
      dereference: true,
      filter: (src) => keepEntry(src, skill.dir, harness, leftOut),
    });
    const shipped = settleVariants(dest, skill.name, harness);
    assertVariantsShipped(skill, dest, harness, shipped, leftOut);
  }
}

/**
 * Whether a canonical entry belongs in a `harness` build (D-W4-10): the sidecar
 * never does, nor another harness's variant. Each base left out is recorded, so a
 * variant set that names no variant for this harness is refused rather than
 * building a skill with the file silently missing.
 */
function keepEntry(src: string, skillDir: string, harness: HarnessName, leftOut: Set<string>): boolean {
  const name = basename(src);
  if (name === "ktx.yaml") return false;
  // Only files are variants, as checkSkillFiles reads them. stat follows a link to a
  // directory; a dangling one answers null and is left for the copy itself to refuse.
  const stat = statSyncOrNull(src);
  if (!stat || stat.isDirectory()) return true;
  const m = name.match(HARNESS_VARIANT_RE);
  if (!m || m[2] === harness) return true;
  leftOut.add(join(dirname(relative(skillDir, src)), variantBase(name) as string));
  return false;
}

/**
 * Settle the variants the copy left under their canonical names in one skill's
 * build: this harness's take the plain name, and anything else the built tree
 * holds — another harness's variant, a link — is refused, not renamed over.
 * Returns each base this harness ships, mapped to the variant it came from.
 */
function settleVariants(dest: string, name: string, harness: HarnessName): Map<string, string> {
  const shipped = new Map<string, string>();
  const walk = (rel: string, depth: number): void => {
    // The build holds no links (asserted per entry below), so nothing here can run
    // away the way a link loop inside shared/ can; walking past the bound
    // checkSkillFiles applies means the tree is not the copy copySkills made (T5).
    assert(depth <= SKILL_TREE_DEPTH_MAX, `built skill ${name}: ${rel} is deeper than ${SKILL_TREE_DEPTH_MAX} levels; the build is not the copy copySkills made`);
    for (const e of readdirSync(join(dest, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      const path = join(dest, child);
      assert(!lstatSync(path).isSymbolicLink(), `built skill ${name}: ${child} is a symlink; copySkills dereferences`);
      if (e.isDirectory()) {
        walk(child, depth + 1);
        continue;
      }
      const m = e.name.match(HARNESS_VARIANT_RE);
      if (!m) continue;
      assert(m[2] === harness, `built skill ${name}: ${child} is another harness's variant; a build holds only its own (D-W4-10)`);
      const plain = rel ? `${rel}/${m[1]}${m[3]}` : `${m[1]}${m[3]}`;
      assert(!existsSync(join(dest, plain)), `built skill ${name}: ${plain} sits beside its per-harness variants; a canonical skill keeps only the variants (D-W4-10)`);
      renameSync(path, join(dest, plain));
      shipped.set(plain, child);
    }
  };
  walk("", 0);
  return shipped;
}

/**
 * Seam S1's postcondition, read off the built tree: every variant set ships as its
 * plain name with this harness's own bytes, and every set that named another
 * harness names this one too.
 */
function assertVariantsShipped(skill: Skill, dest: string, harness: HarnessName, shipped: Map<string, string>, leftOut: Set<string>): void {
  for (const base of leftOut) {
    assert(shipped.has(base), `built skill ${skill.name}: ${base} has no ${harness} variant, but another harness's variant sits beside it (D-W4-10)`);
  }
  for (const [base, variant] of shipped) {
    const built = readFileSync(join(dest, base));
    assert(built.equals(readFileSync(join(skill.dir, variant))), `built skill ${skill.name}: ${base} is not the bytes of ${variant} (D-W4-10)`);
  }
}

/** lstat that answers null instead of throwing, for a destination that is not there yet. */
export function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/** stat that answers null instead of throwing, for a dangling link. */
function statSyncOrNull(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

/** Write triggers.json and the runtime script; returns false when no skill has prompt triggers. */
export function installPromptTriggers(skills: Skill[], root: string): boolean {
  const triggers: TriggerEntry[] = skills.flatMap((s) =>
    promptTriggers(s).map((t) => ({
      skill: s.name,
      match: t.match,
      run: t.run ?? "",
      instruction: s.sidecar?.instruction ?? "",
    })),
  );
  if (!triggers.length) return false;
  // Producer side of the triggers.json seam; ktx-help.sh skips any entry that breaks it.
  for (const t of triggers) {
    assert(t.skill && t.match && t.instruction.trim(), `triggers.json entry for ${t.skill} needs skill, match and instruction`);
    // Same rule as the consumer in ktx-help.sh: no "..", anywhere.
    assert(!t.run.startsWith("/") && !t.run.includes(".."), `triggers.json run for ${t.skill} must be skill-relative`);
  }
  writeJson(join(root, "triggers.json"), triggers);
  mkdirSync(join(root, "runtime"), { recursive: true });
  cpSync(RUNTIME, join(root, "runtime", "ktx-help.sh"));
  return true;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/**
 * Add harness-only keys to a SKILL.md's frontmatter and return the new text.
 * The body after the frontmatter is returned byte-for-byte (D-W2-3); a key the
 * canonical frontmatter already has is refused, since the canonical file is
 * spec-only. Values are written as YAML scalars: true, or a double-quoted string;
 * or, for a map such as OpenCode's `metadata` (W5 seam S3), one level of
 * `"<key>": <boolean>` entries, keys lowercase with `-` and `/` allowed. A map
 * key the canonical file already has as a map (the spec's own `metadata`) is
 * merged: the canonical block is rewritten with its entries first, then the new
 * ones, and an entry both sides name is refused (W-A4).
 */
export type FrontmatterValue = string | true | Record<string, boolean>;
export function withFrontmatter(md: string, keys: Record<string, FrontmatterValue>): string {
  const m = md.match(FRONTMATTER_RE);
  assert(m, "withFrontmatter: SKILL.md must start with --- frontmatter ---");
  const canonical = Bun.YAML.parse(m[1]) as Record<string, unknown>;
  let head = m[1];
  const expected: Record<string, unknown> = { ...canonical };
  const lines = Object.entries(keys).map(([k, v]) => {
    const merge = typeof v === "object" && isMap(canonical[k]);
    assert(/^[a-z][a-z-]*$/.test(k) && (merge || !(k in canonical)), `withFrontmatter: key ${k} must be new and lowercase`);
    if (typeof v !== "object") {
      expected[k] = v;
      return `${k}: ${v === true ? "true" : JSON.stringify(v)}`;
    }
    const entries = Object.entries(v);
    assert(entries.length > 0, `withFrontmatter: map ${k} must not be empty`);
    for (const [sub] of entries) assert(/^[a-z][a-z0-9/-]*$/.test(sub), `withFrontmatter: map key ${k}.${sub} must be lowercase`);
    const kept = merge ? Object.entries(canonical[k] as Record<string, unknown>) : [];
    for (const [sub] of entries) assert(!kept.some(([c]) => c === sub), `withFrontmatter: ${k}.${sub} is already in the canonical file`);
    if (merge) head = withoutKey(head, k);
    const merged = [...kept, ...entries];
    expected[k] = Object.fromEntries(merged);
    return [`${k}:`, ...merged.map(([sub, b]) => `  ${JSON.stringify(sub)}: ${JSON.stringify(b)}`)].join("\n");
  });
  const body = md.slice(m[0].length);
  const out = `---\n${head}\n${lines.map((l) => `${l}\n`).join("")}---\n${body}`;
  // Postcondition, read back the way a harness reads it: the new frontmatter
  // ends where the old one did, so the body a harness sees is the canonical one,
  // and every key — canonical and added — parses back to its value.
  const back = out.match(FRONTMATTER_RE);
  assert(back && out.slice(back[0].length) === body, "withFrontmatter: body changed");
  const parsed = Bun.YAML.parse(back[1]) as Record<string, unknown>;
  for (const [k, v] of Object.entries(expected)) {
    assert(JSON.stringify(parsed[k]) === JSON.stringify(v), `withFrontmatter: ${k} did not read back as written`);
  }
  return out;
}

const isMap = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Frontmatter text without top-level key `k`: its own line and its block — every
 * indented line up to the next top-level key, with the blank and comment lines YAML
 * allows between them. A blank or comment line after the block's last entry stays.
 */
function withoutKey(head: string, k: string): string {
  const lines = head.split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`${k}:`));
  assert(start >= 0, `withFrontmatter: no top-level ${k} line to rewrite`);
  let end = start + 1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^[ \t]/.test(lines[i])) end = i + 1;
    else if (lines[i].trim() !== "" && !lines[i].startsWith("#")) break;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("\n");
}

/**
 * The parsed frontmatter of the SKILL.md at `path`, or null when the file is
 * missing, has no frontmatter, or does not parse. Predicates such as each
 * translator's userOnly() answer "no" for a broken file rather than throw.
 */
export function readFrontmatter(path: string): Record<string, unknown> | null {
  const text = readText(path);
  const data = text === null ? null : parseYaml(text.match(FRONTMATTER_RE)?.[1]);
  return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
}

/** A parsed YAML file, or null when it is missing or does not parse. */
export function readYaml(path: string): unknown {
  const text = readText(path);
  return text === null ? null : parseYaml(text);
}

/** A file's text, or null when it is missing, a directory, or unreadable. */
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseYaml(text: string | undefined): unknown {
  if (text === undefined) return null;
  try {
    return Bun.YAML.parse(text);
  } catch {
    return null;
  }
}

/** Rewrite the built copy of one skill's SKILL.md with extra frontmatter keys. */
export function addFrontmatter(root: string, skill: string, keys: Record<string, FrontmatterValue>): void {
  const path = join(root, "skills", skill, "SKILL.md");
  // copySkills dereferences, so a link here means the build tree was not made by it.
  assert(!lstatSync(path).isSymbolicLink(), `addFrontmatter: ${path} is a symlink; the build never writes through one`);
  writeFileSync(path, withFrontmatter(readFileSync(path, "utf8"), keys));
}

/** Write hooks/hooks.json with one UserPromptSubmit command hook (the Claude and Codex shape). */
export function writePromptHook(root: string, command: string): void {
  writeJson(join(root, "hooks", "hooks.json"), {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] }] },
  });
}

export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}
