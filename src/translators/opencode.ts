// OpenCode translator: canonical skills -> the files ktx drops into OpenCode's
// config dir (D-W5-2). OpenCode v2 has no plugin bundle or manifest (W5
// invariant 15), so the build root mirrors the config-dir paths ktx owns:
//   skills/<n>/            every skill (OpenCode discovers SKILL.md natively)
//   commands/ktx/<n>.md    one per procedure: typed as /ktx/<n> (D-W5-6)
//   plugins/ktx.ts         the prompt-trigger plugin (runtime/opencode-plugin.ts, D-W5-5)
//   ktx/manifest.json      the stamp (D-W5-8); ktx/triggers.json and
//   ktx/runtime/ktx-help.sh when any skill has a prompt trigger
//
// Seam S1 producer: the root's top-level entries are exactly those of
// ownedPaths(skills), commands/ktx holds exactly one <n>.md per procedure, and
// the manifest is {name, version, owned: ownedPaths(skills)}, stamped (placeBuild
// reads `owned` from the INSTALLED manifest to remove what a previous build owned
// — a renamed or deleted skill — before writing the new build).
// Seam S3 producer: every procedure's built SKILL.md carries
// metadata.opencode/autoinvoke: false (userOnlyOpencode, written with
// withFrontmatter's map form) and its command file is `---\ndescription: <the
// skill's>\n---\n` + commandText(skill), whose first line is `/ktx/<n> $ARGUMENTS`
// (D-W5-13) and whose text matches no shipped prompt trigger's regex.
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { assert } from "../assert";
import { invokeTrigger, invocation, promptTriggers, type Skill } from "../skill";
import { stampVersion } from "../install/stamp";
import { addFrontmatter, copySkills, installPromptTriggers, PLUGIN_NAME, readFrontmatter, resetPluginRoot, writeJson } from "./common";

/** The stamp's home inside the build and the installed config dir (D-W5-8). */
export const OPENCODE_MANIFEST = "ktx/manifest.json";

/** The plugin file OpenCode loads from its plugins dir (W5 invariant 5). */
const PLUGIN_FILE = "plugins/ktx.ts";
/** What is copied there: the plugin source beside this translator's own runtime. */
const PLUGIN_SOURCE = join(import.meta.dir, "..", "..", "runtime", "opencode-plugin.ts");
/** Commands are named by their path under the config dir: commands/ktx/lessons.md -> /ktx/lessons. */
const COMMAND_DIR = "commands/ktx";
/** Everything OpenCode reads out of a config dir that ktx owns. */
const SKILLS_DIR = "skills";
/** The build's own data dir, beside plugins/ in the config dir (invariant 42). */
const DATA_DIR = "ktx";

/** Build under outDir and return the root, whose layout is ownedPaths(skills). */
export function buildOpencode(skills: Skill[], outDir: string): string {
  const root = resetPluginRoot(outDir);

  copySkills(skills, root, "opencode");
  for (const skill of skills.filter((s) => invokeTrigger(s))) {
    // W5 invariant 43: the documented key hides the skill from the model's list
    // while the `skill` tool still loads it, so only the command starts it.
    addFrontmatter(root, skill.name, { metadata: { "opencode/autoinvoke": false } });
    assert(userOnlyOpencode(root, skill.name), `opencode build: ${skill.name} is still advertised after emitting its metadata (W5 invariant 43)`);
    writeCommand(root, skill);
  }
  copyPlugin(root);
  // One level below the build root: the plugin reads it from its sibling ktx/ dir.
  installPromptTriggers(skills, join(root, DATA_DIR));
  writeJson(join(root, OPENCODE_MANIFEST), { name: PLUGIN_NAME, version: "0.1.0", owned: ownedPaths(skills) });
  stampVersion(root, OPENCODE_MANIFEST);
  // Producer side of seam S1: read the tree back and refuse anything but the frozen layout.
  assertLayout(root, skills);
  return root;
}

/**
 * The config-dir paths ktx owns for this skill set, relative, sorted: `skills/<n>` per
 * skill, `commands/ktx` when any skill is a procedure, `plugins/ktx.ts`, `ktx`.
 * Install writes exactly these and doctor hashes exactly these (S1, D-W5-8).
 */
export function ownedPaths(skills: Skill[]): string[] {
  const paths = skills.map((s) => `skills/${s.name}`);
  if (skills.some((s) => invokeTrigger(s))) paths.push("commands/ktx");
  paths.push("plugins/ktx.ts", "ktx");
  return paths.sort();
}

