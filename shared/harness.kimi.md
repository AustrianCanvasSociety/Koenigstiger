# Harness sheet — Kimi Code

This harness's own steps for the swarm procedures (D-W4-4). A build ships this sheet as `harness.md` in the skill's folder; the procedure bodies cite its sections by heading and name no harness tool of their own. What follows was observed on Kimi Code 2.1.1.

## Spawn

Spawn members with this harness's own subagents. `AgentSwarm` starts a whole stage in one call; `Agent` starts one member.

- **One call per response.** Send the spawn call alone: the executor vetoes an `AgentSwarm` call that shares its response with any other tool call, and a second `AgentSwarm` in one response.
- **`prompt_template` and `items`.** Write the shared frame once in `prompt_template`, with `{{item}}` where one member's own task goes, and give `items` one entry per member. Each item is the whole of what that member sees — it cannot read your context — so carry its scope, the paths it owns (ending `Owns: <paths>`), and the exact shape of the answer you want back.
- **Cap.** One call takes up to 128 members and there is no concurrency cap unless an environment variable sets one; a stage wider than 128 runs as more than one wave, each its own call and its own records (`records.md`: a wave holds at most 128 members), never as a call the harness refuses.
- **The member id you record.** This harness numbers a session's members `agent-0`, `agent-1`, … . The call's `<agent_swarm_result>` block names them, and so does the session's `state.json` roster; record that id for the member (`records.md`).
- **Todo tool.** `TodoList` takes `{todos: [{title, status}]}` — this harness's todo tool, for a body that tracks its own stages or a member prompt that asks for one.
- **No nesting.** The default member profile (`coder`) carries no spawn tool, so a member cannot start a wave of its own; a stage is one call from you.

## Wait and resume

- `AgentSwarm` returns only when every member is final: its result is the `<agent_swarm_result>` block, one entry per member with that member's status and summary. Wait for that call, then write the records — a member that has not reported has not finished.
- Read every member's status before you treat the stage as done. A member can end `timed_out`, `max_tokens`, `max_steps`, `repeat_breaker`, `no_final_message` or `provider_error`, and its own summary says which; re-run the failed members (below) or record them as failed, never as done.
- Resume by id: `AgentSwarm` takes `resume_agent_ids` for the members to continue, and `Agent` takes `resume: "agent-<n>"` for one. A resumed member keeps its id, so what you record for it does not change.
- Write the records only after that call returns: what a member said is what its own result entry carries, never a rewrite of it.

## Member permissions

- A member inherits your permission mode and profile at spawn; nothing in a call can make a member more restricted than the lead that spawned it. What a member may do is what your session may do.
- Print mode (`kimi -p`) forces the session's permission mode to `auto` and zeroes the timeouts, so an unattended run asks nothing and blocks on nothing: a headless wave will not fail closed for you. Bound it yourself, with the paths you hand each member and an ownership check after the wave.
- The wave grants nothing on a member's behalf. A tool a member needs (a shell command, a write outside its own paths) belongs in your own config's rules before the wave starts, or in the member profile the call names — not in the member prompt.
- Members write their own files; you check ownership afterwards rather than approving each write.

## Models

- **Where the list is.** This harness's models are the aliases its own config names — `config.toml` under `KIMI_CODE_HOME`, and `[secondary_model] default_model` when a subagent pool is configured. The session carries the same list from the moment it starts, so read it there: that is the list to put in front of the user when they choose the secondary model, never one from another harness and never one from memory.
- **How to name one.** By the config's alias, spelled exactly as the config spells it (the shape is `provider/model`, e.g. `deepseek/flash-1m`). A member's `model` parameter and the lens command's `-m` both take that alias; the run's own wire records the alias's resolved spelling beside it (`deepseek/flash-1m` runs and is recorded as `deepseek-flash[1m]`, `## Transcripts`), and that recorded spelling is what the gate compares, not the alias you asked for.
- A member's model: `AgentSwarm` and `Agent` take a `model` parameter, but it is offered only when a subagent model pool is configured (`[secondary_model]`). Without a pool every member runs on your model; the reserved name `primary` asks for your own alias explicitly.
- A lens's model: the headless command pins it — `-m, --model <alias>` (`kimi --help`, 2.1.1), as `## Lens command` runs it. Give each lens the alias it must run on: the secondary model for an adversarial lens, your own for the recon lens.
- The model a member or a lens actually ran on is recorded in that run's own wire (`## Transcripts`). Read it back there: the gate takes each adversarial lens's model from the transcript check's verdict, and fails the wave when both lenses name one model — a lens silently run on your own model is a failed lens, not a passing one. A lens whose wire records no model at all cannot prove the two differed, and the gate blocks the wave on it. Write `recon.json`'s `model` as the spelling the recon run's own main wire records (`## Transcripts`): the gate compares it with the spelling each adversarial lens's verdict carries, and the alias beside a resolved id would put one model under two spellings no check can tell apart.

