// claude install adapter — W1 track claude. See plans/W1.md § 8.
//
// Claude Code loads a relative-path plugin in place from its marketplace directory
// (plans/W1-invariants.md invariant 1), so ktx builds into <data>/claude/ktx, registers
// <data>/claude as a directory marketplace and installs ktx@ktx-local from it. An update
// is a rebuild into that same directory; the owner then runs /reload-plugins (invariant 2).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildClaude, CLAUDE_DESCRIPTION } from "../translators/claude";
import { hasPromptTriggers, MARKETPLACE, PLUGIN_ID, PLUGIN_NAME, writeJson } from "../translators/common";
import { foreignDetail, foreignMarketplace } from "./marketplace-guard";
import { claudeManagedSettings, dataDir, harnessHome, sameDir } from "./paths";
import { freshBuildHash, shortHash, stampVersion, treeHash } from "./stamp";
import type { Ctx, Installer, Step } from "./types";

const MANIFEST = ".claude-plugin/plugin.json";
const MARKETPLACE_MANIFEST = ".claude-plugin/marketplace.json";

/** <data>/claude — the directory marketplace Claude loads the plugin in place from. */
const marketplaceDir = (ctx: Ctx) => join(dataDir(ctx.env), "claude");
/** <data>/claude/ktx — the plugin root the marketplace's "./ktx" source points at. */
const pluginRoot = (ctx: Ctx) => join(marketplaceDir(ctx), PLUGIN_NAME);
const knownMarketplacesPath = (ctx: Ctx) => join(harnessHome("claude", ctx.env), "plugins", "known_marketplaces.json");
const installedPluginsPath = (ctx: Ctx) => join(harnessHome("claude", ctx.env), "plugins", "installed_plugins.json");
const settingsPath = (ctx: Ctx) => join(harnessHome("claude", ctx.env), "settings.json");

type JsonFile = { value: unknown } | { error: string };

/** Read a JSON file; `error` tells a missing or unreadable file from a real value. */
function readJson(path: string): JsonFile {
  if (!existsSync(path)) return { error: "not found" };
  try {
    return { value: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { error: `unreadable (${(err as Error).message})` };
  }
}

const hasValue = (file: JsonFile) => !("error" in file);

/** One field of a JSON value, or undefined for anything that is not an object. */
function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
}

/** The path recorded inside a ktx-local marketplace entry, if any. */
function entryPath(entry: unknown): string | undefined {
  const path = field(field(entry, "source"), "path");
  return typeof path === "string" ? path : undefined;
}

/**
 * The gap for a `ktx-local` entry that is not a ktx build, or undefined when install
 * may remove it. An entry with no `source` at all is a broken record, not someone
 * else's marketplace; one whose source is not a directory can only be someone else's.
 */
function foreignEntry(entry: unknown, recorded: string | undefined): string | undefined {
  const source = field(entry, "source");
  if (source === undefined) return undefined;
  if (recorded === undefined) return foreignDetail(JSON.stringify(source), "its source is not a directory", "claude");
  const why = foreignMarketplace(recorded, MARKETPLACE_MANIFEST);
  return why === undefined ? undefined : foreignDetail(recorded, why, "claude");
}

/**
 * True when Claude's registry already holds ktx@ktx-local. Presence only: the recorded
 * version and installPath do not describe what runs (invariant 2), so they never gate anything.
 */
function pluginInstalled(ctx: Ctx): boolean {
  const file = readJson(installedPluginsPath(ctx));
  if (!hasValue(file)) return false;
  const entry = field(field(file.value, "plugins"), PLUGIN_ID);
  return Array.isArray(entry) ? entry.length > 0 : Boolean(entry && typeof entry === "object");
}

/** True when settings.json enables ktx@ktx-local; a record in installed_plugins.json alone does not. */
function pluginEnabled(ctx: Ctx): boolean {
  const file = readJson(settingsPath(ctx));
  return hasValue(file) && field(field(file.value, "enabledPlugins"), PLUGIN_ID) === true;
}

/** One harness CLI call through ctx.run (never Bun.spawn), reported as an install or doctor step. */
function runStep(ctx: Ctx, name: string, cmd: string[], detail: string): Step {
  const result = ctx.run(cmd, { env: ctx.env });
  if (result.code !== 0) {
    const out = (result.stderr || result.stdout).trim().split("\n").pop() ?? "";
    return { name, ok: false, detail: `${cmd.join(" ")} exited ${result.code}${out ? `: ${out}` : ""}` };
  }
  return { name, ok: true, detail };
}