/**
 * The command file's body (no frontmatter; buildOpencode adds it): first line
 * `/ktx/<n> $ARGUMENTS`, then one sentence telling the model to load the `<n>`
 * skill with its skill tool and follow it (S3, D-W5-13). The sentence never
 * writes the harness's own name before the skill name: a body that did would
 * match a shipped prompt trigger (selftest's `ktx self-?test`), and the trigger
 * would fire beside the command the user just typed.
 */
export function commandText(skill: Skill): string {
  const line = `${invocation("opencode", skill.name)} $ARGUMENTS`;
  return `${line}\n\nLoad the \`${skill.name}\` skill with your skill tool and follow it, passing the text after \`${skill.name}\` on the line above as its arguments.\n`;
}

/**
 * Whether the built SKILL.md at `root` hides `skill` from the model's skill list
 * (metadata.opencode/autoinvoke: false, W5 invariant 43). A predicate: a missing or
 * broken build answers "no". S3's producer asserts it; the procedure probe re-checks.
 */
export function userOnlyOpencode(root: string, skill: string): boolean {
  const meta = readFrontmatter(join(root, SKILLS_DIR, skill, "SKILL.md"))?.metadata;
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>)["opencode/autoinvoke"] === false;
}

/**
 * Write one procedure's command: OpenCode reads `description` from the frontmatter
 * and the body as the template it expands (W5 invariants 11, 44), so the file is
 * the frontmatter plus commandText and nothing else.
 */
function writeCommand(root: string, skill: Skill): void {
  const path = join(root, COMMAND_DIR, `${skill.name}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `---\ndescription: ${JSON.stringify(skill.description)}\n---\n${commandText(skill)}`);
}

/** The plugin file is the runtime source verbatim: install ships the bytes doctor hashes. */
function copyPlugin(root: string): void {
  const dest = join(root, PLUGIN_FILE);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(PLUGIN_SOURCE, dest);
}

/**
 * Seam S1's producer assertion, read off the built tree: the top-level entries are
 * ownedPaths' own, and under them sit exactly one folder per skill, one command per
 * procedure, the plugin, and the manifest — plus the runtime and triggers.json when a
 * skill has a prompt trigger. A build that could not say this is a layout install
 * would place wrongly, so it is refused here rather than in the config dir.
 */
function assertLayout(root: string, skills: Skill[]): void {
  const same = (where: string, got: string[], want: string[]) =>
    assert(got.length === want.length && got.every((e, i) => e === want[i]), `built tree ${where} holds ${got.join(", ")}; S1 is ${want.join(", ")}`);
  const sorted = (names: string[]) => [...names].sort();
  const procedures = skills.filter((s) => invokeTrigger(s)).map((s) => s.name);

  same("top level", sorted(readdirSync(root)), sorted([...new Set(ownedPaths(skills).map((p) => p.split("/")[0]))]));
  // A set with no skills owns no skills dir at all (ownedPaths says so above), so
  // only a build that ships one can be asked what is in it.
  if (skills.length) same("skills/", sorted(readdirSync(join(root, SKILLS_DIR))), sorted(skills.map((s) => s.name)));
  same("plugins/", readdirSync(join(root, dirname(PLUGIN_FILE))), [basename(PLUGIN_FILE)]);
  same("commands/ktx/", procedures.length ? sorted(readdirSync(join(root, COMMAND_DIR))) : [], sorted(procedures.map((n) => `${n}.md`)));
  const triggered = skills.some((s) => promptTriggers(s).length > 0);
  same("ktx/", sorted(readdirSync(join(root, DATA_DIR))), sorted(["manifest.json", ...(triggered ? ["runtime", "triggers.json"] : [])]));
  if (triggered) same("ktx/runtime/", readdirSync(join(root, DATA_DIR, "runtime")), ["ktx-help.sh"]);

  const manifest = JSON.parse(readFileSync(join(root, OPENCODE_MANIFEST), "utf8"));
  assert(manifest.name === PLUGIN_NAME && manifest.owned.join("\0") === ownedPaths(skills).join("\0"), "built manifest is not {name, owned: ownedPaths(skills)}");
  assert(/^0\.1\.0\+h[0-9a-f]{12}$/.test(manifest.version), `built manifest is not stamped: ${manifest.version}`);
}
