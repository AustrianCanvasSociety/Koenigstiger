// The guard in front of `<harness> plugin marketplace remove ktx-local`.
//
// Removing a marketplace uninstalls every plugin installed from it (Claude Code
// documents this), so install only removes a `ktx-local` registration that is a ktx
// build: its directory is gone, or its marketplace manifest lists the `ktx` plugin
// and nothing else. Anything else is someone else's marketplace that happens to
// share the name, and install stops with a gap naming it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MARKETPLACE, PLUGIN_NAME } from "../translators/common";

/**
 * Why the `ktx-local` registered at `source` is not ktx's to remove, or undefined
 * when it is. `manifest` is the harness's marketplace manifest path inside a source.
 */
export function foreignMarketplace(source: string, manifest: string): string | undefined {
  // A source that no longer exists holds no plugins to lose: a moved or deleted ktx build.
  if (!existsSync(source)) return undefined;
  const path = join(source, manifest);
  if (!existsSync(path)) return `it holds no ${manifest}`;
  let plugins: unknown;
  try {
    plugins = (JSON.parse(readFileSync(path, "utf8")) as { plugins?: unknown })?.plugins;
  } catch (err) {
    return `its ${manifest} is unreadable (${(err as Error).message})`;
  }
  if (!Array.isArray(plugins) || !plugins.length) return `its ${manifest} lists no plugins`;
  const names = plugins.map((p) => (typeof p === "object" && p !== null ? String((p as { name?: unknown }).name) : String(p)));
  const others = names.filter((name) => name !== PLUGIN_NAME);
  return others.length ? `it lists ${others.join(", ")}` : undefined;
}

/** The gap install reports instead of removing a foreign `ktx-local`. */
export function foreignDetail(source: string, why: string, harness: string): string {
  return `${MARKETPLACE} is registered at ${source} and is not a ktx build (${why}) — removing it would uninstall its plugins; ` +
    `remove or rename that marketplace yourself, then run ktx install ${harness}`;
}