## Lens command

Run each review lens as one headless process of its own (D-W4-5), from a fresh worktree of the frozen commit:

```sh
kimi -p '<the lens prompt>' -m <model> > lens.out
```

There is no read-only print mode: Kimi Code 2.1.1 refuses `--plan` beside `-p` ("Cannot combine --prompt with --plan"), and print mode runs in `auto`, so a lens run can write.

- **Both lenses.** The adversarial lens (the review lenses, `lenses/*.md`) runs on the secondary model; the recon lens runs on the model you are running on. Each gets its own worktree and its own run, and the shell captures its stdout, so you never author its words.
- **Ask for the schema.** No harness can force a subagent's, or a headless run's, output shape, so the prompt asks for it: the whole final message is the lens-schema JSON — `verdict`, `findings[]` (`severity`, `claim`, `cite`) and `not_covered` — and nothing else.
- **Read-only.** Nothing in this harness refuses a lens's write, so **the clean-tree check is this lens's only guard**, and the lens's own worktree keeps a stray write off the reviewed tree. Snapshot `git status --short` in the lens's worktree before it starts and fail that lens on any change after it — a lens that wrote anything is not a lens; its output is discarded and the lens re-run.
- **Record the run.** Note each lens run's session id (`## Transcripts`) as that lens member's id, with the model the verdict read back from its wire.

## Transcripts

This harness writes every agent of a session under
`<KIMI_CODE_HOME or ~/.kimi-code>/sessions/<workspace>/session_<uuid>/agents/<agentId>/wire.jsonl`:
a wave member's directory is its id (`agent-0`), the run's own agent is `main`.
`scripts/cli.ts transcripts` reads that home — `KIMI_CODE_HOME` from the environment, else `~/.kimi-code` — and the run's `wire.jsonl` is what it hashes.

- **A member.** Record the id the spawn tool gave it (`agent-<n>`) as the member's `agentId`, and the session you spawned it in as the member's `session` (`records.md`).
- **What you record is what the member said.** The result block's summary is the member's own final message; the check compares your `result` with the member's wire after trimming both, so a paraphrase fails the check rather than passing silently. When a long answer leaves the block showing only part of it, the member's own wire (`agents/<id>/wire.jsonl`) holds the whole message — record that.
- **Your own session id.** Every session numbers its members from `agent-0`, so an id alone is ambiguous and the `session` field is what resolves it. No Kimi variable reaches your shell (a skill body is the only place `${KIMI_SESSION_ID}` is substituted, and ktx's bodies are the same in every harness), so take it from this session's directory — the newest one, which nothing else writes while your wave runs:

  ```sh
  ls -dt "${KIMI_CODE_HOME:-$HOME/.kimi-code}"/sessions/*/session_*/ | head -1
  ```
  Its directory name, `session_<uuid>`, is the id to record for every member you spawn in this conversation.
- **A lens run.** A lens is a session of its own. List the session directories before the command and again after it, and record the one that is new as that lens member's `agentId`; its wire is that session's `agents/main/wire.jsonl`, and the model in it is the lens's model. Record no `session` for it: its own id is the session directory and already names one wire, while a `session` field holding your own session sends the locator to a member directory that run never wrote.
- Never edit a wire; the check re-reads it from the harness's own file.
- A member whose id resolves to no file, or to two, fails the check: the wave ran somewhere this machine's home does not show.

## Notify and background

- This harness tells you things through the terminal: the TUI's own bell (`[notifications]` in `tui.toml`, OSC 9 or BEL), and an automatic notice when a background command finishes. There is no tool that reaches the user when they are away, so the wave's report is the answer you print at the end of the turn — and a wave you stop says so in that answer.
- `AgentSwarm` is a foreground call: it returns when every member is final. Keep a wave that way. An `Agent` call takes `run_in_background: true`, which returns at once and leaves the member's completion to arrive as a notice — usable for a lone member, never for a stage whose records must wait.
- A long shell command runs in the background with `run_in_background: true` and `disable_timeout: true` (the background default is 600 s, capped at 86400 s); the child survives the turn, so a wave body that runs the transcript check inside its turn does not need the background.
