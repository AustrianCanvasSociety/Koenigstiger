// Kimi install adapter. Kimi has no plugin CLI verb, and /plugins install copies
// the source into <KIMI_CODE_HOME>/plugins/managed/<id>/ and always runs that
// copy, so install builds the plugin under <KTX_DATA_HOME>/kimi and republishes
// the managed copy atomically, then upserts the ktx record in
// plugins/installed.json. The owner makes it live with /plugins reload or a new
// session; nothing here runs a harness binary.
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { assert } from "../assert";
import { hasPromptTriggers, PLUGIN_NAME } from "../translators/common";
import { buildKimi } from "../translators/kimi";
import { dataDir, harnessHome, sameDir, userHome } from "./paths";
import { freshBuildHash, shortHash, stampVersion, treeHash } from "./stamp";
import type { Ctx, Installer, Step } from "./types";

const MANIFEST = "kimi.plugin.json";
const HOOK_EVENT = "UserPromptSubmit";
/** The owner's list of dirs whose own copy of a ktx skill may shadow the plugin's (D-W4-12). */
const EXPECTED_SHADOWS_KEY = "kimi.expected-shadows";
/** The only fields Kimi's HookDefSchema accepts; anything else makes it drop the entry. */
const HOOK_FIELDS = ["event", "matcher", "command", "timeout"];

const installedFile = (home: string) => join(home, "plugins", "installed.json");
const managedDir = (home: string) => join(home, "plugins", "managed", PLUGIN_NAME);

type PluginRecord = Record<string, unknown>;
type Store = { data: Record<string, unknown>; records: unknown[] };

/** A record entry: Kimi only checks that `plugins` is an array, so anything can sit in it. */
function isRecord(value: unknown): value is PluginRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const isKtxRecord = (value: unknown): value is PluginRecord => isRecord(value) && value.id === PLUGIN_NAME;

