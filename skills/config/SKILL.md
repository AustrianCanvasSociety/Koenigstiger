---
name: config
description: Show or change ktx's own options (runbook folders, harnesses, theme and the rest) from inside this session. A procedure the user starts by name with list, get <key> or set <key> <value>.
---

# config

ktx's options live in `~/.config/ktx/`. `scripts/config.ts` reads and writes them; it is the same code as `ktx config` in a terminal, so it checks every value and writes nothing it refuses.

What the user asked for: $ARGUMENTS

If `$ARGUMENTS` above was left as written, use the text the user typed after the command instead.

## Steps

1. **Pick the form.** Nothing asked for, or a question about what can be set, is `list`. A request to see one option is `get <key>`. A request to change one is `set <key> <value>`. If the user named an option loosely ("the colours"), run `list` first and match it to a key; if two keys fit, ask which.
2. **Run it** from this skill's folder: `bun scripts/config.ts list`, `bun scripts/config.ts get <key>` or `bun scripts/config.ts set <key> <value>`. One option per `set`. A list value is comma-separated (`set harnesses claude,kimi`), an on/off option takes `on` or `off`, and an empty value (`""`) clears a list.
3. **Reply with the script's output, verbatim.** For `list` that is every line, `key = value  # label`. For `set` it is the one line `key = value` the script printed after saving.

## When the script refuses

- **Exit 2:** the option or value was refused and nothing was saved. Give the user the script's one-line reason; it names the valid options or choices. Do not guess a nearby value and retry.
- **Exit 3:** this session may not write `~/.config/ktx/` (a harness sandbox). Nothing was saved. Give the user the terminal command the script printed, exactly, and stop. Do not edit the files by hand or look for another way to write them.

## Not from here

The arrow-key menu, with the theme preview, needs a real terminal: `ktx config` there. Changing `harnesses` only records the choice; `ktx install` in a terminal does the installing.