/** Run one step into `steps`; returns whether it succeeded, so callers can stop on it. */
function push(ctx: Ctx, steps: Step[], name: string, cmd: string[], detail: string): boolean {
  const step = runStep(ctx, name, cmd, detail);
  steps.push(step);
  return step.ok;
}

/** Build, stamp and register the plugin, then install it if Claude does not know it yet (D-W1-2). */
function install(ctx: Ctx): Step[] {
  const dir = marketplaceDir(ctx);
  const root = pluginRoot(ctx);
  const steps: Step[] = [];

  // A rebuild replaces the tree in place, so a renamed or deleted file cannot survive an update.
  const version = stampVersion(buildClaude(ctx.skills, dir), MANIFEST);
  writeJson(join(dir, MARKETPLACE_MANIFEST), {
    name: MARKETPLACE,
    owner: { name: PLUGIN_NAME },
    plugins: [{ name: PLUGIN_NAME, source: `./${PLUGIN_NAME}`, description: CLAUDE_DESCRIPTION }],
  });
  steps.push({ name: "build", ok: true, detail: `built ${root} (${version})` });

  const known = readJson(knownMarketplacesPath(ctx));
  const entry = hasValue(known) ? field(known.value, MARKETPLACE) : undefined;
  const recorded = entryPath(entry);
  let registered = true;
  const foreign = foreignEntry(entry, recorded);
  if (sameDir(recorded, dir)) {
    steps.push({ name: "marketplace", ok: true, detail: `already registered at ${recorded}` });
  } else if (foreign) {
    steps.push({ name: "marketplace", ok: false, detail: foreign });
    registered = false;
  } else {
    // A registration at any other path would be found first and load the wrong copy, and
    // `marketplace add` refuses a name that is already taken, so clear it before re-adding.
    registered = entry === undefined ||
      push(ctx, steps, "marketplace-remove", ["claude", "plugin", "marketplace", "remove", MARKETPLACE],
        `removed the registration at ${recorded ?? "an unreadable path"}`);
    if (registered) {
      registered = push(ctx, steps, "marketplace", ["claude", "plugin", "marketplace", "add", dir], `registered ${dir}`);
    }
  }

  // `plugin install` and `plugin enable` resolve ktx@ktx-local through the marketplace, so a
  // registration that did not take would install the wrong copy (or none): stop and name the gap.
  if (!registered) {
    steps.push({ name: "install", ok: false, detail: "skipped — marketplace not registered" });
    return steps;
  }

  if (pluginInstalled(ctx)) {
    steps.push({ name: "install", ok: true, detail: `${PLUGIN_ID} is already in ${installedPluginsPath(ctx)}` });
    // A reinstall does not flip this: an installed-but-disabled plugin needs its own verb,
    // or the `enabled` gap doctor reports would never clear from `ktx install claude`.
    if (pluginEnabled(ctx)) {
      steps.push({ name: "enable", ok: true, detail: `${PLUGIN_ID} is enabled in ${settingsPath(ctx)}` });
    } else {
      steps.push(runStep(ctx, "enable", ["claude", "plugin", "enable", PLUGIN_ID], `enabled ${PLUGIN_ID}`));
    }
  } else {
    steps.push(runStep(ctx, "install", ["claude", "plugin", "install", PLUGIN_ID], `installed ${PLUGIN_ID}`));
  }
  return steps;
}

/** Read-only doctor: files only, no harness call, because the registry's version is not what runs. */
function doctor(ctx: Ctx): Step[] {
  const dir = marketplaceDir(ctx);
  const root = pluginRoot(ctx);
  return [marketplaceStep(ctx, dir), enabledStep(ctx), treeStep(root), hookStep(ctx, root), staleStep(ctx, root)];
}

function marketplaceStep(ctx: Ctx, dir: string): Step {
  const path = knownMarketplacesPath(ctx);
  const file = readJson(path);
  if (!hasValue(file)) return { name: "marketplace", ok: false, detail: `${path}: ${file.error} — run ktx install claude` };
  const recorded = entryPath(field(file.value, MARKETPLACE));
  if (!recorded) {
    return { name: "marketplace", ok: false, detail: `${MARKETPLACE} is not registered in ${path} — run ktx install claude` };
  }
  if (!sameDir(recorded, dir)) {
    return { name: "marketplace", ok: false, detail: `${MARKETPLACE} points at ${recorded}, not ${dir} — run ktx install claude` };
  }
  return { name: "marketplace", ok: true, detail: `${MARKETPLACE} registered at ${recorded}` };
}