/** Read plugins/installed.json; the same validation Kimi applies (it only checks `plugins`). */
function readStore(path: string): Store {
  if (!existsSync(path)) return { data: { version: 1, plugins: [] }, records: [] };
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`);
  }
  if (!isRecord(data) || !Array.isArray(data.plugins)) {
    throw new Error(`${path}: installed.json is not a valid InstalledFile object`);
  }
  return { data, records: data.plugins };
}

/**
 * Put the refreshed ktx record in the first ktx slot (appending it when there is
 * none) and drop any further ktx records, leaving every other entry — including
 * non-object ones — in place, plus every field and an existing top-level
 * `version` (a new file gets version 1, the shape Kimi's own writeInstalled emits).
 */
function writeStore(path: string, store: Store, record: PluginRecord): void {
  const plugins: unknown[] = [];
  let placed = false;
  for (const entry of store.records) {
    if (isKtxRecord(entry)) {
      if (placed) continue;
      plugins.push(record);
      placed = true;
    } else {
      plugins.push(entry);
    }
  }
  if (!placed) plugins.push(record);

  const data: Record<string, unknown> = { ...store.data, plugins };
  if (data.version === undefined) data.version = 1;
  mkdirSync(dirname(path), { recursive: true });
  // JSON.stringify re-serialises numbers (1.0 → 1, large ints lose precision). Kimi's own
  // persist does the same, so entries ktx does not own keep their values, not their bytes.
  writeFileSync(`${path}.tmp`, JSON.stringify(data, null, 2));
  renameSync(`${path}.tmp`, path);
}

/**
 * Replace the managed copy atomically, as Kimi's copyPluginToManagedRoot does:
 * copy the build into a sibling staging dir, rename the old copy aside, rename
 * the staging dir in. Returns the aside dir for the caller to delete (undefined
 * when there was no old copy), and restores the old copy if a rename fails.
 */
function publishCopy(built: string, managed: string): string | undefined {
  mkdirSync(dirname(managed), { recursive: true });
  const staging = mkdtempSync(join(dirname(managed), `${PLUGIN_NAME}-`));
  const previous = `${staging}-previous`;
  let movedOld = false;
  let published = false;
  try {
    cpSync(built, staging, { recursive: true });
    try {
      renameSync(managed, previous);
      movedOld = true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    renameSync(staging, managed);
    published = true;
  } catch (err) {
    rmSync(published ? managed : staging, { recursive: true, force: true });
    if (movedOld) renameSync(previous, managed);
    throw err;
  }
  return movedOld ? previous : undefined;
}

/** Why Kimi's HookDefSchema would drop this hook entry, or undefined when it survives. */
function hookProblem(e: unknown): string | undefined {
  if (!isRecord(e)) return "not an object";
  const extra = Object.keys(e).filter((k) => !HOOK_FIELDS.includes(k));
  if (extra.length) return `unknown field(s) ${extra.join(", ")}`;
  if (typeof e.command !== "string" || !e.command) return "command must be a non-empty string";
  if (e.matcher !== undefined && typeof e.matcher !== "string") return "matcher must be a string";
  if (e.timeout !== undefined && (!Number.isInteger(e.timeout) || (e.timeout as number) < 1 || (e.timeout as number) > 600)) {
    return "timeout must be an integer between 1 and 600";
  }
  return undefined;
}

function recordStep(path: string, managed: string): Step {
  const name = "record";
  if (!existsSync(path)) return { name, ok: false, detail: "not installed — run ktx install kimi" };
  let record: PluginRecord | undefined;
  try {
    record = readStore(path).records.find(isKtxRecord);
  } catch (err) {
    return { name, ok: false, detail: (err as Error).message };
  }
  if (!record) return { name, ok: false, detail: `no ${PLUGIN_NAME} record in ${path} — run ktx install kimi` };
  if (record.enabled !== true) return { name, ok: false, detail: `disabled in ${path} — enable it in /plugins` };
  const root = typeof record.root === "string" ? record.root : "";
  if (!sameDir(root, managed)) {
    return { name, ok: false, detail: `root ${root || "(missing)"} is not the managed copy ${managed} — run ktx install kimi` };
  }
  return { name, ok: true, detail: `enabled in ${path} (root ${root})` };
}

function manifestStep(managed: string): { step: Step; manifest?: Record<string, unknown> } {
  const name = "manifest";
  const path = join(managed, MANIFEST);
  if (!existsSync(path)) return { step: { name, ok: false, detail: `${path} not found — run ktx install kimi` } };
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { step: { name, ok: false, detail: `${path} does not parse: ${(err as Error).message}` } };
  }
  if (!isRecord(manifest)) return { step: { name, ok: false, detail: `${path} is not a JSON object` } };
  if (manifest.name !== PLUGIN_NAME) {
    const detail = `${path} names the plugin ${JSON.stringify(manifest.name)}, not ${PLUGIN_NAME}`;
    return { step: { name, ok: false, detail }, manifest };
  }
  return { step: { name, ok: true, detail: `${path} (version ${String(manifest.version ?? "(none)")})` }, manifest };
}

// Kimi turns a malformed hook entry into a warn diagnostic and keeps the plugin
// `ok`, so doctor must read the entry itself, not the plugin's state.
function hookStep(manifest: Record<string, unknown> | undefined, ctx: Ctx): Step {
  const name = "hook";
  if (!hasPromptTriggers(ctx.skills)) {
    return { name, ok: true, detail: "no skill declares prompt triggers, so the plugin ships no hook" };
  }
  if (!manifest) return { name, ok: false, detail: `${MANIFEST} is unreadable, so the ${HOOK_EVENT} hook cannot be checked` };
  const hooks = manifest.hooks;
  if (!Array.isArray(hooks)) {
    return { name, ok: false, detail: `"hooks" in ${MANIFEST} is not an array — Kimi loads the plugin without the ktx hook` };
  }
  const entries = hooks.filter((h) => (h as PluginRecord | null)?.event === HOOK_EVENT);
  if (!entries.length) {
    return { name, ok: false, detail: `no ${HOOK_EVENT} hook in ${MANIFEST} — Kimi loads the plugin without the ktx hook` };
  }
  const survivors = entries.filter((h) => hookProblem(h) === undefined);
  if (!survivors.length) {
    return { name, ok: false, detail: `every ${HOOK_EVENT} hook would be dropped by Kimi: ${hookProblem(entries[0])}` };
  }
  return { name, ok: true, detail: `${HOOK_EVENT} → ${String((survivors[0] as PluginRecord).command)}` };
}

// A plugin rewrite is only picked up by re-running install, so the hash of the
// managed copy (manifest excluded: Kimi treats its version as display metadata)
// is the only signal that what runs differs from what ktx would build now.
function contentStep(managed: string, ctx: Ctx): Step {
  const name = "stale";
  if (!existsSync(managed)) return { name, ok: false, detail: `no managed copy at ${managed} — run ktx install kimi` };
  const fresh = freshBuildHash("ktx-kimi-build-", (out) => buildKimi(ctx.skills, out), [MANIFEST]);
  const installed = treeHash(managed, [MANIFEST]);
  if (installed !== fresh) {
    return { name, ok: false, detail: `stale — the managed copy differs from a fresh build; run ktx install kimi, then /plugins reload` };
  }
  return { name, ok: true, detail: `matches a fresh build (h${shortHash(installed)})` };
}

/** Whether `path` is a directory that can be listed; a config entry may name anything at all. */
function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Expand a leading `~` against the env's user home; every other spelling is used as written. */
function expandTilde(dir: string, home: string): string {
  if (dir === "~") return home;
  return dir.startsWith("~/") ? join(home, dir.slice(2)) : dir;
}

/**
 * The dirs the owner's Kimi also scans, from `<home>/config.toml`'s `extra_skill_dirs`
 * (W3 D-W3-11). A missing file, a missing key or a non-list value adds none; an
 * unparsable file adds none either and returns why, so doctor can report it rather
 * than throw. Entries that are not non-empty strings are ignored, and each `~` is
 * expanded against the env's user home. An entry that is still not absolute after that
 * is returned in `relative` and never scanned: Kimi's own base for it is not recorded,
 * and resolving it here would attribute the dir to doctor's cwd instead.
 */
function configSkillDirs(path: string, home: string): { dirs: string[]; relative: string[]; problem?: string } {
  if (!existsSync(path)) return { dirs: [], relative: [] };
  let data: unknown;
  try {
    data = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { dirs: [], relative: [], problem: `${path} could not be read as TOML: ${(err as Error).message}` };
  }
  const list = isRecord(data) ? data.extra_skill_dirs : undefined;
  if (!Array.isArray(list)) return { dirs: [], relative: [] };
  const entries = list.filter((e): e is string => typeof e === "string" && e !== "");
  const expanded = entries.map((e) => expandTilde(e, home));
  return {
    dirs: expanded.filter((dir) => isAbsolute(dir)),
    relative: entries.filter((_, i) => !isAbsolute(expanded[i])),
  };
}

/** One dir to scan: `note` names where it came from when that is not Kimi's own skills dirs. */
type ShadowSource = { dir: string; note: string };

/** One skill file that wins over the plugin's same-named skill: where it sits, and where it came from. */
type Shadow = { file: string; note: string };

/** The realpath of an existing directory, or undefined for anything else (a missing dir, a file). */
function realDir(path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value !== "";

/**
 * What `kimi.expected-shadows` lists, as realpaths, plus the entries this report cannot
 * place: one that is still relative after `~` expansion (resolving it would attribute it
 * to doctor's cwd, as with a relative extra_skill_dirs entry) or that names no directory.
 * Seam S6 producer: the options registry only ever hands doctor a list of non-empty
 * strings, so anything else is a caller bug; a listing that cannot be resolved is reported
 * by the step's detail, never thrown over, and excuses nothing.
 */
function expectedShadowDirs(ctx: Ctx): { real: Set<string>; unresolved: string[] } {
  const listed = ctx.options[EXPECTED_SHADOWS_KEY];
  if (listed === undefined) return { real: new Set(), unresolved: [] };
  assert(
    Array.isArray(listed) && listed.every(isNonEmptyString),
    `kimi doctor: ${EXPECTED_SHADOWS_KEY} must be a list of non-empty strings, got ${JSON.stringify(listed)}`,
  );
  const real = new Set<string>();
  const unresolved: string[] = [];
  for (const entry of new Set(listed.map((dir) => expandTilde(dir, userHome(ctx.env))))) {
    const resolved = isAbsolute(entry) ? realDir(entry) : undefined;
    if (resolved !== undefined) real.add(resolved); else unresolved.push(entry);
  }
  return { real, unresolved };
}

/**
 * The skill files under `sources` that win over the plugin's same-named skill, in scan
 * order: a flat `<name>.md`, or a bundle's `<name>/SKILL.md` — both matched
 * case-insensitively, because the filesystems Kimi scans are (invariant 30). A source dir
 * that cannot be listed holds none, since an extra_skill_dirs entry may name anything, so
 * only a caller bug throws: a relative source dir, or (as no input can make this loop do)
 * a file that is not the source dir's own flat file or a bundle directly below it.
 */
export function findShadows(sources: ShadowSource[], skills: Ctx["skills"]): Shadow[] {
  for (const { dir } of sources) {
    assert(isAbsolute(dir), `kimi doctor: a shadow source dir must be absolute, got ${dir}`);
  }
  const shadows: Shadow[] = [];
  for (const { dir, note } of sources) {
    if (!isDir(dir)) continue;
    // `resolve` only normalises (a trailing slash, `.`), so it equals the spelling
    // `join` gives below without following a symlinked dir out from under the caller.
    const base = resolve(dir);
    // Postcondition, checked as each file is built: a shadow is the flat file itself or a
    // bundle's SKILL.md, so its directory is `base` or the bundle one level below it.
    const record = (file: string): void => {
      const at = dirname(file);
      assert(
        at === base || dirname(at) === base,
        `kimi doctor: ${file} is not in or one bundle level below its source dir ${dir}`,
      );
      shadows.push({ file, note });
    };
    const entries = new Map(readdirSync(dir).map((e) => [e.toLowerCase(), e]));
    for (const skill of skills) {
      const key = skill.name.toLowerCase();
      const bundle = entries.get(key);
      if (bundle && existsSync(join(dir, bundle, "SKILL.md"))) record(join(dir, bundle, "SKILL.md"));
      const flat = entries.get(`${key}.md`);
      if (flat) record(join(dir, flat));
    }
  }
  return shadows;
}

// Kimi scans user skills from $KIMI_CODE_HOME/skills, ~/.agents/skills and every dir
// in $KIMI_CODE_HOME/config.toml's extra_skill_dirs (W3 invariant 30); a directory
// bundle or a flat <name>.md there wins over the plugin's same-named skill, so the
// plugin's copy would silently never load. When the config cannot be read, or holds an
// entry whose base is unknown, the step fails like the adapter's other steps do for a
// file they cannot read: it did not finish the check, so it must not report ok.
// A shadow the owner listed in `kimi.expected-shadows` is expected instead of a gap
// (D-W4-12): the fleet's own commands dir is canonical, so its copy winning is by
// design. Only a file directly in a listed dir counts, and both sides are compared by
// realpath, so a symlinked spelling of the same dir still matches; a listing that names
// no directory excuses nothing and is named in the detail.
function shadowStep(ctx: Ctx, home: string): Step {
  const name = "shadowed-skill";
  // Every path the detail prints is built from `home` and promised as absolute; a
  // relative one would resolve against doctor's cwd, which is a caller bug.
  assert(isAbsolute(home), `kimi doctor: the harness home must be absolute, got ${home}`);
  const config = join(home, "config.toml");
  const { dirs: extra, relative, problem } = configSkillDirs(config, userHome(ctx.env));
  // What the step could not check. A config.toml the owner's Kimi reads and this step
  // cannot (K2), or a relative entry it never scans (K3), means ok would claim more
  // than the step knows; the dirs it can read are still scanned and reported.
  const unchecked: string[] = [];
  if (problem) unchecked.push(`${problem}, so its extra_skill_dirs was not checked`);
  if (relative.length) {
    unchecked.push(
      `a relative extra_skill_dirs entry cannot be checked: ${relative.map((e) => JSON.stringify(e)).join(", ")} in ${config}` +
        ` — Kimi resolves a relative entry against its own working directory, which this report cannot know`,
    );
  }
  const sources: ShadowSource[] = [
    { dir: join(home, "skills"), note: "" },
    { dir: join(userHome(ctx.env), ".agents", "skills"), note: "" },
    // A dir listed twice (or also one of Kimi's own) is scanned once: a shadow is named once.
    ...[...new Set(extra)].map((dir) => ({ dir, note: ` (from extra_skill_dirs in ${config})` })),
  ].filter((source, i, all) => all.findIndex((other) => other.dir === source.dir) === i);
  const listed = expectedShadowDirs(ctx);
  const shadows = findShadows(sources, ctx.skills);
  const dirs = sources.map((s) => s.dir);
  // A shadow is expected only when the file itself lies directly in a listed dir: a
  // bundle's SKILL.md sits one level below, and is still a gap.
  const isExpected = (shadow: Shadow): boolean => {
    const dir = realDir(dirname(shadow.file));
    return dir !== undefined && listed.real.has(dir);
  };
  const named = (shadow: Shadow) => `${shadow.file}${shadow.note}`;
  const gaps = shadows.filter((shadow) => !isExpected(shadow));
  const expected = shadows.filter(isExpected);

  const found: string[] = [];
  if (gaps.length) {
    found.push(`shadows the plugin's skill: ${gaps.map(named).join(", ")} — a user skill wins over the plugin copy, so remove or rename it`);
  }
  if (expected.length) {
    found.push(
      `expected (${EXPECTED_SHADOWS_KEY}): ${expected.map(named).join(", ")} — a folder listed there may hold its own` +
        ` copy of a ktx skill, and its copy wins over the plugin's`,
    );
  }
  if (listed.unresolved.length) {
    const unr = listed.unresolved.map((entry) => JSON.stringify(entry)).join(", ");
    found.push(`${EXPECTED_SHADOWS_KEY} lists ${unr}, which name no directory this report can resolve, so no shadow there can be expected`);
  }
  if (!found.length && !unchecked.length) {
    return {
      name,
      ok: true,
      detail: `no ktx skill of the ${ctx.skills.length} is shadowed under ${dirs.join(" or ")}`,
    };
  }
  // An expected shadow and a stale listing are not gaps in the install; a shadow the
  // owner did not list, and anything this step could not check, are.
  return { name, ok: !gaps.length && !unchecked.length, detail: [...found, ...unchecked].join("; ") };
}

