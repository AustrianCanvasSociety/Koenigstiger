// Codex install adapter (W1 track codex; decisions D-W1-3 and D-W1-7).
//
// Codex runs the *installed copy* under <CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>,
// so an update is a rebuild plus `codex plugin add`, and staleness is that copy's
// tree hash against a fresh build — the recorded version alone does not show an
// edited copy (invariant 5, lead-live L6).
import {
  existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { buildCodex } from "../translators/codex";
import { MARKETPLACE, PLUGIN_ID, PLUGIN_NAME } from "../translators/common";
import { HOOK_STATE_KEY, hookHash, hookStateFromConfig, trustConfigEdit } from "./codex-trust";
import { foreignDetail, foreignMarketplace } from "./marketplace-guard";
import { dataDir, harnessHome, sameDir } from "./paths";
import { freshBuildHash, stampVersion, treeHash } from "./stamp";
import type { Ctx, Installer, Step } from "./types";
import type { RunResult } from "./run";

export const CODEX_PLUGIN_ID = PLUGIN_ID;
const MANIFEST = ".codex-plugin/plugin.json";
const HOOKS = "hooks/hooks.json";
/** Where buildCodex writes the marketplace, inside its output root. */
const MARKETPLACE_MANIFEST = ".agents/plugins/marketplace.json";
const TRUST_REMEDY =
  "approve the ktx hook in Codex's /hooks, or `ktx config set codex.trust-hook on` and re-run `ktx install codex`";
const TRUST_REFUSED = "config.toml has a shape ktx will not edit — approve the hook in Codex's /hooks";

export const codexInstaller: Installer = {
  install(ctx: Ctx): Step[] {
    const home = harnessHome("codex", ctx.env);
    const config = join(home, "config.toml");
    const out = join(dataDir(ctx.env), "codex");
    const root = buildCodex(ctx.skills, out);
    const version = stampVersion(root, MANIFEST);
    // codex refuses to run at all when CODEX_HOME does not exist, so create it before the first call.
    mkdirSync(home, { recursive: true });
    const steps: Step[] = [{ name: "build", ok: true, detail: `${root} (version ${version})` }];

    const marketplace = registerMarketplace(ctx, config, out);
    steps.push(marketplace);

    // `plugin add` resolves the id through the configured marketplace, so a registration
    // that did not take would install the wrong (or no) copy: skip it and report the gap.
    const added = marketplace.ok ? ctx.run(["codex", "plugin", "add", CODEX_PLUGIN_ID], { env: ctx.env }) : undefined;
    steps.push(
      added
        ? {
            name: "plugin",
            ok: added.code === 0,
            detail: added.code === 0 ? `${CODEX_PLUGIN_ID} ${version} added` : `plugin add failed: ${failure(added)}`,
          }
        : { name: "plugin", ok: false, detail: "skipped — marketplace not registered" },
    );

    steps.push(writeTrust(ctx, root, config, added?.code === 0));
    return steps;
  },

  doctor(ctx: Ctx): Step[] {
    const home = harnessHome("codex", ctx.env);
    const config = join(home, "config.toml");
    const list = ctx.run(["codex", "plugin", "list", "--json"], { env: ctx.env });
    const listed = list.code === 0 ? pluginList(list.stdout) : undefined;
    const entry = listed?.find(isKtxPlugin);

    const steps: Step[] = [listStep(list, listed, entry)];
    const version = typeof entry?.version === "string" ? entry.version : undefined;
    const base = join(home, "plugins", "cache", MARKETPLACE, PLUGIN_NAME);
    const cache = cacheStep(base, subdirs(base), version);
    steps.push(cache.step);
    steps.push(staleStep(ctx, cache.path));
    steps.push(trustStep(cache.path, config));
    return steps;
  },
};

/** Register <out> as the ktx-local marketplace, replacing a registration that points elsewhere. */
function registerMarketplace(ctx: Ctx, config: string, out: string): Step {
  const name = "marketplace";
  const registered = marketplaceSource(configText(config));
  if (sameDir(registered, out)) return { name, ok: true, detail: `already registered in ${config}` };
  if (registered !== undefined) {
    const why = foreignMarketplace(registered, MARKETPLACE_MANIFEST);
    if (why !== undefined) return { name, ok: false, detail: foreignDetail(registered, why, "codex") };
    // A stale registration (moved data dir, another checkout) keeps resolving ktx@ktx-local
    // to the old source, so it has to go before the new one is added.
    const removed = ctx.run(["codex", "plugin", "marketplace", "remove", MARKETPLACE], { env: ctx.env });
    if (removed.code !== 0) return { name, ok: false, detail: `marketplace remove failed: ${failure(removed)}` };
  }
  const added = ctx.run(["codex", "plugin", "marketplace", "add", out], { env: ctx.env });
  return {
    name,
    ok: added.code === 0,
    detail: added.code === 0 ? `added ${out} to ${config}` : `marketplace add failed: ${failure(added)}`,
  };
}

function configText(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The `[marketplaces.ktx-local]` source recorded in config.toml, if any. */
function marketplaceSource(text: string): string | undefined {
  if (!text.trim()) return undefined;
  try {
    const parsed = Bun.TOML.parse(text) as { marketplaces?: Record<string, { source?: unknown }> };
    const source = parsed.marketplaces?.[MARKETPLACE]?.source;
    return typeof source === "string" ? source : undefined;
  } catch {
    return undefined; // Codex would reject it too; re-registering is the safe move
  }
}

function listStep(list: RunResult, listed: PluginEntry[] | undefined, entry: PluginEntry | undefined): Step {
  if (list.code !== 0) return { name: "plugin", ok: false, detail: `codex plugin list failed: ${failure(list)}` };
  if (!listed) return { name: "plugin", ok: false, detail: "codex plugin list --json did not return JSON" };
  if (!entry) return { name: "plugin", ok: false, detail: `${CODEX_PLUGIN_ID} is not installed — run ktx install codex` };
  const state = `${entry.installed ? "installed" : "not installed"}, ${entry.enabled ? "enabled" : "disabled"}`;
  return {
    name: "plugin",
    ok: entry.installed === true && entry.enabled === true,
    detail: `${CODEX_PLUGIN_ID} ${state} (version ${entry.version ?? "unknown"})`,
  };
}

type PluginEntry = { pluginId?: string; name?: string; marketplaceName?: string; version?: unknown; installed?: boolean; enabled?: boolean };

/** D-W1-3: exactly one copy under plugins/cache/<marketplace>/<plugin>/, named by the installed version. */
function cacheStep(base: string, dirs: string[], version: string | undefined): { path?: string; step: Step } {
  const name = "cache";
  if (!version) return { step: { name, ok: false, detail: `codex plugin list reports no installed version — run ktx install codex` } };
  if (dirs.length !== 1) {
    return {
      step: {
        name,
        ok: false,
        detail: `${dirs.length} cache dirs under ${base}: ${dirs.join(", ") || "(none)"} — exactly one is needed; run ktx install codex`,
      },
    };
  }
  if (dirs[0] !== version) {
    return { step: { name, ok: false, detail: `cache dir ${dirs[0]} does not match the installed version ${version} — run ktx install codex` } };
  }
  const path = join(base, dirs[0]!);
  return { path, step: { name, ok: true, detail: `${path} (version ${version})` } };
}

function staleStep(ctx: Ctx, cacheDir: string | undefined): Step {
  const name = "stale";
  if (!cacheDir) return { name, ok: false, detail: "stale — no installed copy to compare; run ktx install codex" };
  const installed = treeHash(cacheDir, [MANIFEST]);
  const fresh = freshBuildHash("ktx-doctor-codex-", (out) => buildCodex(ctx.skills, out), [MANIFEST]);
  if (installed === fresh) return { name, ok: true, detail: "matches a fresh build" };
  return { name, ok: false, detail: "stale — the installed copy differs from a fresh build; run ktx install codex" };
}

/** Trust is read from the *installed* copy's hook definition: that is the definition Codex discovers. */
function trustStep(cacheDir: string | undefined, config: string): Step {
  const name = "hook-trusted";
  if (!cacheDir) return { name, ok: false, detail: `untrusted — no installed copy to read; ${TRUST_REMEDY}` };
  const hooks = join(cacheDir, HOOKS);
  if (!existsSync(hooks)) return { name, ok: true, detail: "no prompt hook declared" };
  const hash = hookHash(readHooks(hooks));
  if (!hash) return { name, ok: false, detail: `hooks/hooks.json declares no usable command hook — run ktx install codex` };

  const state = hookStateFromConfig(configText(config));
  if (state?.enabled === false) return { name, ok: false, detail: `disabled — ${TRUST_REMEDY}` };
  if (!state?.trustedHash) return { name, ok: false, detail: `untrusted — ${TRUST_REMEDY}` };
  if (state.trustedHash !== hash) return { name, ok: false, detail: `modified — ${TRUST_REMEDY}` };
  return { name, ok: true, detail: `trusted (${hash})` };
}

/** D-W1-7: only `codex.trust-hook` on writes trust; off leaves the owner to approve once in /hooks. */
function writeTrust(ctx: Ctx, root: string, config: string, pluginInstalled: boolean): Step {
  const name = "hook-trusted";
  if (!pluginInstalled) return { name, ok: false, detail: "skipped — plugin not installed" };
  const hash = hookHash(readHooks(join(root, HOOKS)));
  if (!hash) return { name, ok: true, detail: "no prompt hook declared" };
  if (ctx.options["codex.trust-hook"] !== true) {
    return { name, ok: true, detail: `trust not written (codex.trust-hook off) — ${TRUST_REMEDY}` };
  }
  const next = trustConfigEdit(configText(config), hash);
  if (next === undefined) return { name, ok: false, detail: TRUST_REFUSED };
  try {
    mkdirSync(dirname(config), { recursive: true });
    writeConfigAtomically(config, next);
  } catch (err) {
    return { name, ok: false, detail: `cannot write ${config}: ${(err as Error).message}` };
  }
  return { name, ok: true, detail: `${HOOK_STATE_KEY} trusted_hash written to ${config}` };
}

/**
 * Write a file atomically: a temp file beside it with the same mode, then rename.
 * A symlinked path is resolved first — renaming onto the link path would replace
 * the link itself with a regular file.
 */
function writeConfigAtomically(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o644;
  const nonce = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const temp = join(dirname(target), `.${basename(target)}.ktx-${nonce}.tmp`);
  try {
    writeFileSync(temp, text, { mode });
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}

/** The plugin's parsed hooks/hooks.json, or undefined when it is missing or malformed. */
function readHooks(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function subdirs(base: string): string[] {
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .filter((name) => statSync(join(base, name)).isDirectory())
    .sort();
}

/** `codex plugin list --json` is `{installed: [...], available: [...]}`; undefined when it is not JSON. */
function pluginList(stdout: string): PluginEntry[] | undefined {
  try {
    const parsed = JSON.parse(stdout) as { installed?: PluginEntry[] };
    return Array.isArray(parsed.installed) ? parsed.installed : [];
  } catch {
    return undefined;
  }
}

function isKtxPlugin(plugin: PluginEntry): boolean {
  return plugin.pluginId === CODEX_PLUGIN_ID || (plugin.name === PLUGIN_NAME && plugin.marketplaceName === MARKETPLACE);
}

function failure(res: RunResult): string {
  return res.stderr.trim() || res.stdout.trim() || `exit code ${res.code}`;
}
