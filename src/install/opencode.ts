// OpenCode adapter for ktx install / doctor (D-W5-2, D-W5-8, D-W5-9).
// install: buildOpencode into <data>/opencode, then placeBuild into OpenCode's
// config dir (harnessHome("opencode")). No opencode.json(c) edit, ever.
// doctor steps: placed (every owned path exists), stale (the installed owned
// tree's hash vs a fresh build, manifest excluded), plugin (plugins/ktx.ts
// equals the build's), shadowed-skill (S5 consumer).
//
// Seam S1 consumer (placeBuild): refuses a build root whose top-level entries
// differ from ownedPaths(skills)'s; removes every path the INSTALLED manifest's
// `owned` lists (a previous build's, so a renamed or deleted skill leaves nothing
// behind) and every path the new build owns, then writes exactly the new build's
// owned paths under configDir and nothing outside them. Every removed or written
// entry has ownedPaths' shape (skills/<id>, commands/ktx, plugins/ktx.ts, ktx) and
// no existing parent under configDir that is a symlink (W-A1), asserted before any
// removal; no installed manifest (a first install) removes only the new
// build's paths; an installed `owned` that is unreadable or not a list of such
// paths throws before anything is removed. Never touches opencode.json(c),
// service.json or cli.json (OpenCode's own files, invariant 18).
// Seam S5 consumer (shadowStep, D-W5-9 as amended at the contract lens):
// skill sources are OpenCode's built-in skill ids (opencode, report),
// ~/.claude/skills and ~/.agents/skills (home = OPENCODE_TEST_HOME, else HOME),
// <config-dir>/skill (singular), <config-dir>/skills (every file but ktx's own
// <id>/SKILL.md, W-A5), and the `skills` entries of the config dir's opencode.json
// and opencode.jsonc, each scanned as OpenCode does — top-level `<id>.md` and
// SKILL.md at any depth, named by its folder (W-R7); command sources are <config-dir>/command
// (singular) and the `commands` and legacy `command` keys of those two files
// (OpenCode merges both, normalize.ts; W5 invariants 7, 11, 13). A ktx skill id
// or ktx command name (`ktx/<n>`) defined by any of them fails the step,
// whichever side wins, unless that directory SOURCE ROOT (the skills or command
// dir itself, e.g. ~/.claude/skills — not the skill's own folder), after ~
// expansion and realpath on both sides, equals an `opencode.expected-shadows`
// entry. A built-in id or a config-file key is never expected. An unresolvable
// listed dir is named in the detail, never thrown.
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { assert } from "../assert";
import { invokeTrigger, NAME_RE, type Skill } from "../skill";
import { lstatOrNull } from "../translators/common";
import { buildOpencode, OPENCODE_MANIFEST, ownedPaths } from "../translators/opencode";
import { dataDir, harnessHome, userHome } from "./paths";
import { shortHash, stampVersion, treeHash } from "./stamp";
import type { Ctx, Installer, Step } from "./types";

/** OpenCode's own skill ids (packages/core/src/plugin/skill.ts); a ktx id equal to one of them never passes (D-W5-9). */
const BUILTIN_SKILLS = ["opencode", "report"];
/** The owner's list of dirs whose own copy of a ktx skill may share its name (D-W5-9, contract lens A7). */
const EXPECTED_SHADOWS_KEY = "opencode.expected-shadows";
/** The two files OpenCode reads at every level; both are JSONC (invariant 17). */
const CONFIG_FILES = ["opencode.json", "opencode.jsonc"];
/** The compatibility roots OpenCode reads under its home (invariants 7, 19), each with a `skills` dir. */
const COMPAT_DIRS = [".claude", ".agents"];
/** What every gap's detail tells the owner to do: one install command rewrites the whole layout. */
const REMEDY = "run ktx install opencode";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The strings of a config entry that is meant to be a list of them. */
const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((e): e is string => typeof e === "string" && e !== "") : [];