function enabledStep(ctx: Ctx): Step {
  const path = settingsPath(ctx);
  const file = readJson(path);
  if (!hasValue(file)) return { name: "enabled", ok: false, detail: `${path}: ${file.error} — run ktx install claude` };
  if (!pluginEnabled(ctx)) {
    return { name: "enabled", ok: false, detail: `enabledPlugins["${PLUGIN_ID}"] is not true in ${path} — run ktx install claude` };
  }
  // A plugin set to false in managed settings is blocked at every scope, whatever settings.json says.
  if (field(field(managedSettings(ctx), "enabledPlugins"), PLUGIN_ID) === false) {
    return { name: "enabled", ok: false, detail: `managed settings block ${PLUGIN_ID}: enabledPlugins["${PLUGIN_ID}"] = false in ${claudeManagedSettings(ctx.env)}` };
  }
  return { name: "enabled", ok: true, detail: `enabledPlugins["${PLUGIN_ID}"] = true in ${path}` };
}

/** The managed settings file's value, or undefined when there is none to read. */
function managedSettings(ctx: Ctx): unknown {
  const file = readJson(claudeManagedSettings(ctx.env));
  return hasValue(file) ? file.value : undefined;
}

/**
 * The setting that keeps the plugin's hook from running although the plugin is
 * enabled, or undefined. `disableAllHooks` turns hooks off from any file;
 * `allowManagedHooksOnly` leaves only managed hooks and those of plugins the
 * managed settings force-enable. Project and local settings are one repository's
 * and are not read here.
 */
function hookSwitchedOff(ctx: Ctx): string | undefined {
  const managed = managedSettings(ctx);
  const user = readJson(settingsPath(ctx));
  if (hasValue(user) && field(user.value, "disableAllHooks") === true) return `disableAllHooks is true in ${settingsPath(ctx)}`;
  if (field(managed, "disableAllHooks") === true) return `disableAllHooks is true in ${claudeManagedSettings(ctx.env)}`;
  if (field(managed, "allowManagedHooksOnly") === true && field(field(managed, "enabledPlugins"), PLUGIN_ID) !== true) {
    return `allowManagedHooksOnly is true in ${claudeManagedSettings(ctx.env)}, which does not force-enable ${PLUGIN_ID}`;
  }
  return undefined;
}

function treeStep(root: string): Step {
  const path = join(root, MANIFEST);
  const file = readJson(path);
  if (!hasValue(file)) return { name: "plugin-tree", ok: false, detail: `${path}: ${file.error} — run ktx install claude` };
  const name = field(file.value, "name");
  if (name !== PLUGIN_NAME) {
    return { name: "plugin-tree", ok: false, detail: `${path} names ${JSON.stringify(name)}, not ${PLUGIN_NAME} — run ktx install claude` };
  }
  return { name: "plugin-tree", ok: true, detail: `${root} (${String(field(file.value, "version"))})` };
}

/** A trigger-less plugin ships no hook at all, so the hook is only a gap when a skill declares one. */
function hookStep(ctx: Ctx, root: string): Step {
  if (!hasPromptTriggers(ctx.skills)) {
    return { name: "hook", ok: true, detail: "no skill declares prompt triggers" };
  }
  const path = join(root, "hooks", "hooks.json");
  const file = readJson(path);
  if (!hasValue(file)) return { name: "hook", ok: false, detail: `${path}: ${file.error} — run ktx install claude` };
  const entries = field(field(file.value, "hooks"), "UserPromptSubmit");
  if (!Array.isArray(entries) || !entries.length) {
    return { name: "hook", ok: false, detail: `${path} has no UserPromptSubmit hook — run ktx install claude` };
  }
  const off = hookSwitchedOff(ctx);
  if (off) return { name: "hook", ok: false, detail: `the UserPromptSubmit hook will not run: ${off}` };
  return { name: "hook", ok: true, detail: `UserPromptSubmit runs ${entries.length} hook(s) from ${path}` };
}

/**
 * Staleness by content, never by the recorded version (invariant 2): hash the in-place tree
 * against a fresh build in a throwaway dir. The manifest is excluded — it carries the stamp.
 */
function staleStep(ctx: Ctx, root: string): Step {
  // The stamp leaves the manifest out of the hash, so stamping the fresh build here would be
  // work with no effect on the comparison.
  const want = freshBuildHash("ktx-doctor-claude-", (out) => buildClaude(ctx.skills, out), [MANIFEST]);
  const have = existsSync(root) ? treeHash(root, [MANIFEST]) : undefined;
  if (have === want) return { name: "stale", ok: true, detail: `installed tree matches a fresh build (h${shortHash(want)})` };
  return { name: "stale", ok: false, detail: "stale — run ktx install claude, then /reload-plugins" };
}

/** Install, update and diagnose the ktx plugin for Claude Code (D-W1-2, invariants 1–4). */
export const claudeInstaller: Installer = { install, doctor };
