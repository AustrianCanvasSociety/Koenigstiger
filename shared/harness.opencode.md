# Harness sheet — OpenCode

This harness's own steps for the swarm procedures (D-W4-4). A build ships this sheet as `harness.md` in the skill's folder; the procedure bodies cite its sections by heading and name no harness tool of their own. What follows was observed on OpenCode 2.0.20.

## Spawn

One wave member is one `subagent` call: `{agent, description, prompt, model?, sessionID?, background?}`. A wave is N of these calls in **one** assistant message — calls in one message run concurrently, which is OpenCode's own behaviour. That the message holds no other tool call beside them is the procedure body's own rule (`SKILL.md`, step 3), not the harness's: OpenCode would run another call in the same message too.

- **`agent`** is the member type. `general` is the workhorse and denies itself `subagent` and `question`; `explore` is read-only (it denies every write, shell and spawn action and allows reads, grep, glob and the network tools). An agent whose mode is `primary` cannot be spawned at all, and an unknown name fails the call.
- **`description`** is a three-to-five-word label the user sees; **`prompt`** is the whole of what the member reads — its item's text, with the scope, the paths it owns (ending `Owns: <paths>`) and the exact shape of the answer wanted. A child session starts with fresh context, so nothing of your own conversation reaches it.
- **Cap.** OpenCode imposes no concurrency cap in code: what a machine carries is what it runs. Depth is 1 — a member cannot spawn: `general` and `explore` deny `subagent`, and for any other agent the `subagent` tool refuses a call made at depth `experimental.subagent_depth` (default 1), so a wave is one level and that setting is what would raise it. That depth holds for the shipped rulesets: a config-level `subagent` rule is appended after every agent's own, so a top-level `subagent` allow in `opencode.json` would undo `general`'s deny as well and leave depth 1 resting on the runtime check alone. A stage wider than the machine can carry is run in batches, never as a refused call.
- **The member id you record.** Each call's answer is `<subagent sessionID="ses_…" state="completed">\n<answer>\n</subagent>`; the `sessionID` is the member's child session id, globally unique, and that is the member's `agentId` (`records.md`).
- **No todo tool.** OpenCode v2 offers none, so a body that tracks its own stages keeps the plan in its own messages, and the wave's list of items lives in the dispatch.

## Wait and resume

A `subagent` call without `background` is a foreground call: it returns when its member is final, with that member's answer in the `<subagent …>` block above. Start every member of a stage before waiting on any of them, then hold until **every** call has returned — the wave is not half-done when half the members answer, and a member still running has no final message to record.

Resume a member by the id it was spawned under: pass its `sessionID` back in a later `subagent` call to continue that member's conversation. A call without a `sessionID` starts a new child session, so an id is what makes a re-run the same member rather than a second one.

`background: true` returns at once with the child's `sessionID` and a notice not to poll; the answer arrives later as a synthetic `<subagent …>` message in your own session. That mode suits a lone member; a wave whose records must be written waits in the foreground.

## Member permissions

A member runs under its own agent's ruleset — the `agent` argument picks it, and a member *can* be more restricted than the lead (unlike the harnesses whose members inherit the lead's mode). That ruleset is OpenCode's ordered `{action, resource, effect}` list: the last matching rule wins, and an action no rule matches is `ask` (`permissions.mdx`). v2 action names are `shell`, `edit`, `read`, `glob`, `grep`, `skill`, `subagent`, `question`, `webfetch`, `websearch` and `external_directory`.

Decide the rules before the wave — nobody can approve a member's tool call mid-wave. In a headless run (`opencode run`) there is no one to ask: every `ask` is rejected with feedback and the model carries on, so a wave that must write is one whose rules allow the write, or one run with `--auto`, which answers `once` (an explicit deny still holds). In a session you are running interactively, `ask` reaches you.

**Runbook reads.** A `read` of a path outside the project is not a `read` decision but an `external_directory` one, and the default policy answers that action `ask`. A headless run (`opencode run`) has nobody to answer, so the read is refused and the model falls back to `shell`; for a shell command that ask covers the command's working directory and the folders a `cd`, `chdir`, `popd`, `pushd`, `push-location` or `set-location` names, not a file path handed to a command such as `sed` or `cat`, which the default `shell` rules let run — so the answer from the runbooks still comes, with one refusal line on stderr per refused read. Interactively each such read raises its own prompt, one per read. The narrow way to stop them is the owner's: add an `external_directory` allow to `opencode.json` by hand for the runbook roots ktx is configured with, and for those alone. Picking "Always allow" at a prompt also stops them, but it saves a lasting allow rule for the whole git checkout that holds the read folder — `<git root>/*`, or the folder itself where no checkout holds it — for the current project, so later runs in that project may read anywhere in that checkout, not that folder alone. ktx writes nothing to `opencode.json` (D-W6-1).

## Models