/** OpenCode's config dir for this run: every path ktx writes or reports is built from it. */
function configDirOf(ctx: Ctx): string {
  const home = harnessHome("opencode", ctx.env);
  // Every path the steps print is built from this and promised as absolute; a
  // relative one would resolve against ktx's own cwd, which is a caller bug.
  assert(isAbsolute(home), `opencode: the config dir must be absolute, got ${home}`);
  return home;
}

/** The first path segment of each owned path: the build root's top-level entries (S1). */
const topLevel = (paths: string[]): Set<string> => new Set(paths.map((p) => p.split("/")[0]));

/** The only paths ktx ever owns in the config dir: the shapes ownedPaths produces (S1). */
function isOwnedShape(rel: string): boolean {
  if (rel === "commands/ktx" || rel === "plugins/ktx.ts" || rel === "ktx") return true;
  const [dir, id, ...rest] = rel.split("/");
  return dir === "skills" && rest.length === 0 && id !== undefined && id.length <= 64 && NAME_RE.test(id);
}

/**
 * A path of ownedPaths' shape whose existing parents under `configDir` are real
 * directories — the only kind placeBuild removes or writes. The check is on disk,
 * not lexical (W-A1): a symlinked `skills` or `commands` would carry rmSync and
 * cpSync out of the config dir. The config dir itself may be a link (a dotfiles
 * checkout); a leaf link is removed as a link, since rmSync does not follow it.
 */
function assertContained(rel: string, configDir: string): void {
  assert(
    typeof rel === "string" && isOwnedShape(rel),
    `placeBuild: an owned path must be skills/<id>, commands/ktx, plugins/ktx.ts or ktx, got ${JSON.stringify(rel)}`,
  );
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    const parent = join(configDir, ...parts.slice(0, i));
    const stat = lstatOrNull(parent);
    assert(stat === null || (!stat.isSymbolicLink() && stat.isDirectory()),
      `placeBuild: ${parent} is a symlink or not a directory; ${JSON.stringify(rel)} would resolve outside ${configDir}`);
  }
}

/** The installed manifest's `owned` list as it sits on disk: a real list, or why it cannot be used. */
type OwnedRead = { owned: string[] } | { problem: string };

function readOwned(configDir: string): OwnedRead {
  const path = join(configDir, OPENCODE_MANIFEST);
  if (!existsSync(path)) return { problem: `no installed manifest at ${path} — ${REMEDY}` };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { problem: `${path} does not parse: ${(err as Error).message}` };
  }
  const owned = isRecord(data) ? data.owned : undefined;
  if (!Array.isArray(owned) || owned.some((e) => typeof e !== "string" || e === "")) {
    return { problem: `${path}: "owned" must be a list of non-empty relative paths` };
  }
  // doctor hashes these paths and install removes them: both refuse what is not ktx's
  // own shape, so the two verbs agree about the same file (re-verdict, after W-A1).
  const foreign = owned.filter((e) => !isOwnedShape(e as string));
  if (foreign.length) {
    return { problem: `${path}: "owned" names ${JSON.stringify(foreign)}, not skills/<id>, commands/ktx, plugins/ktx.ts or ktx — ${REMEDY}` };
  }
  return { owned: owned as string[] };
}

/**
 * Copy a build's owned paths into OpenCode's config dir (S1 consumer): the installed
 * manifest's `owned` and the new build's paths are removed first, then exactly the new
 * owned paths are written. A build root that is not the S1 shape, and a manifest this
 * cannot read, both throw before anything is removed.
 */
