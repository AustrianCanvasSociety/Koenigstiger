# Harness sheet — Claude Code

This harness's own steps for the swarm procedures (D-W4-4). A build ships this sheet as `harness.md` in the skill's folder; the procedure bodies cite its sections by heading and name no harness tool of their own. What follows was observed on Claude Code 2.1.285.

## Spawn

One wave member is one `Agent` tool call; older streams have called the same tool `Task`. Subagents run in the background by default, so calls in one message — and in separate messages — overlap: a stage of N items is N calls, not a queue. Members do not fan out further; the wave is the unit.

The cap is 20 concurrent subagents (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`, default 20). The 21st call fails with "Do not retry" — it does not queue — so a stage wider than 20 runs in batches of at most 20, each batch started after the one before it has finished. Subagents nest to depth 3; a member never needs to spawn.

Each call carries the item's text (which ends `Owns: <paths>`), the answer wanted, and, for a lens member, the whole lens schema. The `Agent` tool has no output-shape parameter — the top-level `--json-schema` is print-mode only, and a subagent can never run a Workflow — so a report shape is a request in the prompt and a checked claim, never something the harness enforces.

The member type every call passes is `general-purpose`: the built-in whose result carries an agent id (the two calls of the spawn spike, 2026-09-30, passed `subagent_type: "general-purpose"` and each answered `agentId: <17 hex>`). The read-only `Explore` and `Plan` subagents return no id, so they cannot be members: without an id there is no `agentId` for `results.json`, no `agent-<id>.jsonl` for the transcript check to find, and nothing for `SendMessage` to resume.

A call's own result is launch metadata, not the member's answer. It carries the member's id (`agentId: <17 hex>`), which is what you record as `agentId` in `results.json` and `agent_id` in `registry.json`; the answer itself arrives later, with the member's completion notice.

Your todo tool is `TodoWrite`: one entry per member, beside the wave's list of items.

## Wait and resume

Every member must have finished before you write `results.json`: that file holds each member's final message, and a member still running has none. A background subagent's completion arrives as a task notification naming its id; a run that ends before a member reports must not record that member as completed.

Resume one member by id with the `SendMessage` tool (`to: '<agentId>'`), which continues the same subagent with its own context. The read-only `Explore` and `Plan` subagents return no id, so they cannot be resumed.

## Member permissions

Members run under the lead's own session: the same tool set, the same permission mode. A plugin agent file cannot change that — its `permissionMode` applies only when the main session is in `default`, `dontAsk` or `plan`, and `bypassPermissions` there is downgraded to the session's mode — and a wave ships no agent files anyway. A member that writes needs the session to allow the write, which in a headless run means the mode and flags the run was started with.

The harness refuses a subagent `AskUserQuestion`, `Workflow`, and any spawn past depth 3; a background subagent also loses `PushNotification`. Nobody can approve a member's tool call mid-wave, so the mode and the bounds are settled before the spawn. Every member's bound is its item: it edits only the paths its `Owns:` line names, and it never commits, pushes or touches another item's paths.

The probe runs a procedure with `bypassPermissions` inside a throwaway project, fenced by a sandbox and a write guard: nothing is asked, and the fence is the bound.

## Models

The names an `Agent` call's `model` parameter accepts, and that `--model` takes on the headless command below:

- omitted — the default: the member runs on the lead's own model;
- an alias this harness knows: `haiku`, `sonnet` or `opus`;
- a full model id, such as `claude-haiku-4-5-20251001` (the resolved name is the one a transcript records).

The pool behind those names is the account's own, and nothing in a headless run lists it. An alias can be silently replaced by the session's own model, so take a member's model from its transcript (`message.model` on its assistant lines, as the transcript check records it) rather than from what was asked for. `CLAUDE_CODE_SUBAGENT_MODEL` sets a default for subagents, and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` makes that default reach `Explore` too.

Write `recon.json`'s `model` as the spelling the recon run's own transcript records (`## Transcripts`): its `message.model` on the assistant lines, which is what the transcript check's verdict carries. The gate compares that spelling with the spelling each adversarial lens's verdict carries, and an alias the run did not keep would put one model under two spellings no check can tell apart.

## Lens command

A review lens is one headless run, in a fresh worktree of the frozen commit, with its whole final message the lens-schema JSON and nothing else (the schema is in the lens's own file):

```
claude -p --permission-mode plan --output-format json --model <model> "<the lens prompt>"
```

Two lenses per gate: the adversarial lens on the secondary model, the recon lens on the lead's model. `--permission-mode plan` keeps the run from editing: asked to write a file and to run a shell redirect, a plan-mode run declined both and nothing landed. It declined before calling a tool, though, so the harness's own refusal of an attempted write has not been seen; the guard the lead relies on is a `git status --short` snapshot before each run, failing the lens on any change after it. `--output-format json` prints one JSON object when the run ends: its `result` field is that final message and its `session_id` is the id to record for the lens. Keep the raw output; the gate reads the lens's verdict out of it.

## Transcripts

Claude Code writes transcripts under `$CLAUDE_CONFIG_DIR` when it is set, else `~/.claude`, in `projects/<encoded cwd>/`:

- a wave member: `<session>/subagents/agent-<id>.jsonl`, where `<id>` is the `agentId` its `Agent` call reported. Record that id in `results.json` and `registry.json`, and record no `session`: Claude's subagent ids are unique across sessions, and a lead started by a probe may see an inherited `CLAUDE_CODE_SESSION_ID` that names the caller's session, not its own.
- a lens run: `<id>.jsonl` at the project level, `<id>` being the run's own `session_id`; record it as the lens's `agent_id`, with its model.

A member's final message is what reached you. In an interactive session Claude Code tells each subagent to answer through one `SubagentHandback({message})` call, which ends its run, and delivers only that message: the transcript then ends on that `tool_use` with no text block, and the locator reads the message of the last such call. A member that makes no handback — a headless lead's, so far — answers with its last text, as before. Record that message in `result` either way.

`scripts/cli.ts transcripts <root> <wave-id>` reads these through the build's own locator and writes `transcripts.json`. Run it on the machine that ran the wave: it is that machine's harness home that holds the transcripts.

## Notify and background

The lead's own final message tells the user the wave is done. A background subagent has no `PushNotification` tool, so a member cannot notify anyone: a member's completion reaches the lead as a task notification, and only the lead speaks to the user.

Members keep running in the background while the lead's turn continues. In a headless `claude -p` run the harness waits up to 10 minutes idle for background subagents, so a wave whose members outlast that window belongs in an interactive session, where the notification arrives whenever it arrives. A probe's two-member wave finishes in seconds.