Name a member's model with the call's `model`, written `provider/model` or `provider/model#variant`; OpenCode validates it against the provider's model list and fails the call on an unknown model or variant. A member runs on the call's `model`, else on the model its own agent has configured, else on yours — so omitting it inherits your model only for an agent with no configured model, true of the shipped `general` and `explore` and false of any agent whose `agents.<id>.model` the config sets, since that model wins over yours. A member needs another model only when the dispatch says so. The names are the account's own: the interactive `/models` selector lists the enabled models whose provider is available here, and the config's own `model` key names the default (`models.mdx`).

What is recorded is the model the member's own export carries: `{id, providerID, variant}`, filled in as `variant: "default"` even when none was asked for. A gate compares lenses by the normalised spelling `provider/id`, with `#variant` only when the variant is not `default`. Write `registry.json`'s `model` as that spelling and write `recon.json`'s `model` as the spelling the recon run's own export records (`## Transcripts`): an alias the run did not keep would put one model under two spellings no check can tell apart.

## Lens command

A review lens is one headless run, in a fresh worktree of the frozen commit, with its whole final message the lens-schema JSON and nothing else (the schema is in the lens's own file):

```sh
printf '%s' '<the lens prompt>' | opencode run --standalone --agent explore -m <model> --format json
```

- **The prompt goes on stdin, never as a message argument.** `opencode run` wraps any argument holding a space in quotes and admits it that way, while piped stdin is taken verbatim — a two-line prompt with inner quotes reached the model byte-for-byte (invariant 34). `--format json` prints the run as NDJSON: `step_start`, `text`, `tool_use`, `step_finish`, `error`, each line carrying the run's own `sessionID`. The stream prints a `text` line per text part of every step, so the `text` events concatenated are not the final message: a run that writes a sentence before a tool call prints that sentence too. The lens verdict is the session's final message by the transcript rule (`## Transcripts`) — the newest assistant message that completed without an error, its text parts joined — which `opencode session export --standalone <ses_id>` prints for the run's own `sessionID`. Read the verdict from that export, never from the concatenated `text` events.
- **Run it from inside the lens's worktree, with `cd`.** `opencode run` takes its project directory from `PWD` before its real working directory, so a command started with only a changed working directory (a spawn's `cwd` option, say) still works in whatever directory `PWD` names — the checkout the lead came from. `cd <worktree> && printf … | opencode run …` sets both.
- **`--standalone`** runs the command against a private server, so no shared background service is left behind. **No `--auto`**: a lens approves nothing for itself. `explore` is read-only inside the worktree it runs in — its two `ask` rules are a read outside that directory and a read of a `.env`, and a headless run rejects an `ask` rather than waiting — so the lens reads its worktree and writes nothing.
- Two lenses per gate: the adversarial lens on the secondary model, the recon lens on the model you are running on, each in its own worktree and its own run. Snapshot `git status --short` in the lens's worktree before it starts and fail that lens on any change after it — that check is the guard a lens has to pass in every harness; the read-only agent is the belt to its braces.
- Record the run's own `sessionID` from the stream as that lens member's `agentId`, with no `session` (`## Transcripts`).

## Transcripts

Every session on the machine lives in one SQLite database, and no session has a file of its own. A member's transcript is therefore materialised when it is read: `opencode session export --standalone <ses_id>` prints the session as `{info, messages[]}` — `info` carrying the id, `parentID`, agent, model, cost, tokens and outcome, and each message its own agent, model, content and timings.

- **A member.** Record the child `sessionID` the spawn answered with as the member's `agentId`, and **record no `session`**: session ids are globally unique, so an id alone names one member, and the locator ignores a `session` field.
- **A lens run.** Record the `sessionID` its stream carries as its `agentId`, and no `session`; its model is what the transcript check reads back from its export, never what you asked for.
- **What you record is what the member said.** OpenCode's own rule for a member's answer is the newest assistant message that completed without an error, its text parts joined — the same rule the transcript check applies to the export. Record that text; the check compares it with the export after trimming both, so a paraphrase fails rather than passing silently.
- **Running the check.** `scripts/cli.ts transcripts <root> <wave-id>` uses the build's own locator, which exports each member into `$TMPDIR/ktx-opencode-export/<ses_id>.json` and hashes that file. Run it in the environment the wave ran in — `opencode` resolves its config, data and database from the same roots there, and `opencode debug paths` names them — and on the machine that ran the wave.
- Never edit an export; the check re-reads it from the harness's own answer.

## Notify and background

OpenCode v2 has no tool that reaches an absent user, so the wave's report is the answer you print at the end of the turn, and a wave you stop says so in that answer. A background `subagent` call notifies you inside the session when its member finishes; it never reaches the user.

A long shell command runs with the shell tool's `background: true`, which returns at once with a shell id and streams the output to a file the tool names; a background command has no timeout unless you set one (`timeout: 0` disables it), while a foreground command is cut at 120 s. You are told when a background command completes, so do not poll it — and do not end the turn while the wave's members are still running: their answers arrive as session messages, and records written before they land are not the wave's.