export function placeBuild(root: string, configDir: string, skills: Skill[]): void {
  assert(isAbsolute(root) && isAbsolute(configDir), `placeBuild: root and configDir must be absolute, got ${root}, ${configDir}`);
  assert(existsSync(root), `placeBuild: no build root at ${root}`);
  const owned = ownedPaths(skills);
  const want = [...topLevel(owned)].sort().join(", ");
  const have = readdirSync(root).sort().join(", ");
  assert(want === have, `placeBuild: ${root} holds ${have} at its top level, not ownedPaths(skills)' ${want} (S1)`);

  // Read (and validate) the installed manifest first: a bad `owned` must fail before any removal.
  const previous: string[] = [];
  const file = readOwned(configDir);
  if ("owned" in file) previous.push(...file.owned);
  else assert(!existsSync(join(configDir, OPENCODE_MANIFEST)), `placeBuild: ${file.problem}`);

  // A path either list names is removed, so both lists are checked before the first removal.
  const paths = [...new Set([...previous, ...owned])];
  for (const rel of paths) assertContained(rel, configDir);
  for (const rel of paths) rmSync(join(configDir, rel), { recursive: true, force: true });
  for (const rel of owned) {
    const from = join(root, rel);
    assert(existsSync(from), `placeBuild: the build has no ${rel}`);
    const to = join(configDir, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
}

/** Whether every path ktx owns is in the config dir. */
function placedStep(configDir: string, owned: string[]): Step {
  const name = "placed";
  const missing = owned.filter((rel) => !existsSync(join(configDir, rel)));
  if (missing.length) {
    return { name, ok: false, detail: `${missing.map((rel) => join(configDir, rel)).join(", ")} missing — ${REMEDY}` };
  }
  return { name, ok: true, detail: `${owned.length} path(s) ktx owns under ${configDir}` };
}

/**
 * Hash just the paths ktx owns under `dir`, so OpenCode's own files beside them never
 * enter the comparison (D-W5-8). A path that is not there hashes as absent; `placed`
 * is the step that names it.
 */
function ownedTreeHash(dir: string, owned: string[], exclude: string[]): string {
  const scratch = mkdtempSync(join(tmpdir(), "ktx-opencode-owned-"));
  try {
    for (const rel of owned) {
      const from = join(dir, rel);
      if (!existsSync(from)) continue;
      const to = join(scratch, rel);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    return treeHash(scratch, exclude);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Content staleness: the installed owned tree against a fresh build, the manifest left
 * out of both sides (it carries the stamp). Every path either side lists is in the
 * comparison, so a file a previous build left behind differs too.
 */
function staleStep(configDir: string, owned: string[], fresh: string): Step {
  const name = "stale";
  const file = readOwned(configDir);
  if (!("owned" in file)) return { name, ok: false, detail: file.problem };
  const want = treeHash(fresh, [OPENCODE_MANIFEST]);
  const have = ownedTreeHash(configDir, [...new Set([...file.owned, ...owned])], [OPENCODE_MANIFEST]);
  if (have !== want) return { name, ok: false, detail: `stale — the installed files differ from a fresh build; ${REMEDY}` };
  return { name, ok: true, detail: `matches a fresh build (h${shortHash(want)})` };
}

/** The one file OpenCode loads as ktx's plugin: it must be byte-for-byte what a build writes. */
function pluginStep(configDir: string, fresh: string): Step {
  const name = "plugin";
  const installed = join(configDir, "plugins", "ktx.ts");
  const built = join(fresh, "plugins", "ktx.ts");
  if (!existsSync(built)) return { name, ok: false, detail: `the build has no plugins/ktx.ts — ktx's build is broken` };
  if (!existsSync(installed)) return { name, ok: false, detail: `${installed} not found — ${REMEDY}` };
  if (!readFileSync(installed).equals(readFileSync(built))) {
    return { name, ok: false, detail: `${installed} is not what a fresh build writes — ${REMEDY}` };
  }
  return { name, ok: true, detail: `${installed} matches the built plugin` };
}

/** A ktx name that another source defines too: the file (or set) that defines it, and its root when it has one. */
type Overlap = {
  id: string; // the ktx skill id or `ktx/<n>` command name that is also defined elsewhere
  kind: "skill" | "command";
  where: string; // the file that defines it, or OpenCode's own set
  note: string; // where that file came from, when its path does not already say
  root?: string; // the source root a listing can excuse; undefined: never expected
};

/** The realpath of an existing directory, or undefined for anything else (a missing dir, a file). */
function realDir(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Expand a leading `~` against the env's user home; every other spelling is used as written. */
function expandTilde(dir: string, home: string): string {
  if (dir === "~") return home;
  return dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
}

/**
 * What `opencode.expected-shadows` lists, as realpaths, plus the entries this report
 * cannot place (a relative one, or one naming no directory). Seam S5 producer: the
 * options registry only ever hands doctor a list of non-empty strings, so anything
 * else is a caller bug; a listing that cannot be resolved is reported by the step's
 * detail, never thrown over, and excuses nothing.
 */
function expectedShadowDirs(ctx: Ctx, home: string): { real: Set<string>; unresolved: string[] } {
  const listed = ctx.options[EXPECTED_SHADOWS_KEY];
  if (listed === undefined) return { real: new Set(), unresolved: [] };
  assert(
    Array.isArray(listed) && listed.every((e) => typeof e === "string" && e !== ""),
    `opencode doctor: ${EXPECTED_SHADOWS_KEY} must be a list of non-empty strings, got ${JSON.stringify(listed)}`,
  );
  const real = new Set<string>();
  const unresolved: string[] = [];
  for (const entry of new Set(listed.map((dir) => expandTilde(dir, home)))) {
    const resolved = isAbsolute(entry) ? realDir(entry) : undefined;
    if (resolved !== undefined) real.add(resolved); else unresolved.push(entry);
  }
  return { real, unresolved };
}

/** A config file's parsed document, or why this report could not read it. */
type ConfigDoc = { value: Record<string, unknown> } | { problem: string };

/** Read one config file: OpenCode parses both `opencode.json` and `opencode.jsonc` as JSONC (invariant 17). */
function readConfig(path: string): ConfigDoc | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value: unknown = Bun.JSONC.parse(readFileSync(path, "utf8"));
    if (!isRecord(value)) return { problem: `${path} is not a JSON object` };
    return { value };
  } catch (err) {
    return { problem: `${path} could not be read as JSONC: ${(err as Error).message}` };
  }
}

/**
 * A directory OpenCode reads ktx-named skills or commands from. `ownsBundles` marks the
 * one source ktx installs into, whose `<id>/SKILL.md` is ktx's own copy, not a shadow.
 */
type ShadowSource = { dir: string; note: string; ownsBundles?: boolean };

/**
 * The skill files one source defines, each with its id, as OpenCode scans it: every
 * top-level `*.md` plus every `SKILL.md` at any depth, links followed, dot entries
 * included (config/plugin/skill.ts:121). A top-level `<x>.md` is skill `x`; a SKILL.md
 * is named by its folder (skill-file.ts:40-43, W-R7).
 */
function skillFiles(dir: string): { id: string; file: string }[] {
  if (realDir(dir) === undefined) return [];
  // Two scans: Bun's glob matches nothing for the brace form OpenCode writes.
  const scan = (pattern: string) =>
    [...new Bun.Glob(pattern).scanSync({ cwd: dir, absolute: true, followSymlinks: true, dot: true, onlyFiles: true })];
  return [...new Set([...scan("*.md"), ...scan("**/SKILL.md")])]
    .sort()
    .map((file) => {
      const flat = dirname(file) === dir && basename(file) !== "SKILL.md";
      return { id: flat ? basename(file, ".md") : basename(dirname(file)), file };
    });
}

/** The ktx names one kind of directory source defines, each with the file that defines it (invariants 7, 11). */
function dirOverlaps(sources: ShadowSource[], ids: string[], kind: "skill" | "command"): Overlap[] {
  const overlaps: Overlap[] = [];
  for (const { dir, note, ownsBundles } of sources) {
    // A command is its name plus `.md`. The source root travels with each name, for the
    // expected-shadows check.
    const files = kind === "skill" ? skillFiles(dir) : undefined;
    for (const id of ids) {
      let where: string | undefined;
      if (files === undefined) {
        const command = join(dir, `${id}.md`);
        if (existsSync(command)) where = command;
      } else {
        where = files.find((f) => f.id === id && !(ownsBundles && f.file === join(dir, id, "SKILL.md")))?.file;
      }
      if (where) overlaps.push({ id, kind, where, note, root: dir });
    }
  }
  return overlaps;
}

/** What the config files hold: the skill dirs they name, and anything this report could not check. */
type ConfigScan = { dirs: ShadowSource[]; overlaps: Overlap[]; unchecked: string[] };

function scanConfigs(configDir: string, home: string, commandIds: string[]): ConfigScan {
  const dirs: ShadowSource[] = [];
  const overlaps: Overlap[] = [];
  const unchecked: string[] = [];
  for (const path of CONFIG_FILES.map((file) => join(configDir, file))) {
    const doc = readConfig(path);
    if (doc === undefined) continue;
    if ("problem" in doc) {
      unchecked.push(`${doc.problem}, so its skills and command keys were not checked`);
      continue;
    }
    const skills = doc.value.skills;
    for (const entry of Array.isArray(skills) ? stringList(skills) : isRecord(skills) ? stringList(skills.paths) : []) {
      const dir = expandTilde(entry, home);
      if (!isAbsolute(dir)) {
        unchecked.push(
          `${JSON.stringify(entry)} in ${path} is a relative skills entry, which OpenCode resolves against its own` +
            ` working directory, so this report cannot check it`,
        );
      } else if (realDir(dir) !== undefined) {
        dirs.push({ dir, note: ` (from skills in ${path})` });
      }
    }
    if (isRecord(skills)) {
      for (const url of stringList(skills.urls)) {
        unchecked.push(
          `${JSON.stringify(url)} in ${path} is a URL skills catalog OpenCode fetches itself,` +
            ` so this report cannot check it`,
        );
      }
    }
    overlaps.push(...configCommandOverlaps(doc.value, path, commandIds));
  }
  return { dirs, overlaps, unchecked };
}

/** The ktx command names one config file's `commands` and legacy `command` keys define (invariant 11). */
function configCommandOverlaps(doc: Record<string, unknown>, path: string, commandIds: string[]): Overlap[] {
  const overlaps: Overlap[] = [];
  // A config-file key names no directory, so it can never be an expected shadow (D-W5-9).
  for (const key of ["commands", "command"]) {
    const map = doc[key];
    if (!isRecord(map)) continue;
    for (const id of commandIds) {
      if (Object.keys(map).includes(id)) {
        overlaps.push({ id, kind: "command", where: path, note: ` (the \`${key}\` key)` });
      }
    }
  }
  return overlaps;
}

/** The step from what the scan found: the gaps, the expected shadows and everything left unchecked. */
function shadowReport(
  name: string,
  overlaps: Overlap[],
  unchecked: string[],
  listed: { real: Set<string>; unresolved: string[] },
  counts: { skills: number; commands: number; dirs: string[] },
): Step {
  // A shadow is expected only when its own SOURCE ROOT — the skills or command dir, not the
  // skill's folder — equals a listed entry once both sides are resolved.
  const isExpected = (overlap: Overlap): boolean => {
    const dir = overlap.root === undefined ? undefined : realDir(overlap.root);
    return dir !== undefined && listed.real.has(dir);
  };
  const named = (overlap: Overlap) => `${overlap.kind} ${overlap.id} from ${overlap.where}${overlap.note}`;
  const gaps = overlaps.filter((overlap) => !isExpected(overlap));
  const expected = overlaps.filter(isExpected);

  const found: string[] = [];
  if (gaps.length) {
    found.push(`${gaps.map(named).join(", ")} — OpenCode keeps one of the two silently, so remove or rename it`);
  }
  if (expected.length) {
    found.push(
      `expected (${EXPECTED_SHADOWS_KEY}): ${expected.map(named).join(", ")} — a folder listed there may hold its` +
        ` own copy of a ktx skill or command, and OpenCode keeps one of the two silently`,
    );
  }
  if (listed.unresolved.length) {
    const unr = listed.unresolved.map((entry) => JSON.stringify(entry)).join(", ");
    found.push(
      `${EXPECTED_SHADOWS_KEY} lists ${unr}, which name no directory this report can resolve,` +
        ` so nothing from there can be expected`,
    );
  }
  if (!found.length && !unchecked.length) {
    return {
      name,
      ok: true,
      detail: `no other source defines one of the ${counts.skills} ktx skills or ${counts.commands} ktx commands` +
        ` (checked ${counts.dirs.join(", ")})`,
    };
  }
  // An expected shadow and a listing that cannot be resolved are not gaps in the install;
  // a name the owner did not list, and anything this step could not check, are.
  return { name, ok: !gaps.length && !unchecked.length, detail: [...found, ...unchecked].join("; ") };
}

/**
 * The shadowed-skill step (S5 consumer, D-W5-9): every ktx skill id or ktx command name
 * another source defines, the source root it came from, and whether a listing excuses it.
 */
export function shadowStep(ctx: Ctx): Step {
  const configDir = configDirOf(ctx);
  const home = ctx.env.OPENCODE_TEST_HOME || userHome(ctx.env);
  const skillIds = ctx.skills.map((s) => s.name);
  const commandIds = ctx.skills.filter((s) => invokeTrigger(s)).map((s) => `ktx/${s.name}`);

  // The directory sources, low to high precedence (invariant 7). `<config-dir>/skills` is
  // where ktx installs its own `<id>/SKILL.md`; any other file there naming a ktx id —
  // a flat `<id>.md`, a nested bundle — still shadows it (W-A5).
  const skillSources: ShadowSource[] = [
    ...COMPAT_DIRS.map((compat) => ({ dir: join(home, compat, "skills"), note: "" })),
    { dir: join(configDir, "skill"), note: "" },
    { dir: join(configDir, "skills"), note: "", ownsBundles: true },
  ];
  const commandSources: ShadowSource[] = [{ dir: join(configDir, "command"), note: "" }];
  const configs = scanConfigs(configDir, home, commandIds);
  skillSources.push(...configs.dirs);

  const overlaps: Overlap[] = [
    // OpenCode's own ids are not a directory: nothing can be listed to excuse them.
    ...skillIds
      .filter((id) => BUILTIN_SKILLS.includes(id))
      .map((id): Overlap => ({ id, kind: "skill", where: "OpenCode's built-in skills", note: "" })),
    ...configs.overlaps,
    ...dirOverlaps(skillSources, skillIds, "skill"),
    ...dirOverlaps(commandSources, commandIds, "command"),
  ];
  const dirs = [...skillSources, ...commandSources].map((source) => source.dir);
  return shadowReport("shadowed-skill", overlaps, configs.unchecked, expectedShadowDirs(ctx, home), {
    skills: skillIds.length, commands: commandIds.length, dirs,
  });
}

/** Build, stamp and place the D-W5-2 layout into OpenCode's config dir. */
function install(ctx: Ctx, build: Build): Step[] {
  const home = configDirOf(ctx);
  const built = build(ctx.skills, join(dataDir(ctx.env), "opencode"));
  // buildOpencode stamps its own manifest; stamping again is idempotent (the hash leaves
  // the manifest out) and keeps the step's version honest for any injected build.
  const version = stampVersion(built, OPENCODE_MANIFEST);
  placeBuild(built, home, ctx.skills);
  const paths = ownedPaths(ctx.skills).length;
  return [
    { name: "placed", ok: true, detail: `${paths} path(s) from ${built} into ${home}` },
    { name: "stamp", ok: true, detail: `${join(home, OPENCODE_MANIFEST)} (${version})` },
  ];
}

/** Read-only doctor over the same layout: one fresh build serves the hash and the plugin comparison. */
function doctor(ctx: Ctx, build: Build): Step[] {
  const configDir = configDirOf(ctx);
  const owned = ownedPaths(ctx.skills);
  const steps = [placedStep(configDir, owned)];
  const scratch = mkdtempSync(join(tmpdir(), "ktx-opencode-doctor-"));
  try {
    const fresh = build(ctx.skills, scratch);
    steps.push(staleStep(configDir, owned, fresh), pluginStep(configDir, fresh));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  steps.push(shadowStep(ctx));
  return steps;
}

/** The build the installer runs; injected so install/doctor tests use fixture builds (re-verdict R-A6). */
export type Build = (skills: Skill[], outDir: string) => string;

/** An installer over `build`; ktx's own is makeOpencodeInstaller(buildOpencode). */
export function makeOpencodeInstaller(build: Build): Installer {
  return {
    install: (ctx) => install(ctx, build),
    doctor: (ctx) => doctor(ctx, build),
  };
}

export const opencodeInstaller: Installer = makeOpencodeInstaller(buildOpencode);
