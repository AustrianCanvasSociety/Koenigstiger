# Königstiger

Portable skills for any CLI coding harness. The command, the plugin id and the config folder are `ktx`, which is quicker to type. Each skill is written once and translated into each harness's native wiring, and every translation is proved by a live headless run.

## Layout

- `skills/<name>/SKILL.md` — the skill itself, in the [Agent Skills](https://agentskills.io) format with only the spec's six frontmatter fields, so every harness can read it unchanged.
- `skills/<name>/ktx.yaml` — translator-only data: how the skill is triggered (`triggers`), the text shown when it fires (`instruction`), and the live test (`probe`). Harnesses never read it.
- `src/translators/<harness>.ts` — one translator per harness.
- `runtime/ktx-help.sh` — the prompt hook every translator installs; one script, with the output format chosen per harness.
- `runtime/opencode-plugin.ts` — OpenCode's plugin: a `prompt` hook that runs `ktx-help.sh` on every prompt and appends what it prints.

## Usage

```bash
bun test                                   # unit tests
bun run src/cli.ts check                   # validate every skill
bun run src/cli.ts build claude --out dist # write the Claude Code plugin to dist/ktx
bun run src/cli.ts build kimi --out dist   # write the Kimi plugin to dist/ktx
bun run src/cli.ts build codex --out dist  # write the Codex plugin to dist/ktx and a marketplace at dist/
bun run src/cli.ts build opencode --out dist # write OpenCode's drop-in config tree to dist/ktx
KTX_RUNBOOK_ROOTS=<dir>:<dir> bun run src/cli.ts probe claude howdoi   # live test (also: probe kimi, probe codex, probe opencode)
bun run src/cli.ts doctor                  # check the installs; exit 1 on any gap
```

`doctor` checks the harnesses you name, else the ones in the `harnesses` option (`ktx config set harnesses claude,kimi`). With neither, it looks for ktx in all four, checks every harness it finds it in, and prints one `not installed` line for each of the others. Finding ktx in none is a gap.

`bun run src/cli.ts config` opens the options menu (it needs a terminal); `config list`, `config get <key>` and `config set <key> <value>` do the same from a script. The menu's colours are the `theme` option: `dunkelgelb` (the default), `tieforange`, `rot-schwarz` or `glut`. On the Theme row, space steps through them and the menu redraws in each; `s` keeps the choice. `NO_COLOR=1` draws the menu without colour.

Inside a harness session the `config` skill does the script forms: `/ktx:config list`, `/ktx:config get theme`, `/ktx:config set theme glut` (`$ktx:config` in Codex, `/skill:config` in Kimi, `/ktx/config` in OpenCode). It runs the same code as the CLI, so it refuses the same values. The menu itself stays in a terminal. Codex's workspace sandbox refuses writes to `~/.config/ktx/`, so there `set` saves nothing and prints the command to run in a terminal; `list` and `get` work.

Installing for real (changes your harness config, so it is a manual step):

- Claude Code: `claude --plugin-dir dist/ktx` for one session, or add it through a plugin marketplace.
- Kimi: `/plugins install <path to dist/ktx>` inside an interactive session.
- Codex: `codex plugin marketplace add dist` then `codex plugin add ktx@ktx-local`, then trust the hook in `/hooks`.
- OpenCode: `bun src/cli.ts install opencode` copies the skills, the `/ktx/<name>` commands, the plugin and ktx's data into OpenCode's config dir (`OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode`, else `~/.config/opencode`). It never edits `opencode.json`. `bun src/cli.ts doctor opencode` checks the install and reports any other skill or command that shadows a ktx one. When `howdoi` reads your runbooks, OpenCode's default policy asks before each read outside the project. To stop the prompts, add an `external_directory` allow to `opencode.json` yourself for only the folders in `~/.config/ktx/runbook-roots`. Picking "Always allow" in the TUI also stops them, but it saves an allow for the whole git checkout that holds the runbook folder, for that project. A headless `opencode run` refuses those reads, and the model reads them through the shell instead, whose check covers only its working directory and the folders a `cd` names, not a file path given to a command.

A probe passes only on harness evidence plus an answer matching every `expect` pattern. For a prompt skill the evidence is that the prompt hook fired with the skill's `[ktx:<name>]` marker (for Claude, also that the plugin loaded). For a procedure (a skill the user starts by name) the probe invokes it the harness's own way (`/ktx:<name>` in Claude, `$ktx:<name>` in Codex, `/skill:<name>` over Kimi's ACP interface, `/ktx/<name>` in OpenCode) and requires the harness's own record that it loaded the body; with `probe.offer` it also checks that the model offers the procedure without starting it. A correct answer alone doesn't count, because the model can sometimes find the files without the skill.

Probes never change your harness setup. Claude runs with `--plugin-dir` and project-only settings from an empty folder. Kimi runs in a throwaway `KIMI_CODE_HOME` (config and login are symlinked, never copied) with a read-only agent, because Kimi's print mode approves every tool automatically. Codex runs in a throwaway `CODEX_HOME` (login symlinked, model settings carried over), installs the plugin with Codex's own CLI, and runs `codex exec` in a read-only sandbox. Its stream has no hook events, so the evidence is the session record of what the model was given. OpenCode runs `opencode run --standalone` in throwaway config, data, state and cache dirs, on the model named by `KTX_OPENCODE_PROBE_MODEL` (`provider/model`) from the provider document in `KTX_OPENCODE_PROBE_CONFIG`; the evidence is the run's own session export, where the hook's edit is the stored user message. A probe whose body writes files (Kimi and OpenCode) runs inside a macOS `sandbox-exec` fence that refuses every write outside the probe's own temp dir, so those probes run on a Mac only.

## howdoi

Answers "how do we…" questions from our runbooks. Runbook folders come from `KTX_RUNBOOK_ROOTS` (colon-separated) or `~/.config/ktx/runbook-roots` (one per line).

The search ranks sections (a heading and the text under it), not whole files. A question word counts most when it is in a section's heading, then in the file's name, then in the section's text. On a prompt, the hook adds runbook matches only when two different question words are in the top section's heading or file name; otherwise it adds nothing. Two ways around the rule: say "runbook" in the prompt ("check the runbooks for the NAS mount"), or run `/ktx:howdoi`. Either one searches and shows the best sections whatever they score.

- **Aliases.** When you call a thing by a different word than the runbooks do, add a line to `~/.config/ktx/runbook-aliases` (or the file named by `KTX_RUNBOOK_ALIASES`): `tailscale: headscale mesh vpn`. The word on the left then matches the words on the right. Lines starting with `#` are comments.
- **Decision log.** Each prompt that reaches the search is appended to `~/.cache/ktx/howdoi-decisions.jsonl` (or `KTX_HOWDOI_LOG`) with the top section and whether matches were added. The file holds your prompts and stays on the machine; it is the record for tuning the rule later.

The live probe's question (`how do we add a computer to our tailscale?`) needs that alias line and `computer: peer node device`, so run probes on a machine that has them or pass `KTX_RUNBOOK_ALIASES`.

## Harness status

| Harness | Translator | Live probe |
|---|---|---|
| Claude Code | plugin + `UserPromptSubmit` hook | passing |
| Kimi | plugin (`kimi.plugin.json`) + `UserPromptSubmit` hook | passing |
| Codex | plugin (`.codex-plugin/plugin.json`) + local marketplace + `UserPromptSubmit` hook | passing |
| OpenCode | drop-in config dir: skills + `/ktx/<name>` commands + `prompt`-hook plugin | passing |
