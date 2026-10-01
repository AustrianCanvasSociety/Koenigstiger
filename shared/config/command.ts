// `config list | get <key> | set <key> <value>`: the script forms of the options menu.
// One function, called by `ktx config` (src/cli.ts) and by the config skill's script.
import type { Env } from "./env";
import { formatValue, loadOptions, OPTIONS, optionDef, parseValue, saveOptions } from "./options";

/**
 * Run one script form and return the lines to print, or null when `args` is none of
 * the three (the caller prints its own usage). `set` saves before it answers. A value
 * or key that is refused throws with the reason, and nothing is written.
 */
export function configCommand(env: Env, args: string[]): string[] | null {
  const [verb, key, ...value] = args;
  if (verb === "list") {
    const options = loadOptions(env);
    return OPTIONS.map((def) => `${def.key} = ${formatValue(def, options[def.key])}  # ${def.label}`);
  }
  if (verb === "get" && key) {
    const def = optionDef(key);
    return [formatValue(def, loadOptions(env)[def.key])];
  }
  // An empty value is a value: `set harnesses ""` clears the list.
  if (verb === "set" && key && value.length) {
    const options = loadOptions(env);
    const def = optionDef(key);
    options[def.key] = parseValue(def, value.join(" "));
    saveOptions(env, options);
    return [`${def.key} = ${formatValue(def, options[def.key])}`];
  }
  return null;
}
