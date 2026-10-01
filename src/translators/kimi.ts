// Kimi Code translator: canonical skills -> one Kimi plugin named ktx.
// Skills are copied unchanged; prompt triggers become a single UserPromptSubmit
// hook in kimi.plugin.json. Kimi runs plugin hooks from the plugin root and
// allows only event / matcher / command / timeout per hook entry.
// A procedure (on: invoke) gains `disable-model-invocation: true` in its built
// SKILL.md (D-W2-3, invariant 10): the Skill tool refuses it, so only the user
// can start it. The canonical file stays spec-only and the body is copied as is.
import { join } from "node:path";
import { assert } from "../assert";
import { invokeTrigger, type Skill } from "../skill";
import {
  addFrontmatter, copySkills, HOOK_INTERPRETER, HOOK_TIMEOUT_S, installPromptTriggers, PLUGIN_NAME, readFrontmatter, resetPluginRoot, writeJson,
} from "./common";

/** Build the plugin under outDir and return the plugin root. */
export function buildKimi(skills: Skill[], outDir: string): string {
  const root = resetPluginRoot(outDir);

  copySkills(skills, root, "kimi");
  for (const skill of skills) {
    if (!invokeTrigger(skill)) continue;
    addFrontmatter(root, skill.name, { "disable-model-invocation": true });
    // Seam S2 producer: what the probe's consumer assert will check before running anything.
    assert(userOnly(root, skill.name), `kimi build: ${skill.name} is not user-only after emitting its frontmatter`);
  }
  const manifest: Record<string, unknown> = {
    name: PLUGIN_NAME,
    version: "0.1.0",
    description: "Portable Königstiger skills, translated for Kimi Code.",
    skills: "./skills/",
  };
  if (installPromptTriggers(skills, root)) {
    manifest.hooks = [{ event: "UserPromptSubmit", command: `${HOOK_INTERPRETER} ./runtime/ktx-help.sh kimi`, timeout: HOOK_TIMEOUT_S }];
  }
  writeJson(join(root, "kimi.plugin.json"), manifest);
  return root;
}

/**
 * Whether the built plugin at `root` marks `skill` user-only in this harness
 * (D-W2-3). The build asserts it after emitting (producer); the invoke probe
 * asserts it before running the harness (consumer). W2 kimi track.
 */
export function userOnly(root: string, skill: string): boolean {
  // A predicate, so a missing, spec-only or unparseable build answers "no" rather
  // than throw. Only the key D-W2-3 names counts: Kimi's other spellings are never
  // emitted, so a build that used one is not user-only as far as this seam sees it.
  return readFrontmatter(join(root, "skills", skill, "SKILL.md"))?.["disable-model-invocation"] === true;
}
