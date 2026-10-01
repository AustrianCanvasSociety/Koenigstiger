// Codex translator: canonical skills -> one Codex plugin (.codex-plugin/plugin.json
// declaring skills/ and hooks/hooks.json) with a UserPromptSubmit hook, plus a
// local marketplace at the output root so Codex can install it:
// `codex plugin marketplace add <out>` then `codex plugin add ktx@ktx-local`.
//
// Why .codex-plugin and not the documented portable root plugin.json: on Codex
// 0.157.1 a root manifest's hooks never ran, whether left at the default
// hooks/hooks.json or declared under extensions.com.openai; the same hook ran
// from .codex-plugin/plugin.json (live A/B, 2026-09-29).
//
// A procedure skill (on: invoke) is made user-only by a side file, not by
// SKILL.md frontmatter: Codex ignores frontmatter such as
// disable-model-invocation, and reads skills/<name>/agents/openai.yaml
// policy.allow_implicit_invocation (D-W2-3, invariant 16).
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assert } from "../assert";
import { invokeTrigger, type Skill } from "../skill";
import { copySkills, HOOK_INTERPRETER, installPromptTriggers, MARKETPLACE, PLUGIN_NAME, readYaml, resetPluginRoot, writeJson, writePromptHook } from "./common";

export const CODEX_MARKETPLACE = MARKETPLACE;

/** Generated, never canonical: the skill's own copy is a load error (src/skill.ts). */
const OPENAI_YAML = join("agents", "openai.yaml");
/** Hides the skill from the model's catalog while a `$ktx:<skill>` mention still injects it. */
const USER_ONLY_YAML = "policy:\n  allow_implicit_invocation: false\n";

/** Build the plugin at <outDir>/ktx and the marketplace at <outDir>; return the plugin root. */
export function buildCodex(skills: Skill[], outDir: string): string {
  const root = resetPluginRoot(outDir);

  const manifest: Record<string, unknown> = {
    name: PLUGIN_NAME,
    version: "0.1.0",
    description: "Portable Königstiger skills, translated for Codex.",
    skills: "./skills/",
  };
  copySkills(skills, root, "codex");
  for (const skill of skills.filter((s) => invokeTrigger(s))) markUserOnly(root, skill.name);
  if (installPromptTriggers(skills, root)) {
    manifest.hooks = "./hooks/hooks.json";
    writePromptHook(root, `${HOOK_INTERPRETER} "$PLUGIN_ROOT"/runtime/ktx-help.sh codex`);
  }
  writeJson(join(root, ".codex-plugin", "plugin.json"), manifest);

  writeJson(join(outDir, ".agents", "plugins", "marketplace.json"), {
    name: CODEX_MARKETPLACE,
    interface: { displayName: "Königstiger" },
    plugins: [{
      name: PLUGIN_NAME,
      source: { source: "local", path: `./${PLUGIN_NAME}` },
      policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
      category: "Productivity",
    }],
  });
  return root;
}

/** lstat that answers null instead of throwing: "there" includes a dangling symlink. */
function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

/**
 * Write one built procedure skill's side file. The file is generated, so a
 * canonical one would be overwritten in silence: refuse it first (seam S1
 * consumer, as loadSkill does), then assert the emitted result (seam S2
 * producer, the same predicate the invoke probe asserts before it runs).
 */
function markUserOnly(root: string, skill: string): void {
  const agents = join(root, "skills", skill, "agents");
  const path = join(agents, "openai.yaml");
  // copySkills dereferences, so both are real entries in the build today. These
  // two are the belt to that brace: a link that survived a copy would take the
  // write out of the build, back into the canonical skill it was copied from.
  assert(!lstatOrNull(agents)?.isSymbolicLink(), `built skill ${skill}: agents/ is a symlink; ktx never writes through one`);
  assert(!lstatOrNull(path)?.isSymbolicLink(), `built skill ${skill}: ${OPENAI_YAML} is a symlink; ktx never writes through one`);
  // lstat, not exists: a dangling link is still there, and a write would follow it.
  assert(!lstatOrNull(path), `built skill ${skill} already has ${OPENAI_YAML}; ktx generates it`);
  mkdirSync(agents, { recursive: true });
  writeFileSync(path, USER_ONLY_YAML);
  assert(userOnly(root, skill), `built skill ${skill} is not marked user-only for Codex`);
}

/**
 * Whether the built plugin at `root` marks `skill` user-only in this harness
 * (D-W2-3). The build asserts it after emitting (producer); the invoke probe
 * asserts it before running the harness (consumer). W2 codex track.
 *
 * A side file that is missing, empty, unparseable or not a mapping answers
 * "no" instead of throwing (common.readYaml): the probe asks this about a build
 * it then refuses to run, where a thrown parse error would read as a ktx crash.
 * Only the boolean counts — a `"false"` string is not the policy Codex reads.
 */
export function userOnly(root: string, skill: string): boolean {
  const file = readYaml(join(root, "skills", skill, OPENAI_YAML)) as { policy?: { allow_implicit_invocation?: unknown } } | null;
  return file?.policy?.allow_implicit_invocation === false;
}
