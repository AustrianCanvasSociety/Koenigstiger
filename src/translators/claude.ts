// Claude Code translator: canonical skills -> one Claude Code plugin named ktx.
// Bodies are copied unchanged; a procedure's built SKILL.md gains the frontmatter
// that makes Claude start it only for the user (D-W2-3), and prompt triggers
// become a single UserPromptSubmit hook that runs runtime/ktx-help.sh over
// triggers.json.
import { join } from "node:path";
import { assert } from "../assert";
import { invokeTrigger, type Skill } from "../skill";
import { addFrontmatter, copySkills, HOOK_INTERPRETER, installPromptTriggers, PLUGIN_NAME, readFrontmatter, resetPluginRoot, writeJson, writePromptHook } from "./common";

export { PLUGIN_NAME };
/** Also the description of the plugin's entry in the install adapter's marketplace. */
export const CLAUDE_DESCRIPTION = "Portable Königstiger skills, translated for Claude Code.";

/** Build the plugin under outDir and return the plugin root. */
export function buildClaude(skills: Skill[], outDir: string): string {
  const root = resetPluginRoot(outDir);

  writeJson(join(root, ".claude-plugin", "plugin.json"), {
    name: PLUGIN_NAME,
    version: "0.1.0",
    description: CLAUDE_DESCRIPTION,
  });
  copySkills(skills, root, "claude");
  for (const skill of skills) {
    const invoke = invokeTrigger(skill);
    if (!invoke) continue;
    // The canonical SKILL.md is spec-only, so the harness keys land on the built
    // copy alone (seam S1: withFrontmatter refuses a key the file already has).
    addFrontmatter(root, skill.name, {
      "disable-model-invocation": true,
      ...(invoke.args ? { "argument-hint": invoke.args } : {}),
    });
    // Seam S2 producer: the probe asserts the same predicate on this build before
    // it runs the harness, so a procedure must be user-only the moment it is built.
    assert(userOnly(root, skill.name), `${skill.name}: built SKILL.md is not user-only (D-W2-3)`);
  }
  if (installPromptTriggers(skills, root)) {
    writePromptHook(root, `${HOOK_INTERPRETER} "\${CLAUDE_PLUGIN_ROOT}"/runtime/ktx-help.sh claude`);
  }
  return root;
}

/**
 * Whether the built plugin at `root` marks `skill` user-only in this harness
 * (D-W2-3). The build asserts it after emitting (producer); the invoke probe
 * asserts it before running the harness (consumer). W2 claude track.
 */
export function userOnly(root: string, skill: string): boolean {
  // `disable-model-invocation: true` is the whole of it: `user-invocable: false`
  // would break the explicit `/ktx:<skill>` form and is never emitted (invariant 6).
  // A build with no such skill, or a SKILL.md readFrontmatter cannot parse, is not
  // user-only — never an error, since the probe asks this about any build it is given.
  return readFrontmatter(join(root, "skills", skill, "SKILL.md"))?.["disable-model-invocation"] === true;
}
