// User options behind `ktx config`. One registry drives the menu, `ktx config get/set`,
// the config skill, install and doctor. Stored in ~/.config/ktx/config.toml, except the
// runbook roots, which live in ~/.config/ktx/runbook-roots because the installed hook reads
// that file. In shared/ so the skill's script reaches it from an installed plugin, where
// src/ does not exist: it imports nothing outside this folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir, HARNESS_NAMES, type Env } from "./env";
import { DEFAULT_THEME, THEME_NAMES } from "./themes";

export type OptionValue = boolean | string[] | string;
export type Options = Record<string, OptionValue>;
export type OptionDef = {
  key: string;
  label: string; // menu line; written `Group: text`, the menu draws the text under that group's heading
  help: string; // one sentence under the menu line
  kind: "bool" | "list" | "choices" | "one"; // choices: a subset of `choices`; one: exactly one of `choices`; list: free-form entries
  choices?: string[];
  default: OptionValue;
};

export const ROOTS_KEY = "runbook.roots";

export const OPTIONS: OptionDef[] = [
  {
    key: ROOTS_KEY,
    label: "Runbook folders",
    help: "Folders howdoi searches for runbooks.",
    kind: "list",
    default: [],
  },
  {
    key: "harnesses",
    label: "Harnesses",
    help: "Which harnesses ktx install and ktx doctor cover when none is named. Empty: name one each time.",
    kind: "choices",
    choices: [...HARNESS_NAMES],
    // Every install is opt-in (D-W5-3): nothing is a target until the owner names it.
    default: [],
  },
  {
    key: "codex.trust-hook",
    label: "Codex: approve the ktx hook automatically",
    help: "On: ktx install codex records hook trust itself, skipping Codex's /hooks review. Off: approve it once in /hooks.",
    kind: "bool",
    default: false,
  },
  {
    // D-W4-12, seam S6 producer: a list of non-empty strings, checked by checkValue.
    key: "kimi.expected-shadows",
    label: "Kimi: folders whose skills may shadow ktx's",
    help: "ktx doctor reports a Kimi skill from one of these folders that shadows a ktx skill as expected, not as a gap.",
    kind: "list",
    default: [],
  },
  {
    // D-W5-9, seam S5 producer (W5): a list of non-empty strings, checked by checkValue.
    key: "opencode.expected-shadows",
    label: "OpenCode: folders whose skills may share a ktx skill's name",
    help: "ktx doctor reports an OpenCode skill from one of these folders with a ktx skill's name as expected, not as a gap.",
    kind: "list",
    default: [],
  },
  {
    key: "theme",
    label: "Appearance: theme",
    help: "The colours this menu is drawn in. A change shows at once; s keeps it.",
    kind: "one",
    choices: [...THEME_NAMES],
    default: DEFAULT_THEME,
  },
];

export function optionDef(key: string): OptionDef {
  const def = OPTIONS.find((o) => o.key === key);
  if (!def) throw new Error(`unknown option ${key} (options: ${OPTIONS.map((o) => o.key).join(", ")})`);
  return def;
}

export const configPath = (env: Env) => join(configDir(env), "config.toml");
export const rootsPath = (env: Env) => join(configDir(env), "runbook-roots");

/** Defaults, overlaid with config.toml, overlaid with runbook-roots. Unknown or ill-typed keys are errors. */
export function loadOptions(env: Env): Options {
  const options: Options = Object.fromEntries(OPTIONS.map((o) => [o.key, structuredClone(o.default)]));
  const config = configPath(env);
  const roots = rootsPath(env);
  if (existsSync(config)) {
    let data: Record<string, unknown>;
    try {
      data = Bun.TOML.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${config}: ${(err as Error).message}`);
    }
    for (const [key, value] of Object.entries(data)) {
      if (key === ROOTS_KEY) throw new Error(`${config}: ${ROOTS_KEY} belongs in ${roots}`);
      // A bare dotted key (codex.trust-hook = true) parses as a nested table.
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        throw new Error(`${config}: quote dotted option names, e.g. "codex.trust-hook" = true`);
      }
      options[key] = checkValue(optionDef(key), value);
    }
  }
  if (existsSync(roots)) {
    // Read exactly as howdoi.sh does: every non-empty line, untrimmed.
    options[ROOTS_KEY] = readFileSync(roots, "utf8").split("\n").filter(Boolean);
  }
  return options;
}

/** Write config.toml (every non-default option) and runbook-roots (one folder per line). Validates everything before writing anything. */
export function saveOptions(env: Env, options: Options): void {
  const lines = ["# ktx options — edit with `ktx config`."];
  for (const def of OPTIONS) {
    if (def.key === ROOTS_KEY) continue;
    const value = checkValue(def, options[def.key]);
    if (JSON.stringify(value) !== JSON.stringify(def.default)) lines.push(`${JSON.stringify(def.key)} = ${JSON.stringify(value)}`);
  }
  const roots = checkValue(optionDef(ROOTS_KEY), options[ROOTS_KEY]) as string[];
  const bad = roots.find((r) => /[\r\n]/.test(r));
  if (bad !== undefined) throw new Error(`${ROOTS_KEY}: a folder cannot contain a line break: ${JSON.stringify(bad)}`);
  mkdirSync(configDir(env), { recursive: true });
  writeFileSync(configPath(env), lines.join("\n") + "\n");
  writeFileSync(rootsPath(env), roots.map((r) => r + "\n").join(""));
}

/** Parse `ktx config set` text: on/off/true/false for bool, one name for a single choice, comma-separated entries otherwise. */
export function parseValue(def: OptionDef, text: string): OptionValue {
  if (def.kind === "bool") {
    const t = text.trim().toLowerCase();
    if (["on", "true", "yes", "1"].includes(t)) return true;
    if (["off", "false", "no", "0"].includes(t)) return false;
    throw new Error(`${def.key}: expected on or off, got ${text}`);
  }
  if (def.kind === "one") return checkValue(def, text.trim());
  return checkValue(def, text.split(",").map((s) => s.trim()).filter(Boolean));
}

export function formatValue(def: OptionDef, value: OptionValue): string {
  if (def.kind === "bool") return value ? "on" : "off";
  if (def.kind === "one") return value as string;
  const list = value as string[];
  return list.length ? list.join(", ") : "(none)";
}

function checkValue(def: OptionDef, value: unknown): OptionValue {
  if (def.kind === "bool") {
    if (typeof value !== "boolean") throw new Error(`${def.key}: expected a boolean`);
    return value;
  }
  if (def.kind === "one") {
    // Exactly one of the choices, and never a prototype's key (`Object.hasOwn`-style membership, by list).
    if (typeof value !== "string" || !def.choices!.includes(value)) {
      throw new Error(`${def.key}: expected one of ${def.choices!.join(", ")}, got ${JSON.stringify(value)}`);
    }
    return value;
  }
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v)) {
    throw new Error(`${def.key}: expected a list of non-empty strings`);
  }
  if (def.kind === "choices") {
    const bad = value.filter((v) => !def.choices!.includes(v));
    if (bad.length) throw new Error(`${def.key}: unknown ${bad.join(", ")} (choices: ${def.choices!.join(", ")})`);
    // Empty is a valid choice: every install is opt-in (D-W5-3), so none chosen means none installed.
    return def.choices!.filter((c) => value.includes(c)); // registry order, no duplicates
  }
  return [...value];
}
