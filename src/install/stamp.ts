// Content-hash version stamp: a build's version changes exactly when its content does.
// The hash leaves out the manifest that carries the stamp (a tree that hashes its own
// stamp never converges) and file modes other than the exec bit (umask varies by machine).
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

export const BASE_VERSION = "0.1.0";
const HASH_CHARS = 12;

/** sha256 over the tree at root: sorted relative paths, each with its exec bit and bytes. */
export function treeHash(root: string, exclude: string[] = []): string {
  const skip = new Set(exclude.map((p) => p.split("/").join(sep)));
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (skip.has(relative(root, path))) continue;
      if (lstatSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(root);

  const hash = createHash("sha256");
  for (const rel of files.map((f) => relative(root, f).split(sep).join("/")).sort()) {
    const path = join(root, rel);
    const st = lstatSync(path);
    const body = st.isSymbolicLink() ? Buffer.from(`symlink:${readlinkSync(path)}`) : readFileSync(path);
    hash.update(`${rel}\0${st.mode & 0o111 ? 1 : 0}\0${body.length}\0`);
    hash.update(body);
  }
  return hash.digest("hex");
}

/**
 * Tree hash of a fresh build in a throwaway temp dir (named `<prefix>…`, removed afterwards).
 * `build` writes into the dir it is given and returns the root to hash.
 */
export function freshBuildHash(prefix: string, build: (outDir: string) => string, exclude: string[]): string {
  const scratch = mkdtempSync(join(tmpdir(), prefix));
  try {
    return treeHash(build(scratch), exclude);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The short form of a tree hash used in versions and messages. */
export function shortHash(hash: string): string {
  return hash.slice(0, HASH_CHARS);
}

/** Rewrite the JSON manifest's version to BASE_VERSION+h<hash>; returns the new version. */
export function stampVersion(root: string, manifestRel: string): string {
  const version = `${BASE_VERSION}+h${shortHash(treeHash(root, [manifestRel]))}`;
  const path = join(root, manifestRel);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${path}: a plugin manifest must be a JSON object`);
  }
  manifest.version = version;
  writeFileSync(path, JSON.stringify(manifest, null, 2) + "\n");
  return version;
}

/** The h<hash> part of a stamped version, or undefined for an unstamped one. */
export function stampOf(version: string): string | undefined {
  return /\+h([0-9a-f]+)$/.exec(version)?.[1];
}