/** Build, republish the managed copy and upsert the installed.json record. */
export const kimiInstaller: Installer = {
  install(ctx: Ctx): Step[] {
    const home = harnessHome("kimi", ctx.env);
    const managed = managedDir(home);
    const installed = installedFile(home);
    // Read (and validate) the record first: a bad installed.json must fail before anything is replaced.
    const store = readStore(installed);
    const existing = store.records.find(isKtxRecord);

    // The build dir is ktx-owned and stable, so the record's originalSource names a
    // directory that still exists after the install (buildKimi replaces it in place).
    const built = buildKimi(ctx.skills, join(dataDir(ctx.env), "kimi"));
    const version = stampVersion(built, MANIFEST);
    const previous = publishCopy(built, managed);
    if (previous) rmSync(previous, { recursive: true, force: true });

    const now = new Date().toISOString();
    writeStore(installed, store, {
      ...existing,
      id: PLUGIN_NAME,
      root: realpathSync(managed),
      source: "local-path",
      enabled: true,
      installedAt: typeof existing?.installedAt === "string" ? existing.installedAt : now,
      updatedAt: now,
      originalSource: built,
    });
    return [
      { name: "managed-copy", ok: true, detail: `${managed} (${version})` },
      { name: "record", ok: true, detail: `${PLUGIN_NAME} enabled in ${installed} — the owner must run /plugins reload` },
    ];
  },

  doctor(ctx: Ctx): Step[] {
    const home = harnessHome("kimi", ctx.env);
    const managed = managedDir(home);
    const { step, manifest } = manifestStep(managed);
    return [
      recordStep(installedFile(home), managed),
      step,
      hookStep(manifest, ctx),
      contentStep(managed, ctx),
      shadowStep(ctx, home),
    ];
  },
};
