# Harness sheet — Codex

This harness's own steps for the swarm procedures (D-W4-4). A build ships this sheet as `harness.md` in the skill's folder; the procedure bodies cite its sections by heading and name no harness tool of their own. What follows was observed on Codex 0.159.0, which runs two collaboration backends with different tool names; where they differ, both are named and your own tool list decides.

## Spawn

One wave member is one `spawn_agent` call: `{task_name, message}` on the current backend, `{message, items, agent_type, fork_context}` on the older one. `task_name` is the short name you choose, and Codex answers with the member's `agent_path` — `one` becomes `/root/one` — which is the member id you record as `agentId` in `results.json` and `agent_id` in `registry.json` (the older backend answers with an agent id and a nickname). The call's answer is launch metadata, never the member's own message: that arrives when the member finishes.

The `message` is the item's text, which ends `Owns: <paths>`, the answer wanted, and, for a lens member, the whole lens schema. Codex has no output-shape parameter for a child, so a report shape is a request in that message and a checked claim, never something the harness enforces.

Start every member of a stage before waiting on any of them: they run in parallel. Codex bounds the threads one session runs at once — four including you on the current backend, six by default on the older one, and `[agents] max_concurrent_threads_per_session` raises it — and your own instructions state the slots you have ("There are N available concurrency slots"). Batch a stage wider than that cap, each batch started as the one before it reports. Depth is 1: a member has no collab tools of its own, so the wave is the unit. A member inherits your conversation up to the point you spawned it (`fork_turns`/`fork_context`), so brief it with what it must know, and pass `fork_turns: "none"` when it must start from the item text alone — a full-history fork also inherits your model and rejects an override.

Your todo tool is `update_plan {explanation?, plan: [{step, status}]}`, one step per member beside the wave's list of items. It is off by default in 0.159.0 (`[tools.update_plan] enabled = true` turns it on); when your tool list has no plan tool, keep the same list in your own messages instead.

## Wait and resume

Every member must have finished before you write `results.json`: that file holds each member's final message, and a member still running has neither a final message nor a complete rollout. `codex exec` shuts down every thread 10 seconds after the primary turn ends, so a lead that ends its turn while members are running kills their work.

Wait with `wait_agent` — the default timeout is 30 s, the minimum 10 s and the maximum one hour per call — and prefer long waits over busy polling: call it again until every member has reported, and hold the turn for as long as that takes. Where the members' words arrive differs: the older backend returns each one's completed message in the wait result, while the current one returns a mailbox summary and each member's final message reaches you as a fragment of your own conversation — `Message Type: FINAL_ANSWER`, `Sender: /root/one`, then `Payload:` and the member's text. Record that text, never the envelope around it.

Resume one member by the id it was spawned under: `followup_task` gives it a new task and starts a turn and `send_message` passes it a message without starting one (`send_input` and `resume_agent` on the older backend; `interrupt_agent` and `list_agents` show what is running). A member that needs a decision answers with the question as its final message instead of blocking.

## Member permissions

A member is never more restricted than the lead: Codex stamps the parent's sandbox and approval policy on every child last, so there is no read-only member role and no per-member permission mode to set. A wave that must write therefore runs under a lead whose own sandbox allows the write — in a headless run, the `--sandbox` the run was started with; `workspace-write` bounds writes to the cwd, `/tmp` and `$TMPDIR`, with no network. All agents share your working directory and filesystem, so a member's writes are visible to the others the moment they land.

A member's bound is its item: it edits only the paths its `Owns:` line names, and it never commits, pushes or touches another item's paths. The probes run a procedure in a throwaway git project under `workspace-write`, fenced by that sandbox alone: no `--add-dir`, which would widen it.

## Models

Name a member's model with the `spawn_agent` call's `model`; a lens's model is `-m <model>` on the headless command below. A full-history fork inherits the lead's model and rejects an override, so set the model together with `fork_turns: "none"` (or a positive integer) when a member must run on another one.

Nothing in a headless run lists the models an account reaches: the catalog is the account's own, the interactive `/model` picker shows it, and the user's config names the default. Record the model you asked for in `registry.json`; the transcript check records what the thread's own `turn_context` says it ran on, and the gate takes the review lenses' models from that verdict rather than from the registry.

Write `recon.json`'s `model` as the spelling the recon run's own rollout records (`## Transcripts`): its last `turn_context` model, which is what the transcript check's verdict carries. The gate compares that spelling with the spelling each adversarial lens's verdict carries, and an alias the run did not keep would put one model under two spellings no check can tell apart.

## Lens command

A review lens is one headless run, in a fresh worktree of the frozen commit, with its whole final message the lens-schema JSON and nothing else (the schema is in the lens's own file):

```
codex exec --sandbox read-only --json -m <model> "<the lens prompt>"
```

Two lenses per gate: the adversarial lens on the secondary model, the recon lens on the lead's model. The read-only sandbox is the harness's own fence, not the prompt's: asked to write a file with its patch tool and by a shell redirect, a read-only run was refused both and nothing landed.

The lens command needs the network to reach its model, and a Codex lead's own sandbox usually has none: started from a `workspace-write` session, `codex exec` fails with "workspace routing discovery failed". Run it with escalated permissions (ask the user to approve the command outside the sandbox), start the lead with network access in its sandbox (`-c sandbox_workspace_write.network_access=true`; with it a `workspace-write` lead's nested lens run completed and answered), or have the user run it from their own shell and hand you the output file. The lead also snapshots `git status --short` before each run and fails the lens on any change after it — that check is the guard a lens has to pass in every harness.

`--json` prints the run's events; its `thread.started` event carries the run's own thread id, which is the lens's `agent_id`, and the last assistant message is the lens's final message. Record the raw output: the gate reads the lens's verdict out of it. `codex exec` does not wait for children and exits 10 seconds after the turn ends, so the two lenses are two runs, never wave members.

## Transcripts

Codex writes one rollout per thread, at `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<stamp>-<thread_id>.jsonl`, where `$CODEX_HOME` defaults to `~/.codex`. A rollout's first line is its `session_meta`: the thread's own `id`, and for a child its `parent_thread_id` and its `agent_path`.

- A wave member: record the `agent_path` the spawn call answered with as `agentId` and `agent_id`, **and** record `session`. The session is the lead's own thread id, `CODEX_THREAD_ID` in the lead's shell. Member ids repeat across threads — every wave has a `/root/one` — so a member id with no `session` matches two transcripts and the check fails it as ambiguous.
- A lens run: record the run's own thread id from `thread.started` as the lens's `agent_id`, with its model, and no `session`.

`scripts/cli.ts transcripts <root> <wave-id>` finds these through the build's own locator, which reads the home from `CODEX_HOME`, and writes `transcripts.json`. Run it in the home the wave ran in: set `CODEX_HOME` for that shell when the wave did not use the default, and run it on the machine that ran the wave.

## Notify and background

Codex has no notification tool a model can call: the `notify` config key runs a command after each completed turn, with a fixed payload, so the only word that reaches an absent user is the lead's own turn ending. The lead's final message tells the user the wave is done; a member cannot notify anyone, and a member never speaks for the wave — the records and the report are the lead's.

A shell command does not need a background mode: Codex's `exec` tool returns when its own wait elapses and is polled again for what is still running, and the wave's members run on their own threads regardless. What the lead must not do is end the turn: `codex exec` shuts every thread down 10 seconds after the primary turn ends, so the lead holds the turn with `wait_agent` until the last member has reported.
