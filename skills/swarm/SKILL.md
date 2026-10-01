---
name: swarm
description: Run one wave of parallel members through this harness's own subagents — split a task into independent scopes, each owning its files, spawn them, check ownership, and record the wave so a gate can verify it. A procedure the user starts by name.
---

# swarm

Run one wave: split the task into independent scopes, run one member per scope in parallel as this harness's own subagents, then check what they changed and record the wave so a gate can verify it. The argument is the task, in prose; the project root is the top of the current git checkout.

Everything this harness does its own way — start, wait, permissions, models, transcripts — is in `harness.md`, the sheet beside this file; this body cites that sheet rather than naming one harness's tool, so the same words work in every build.

## Steps

1. **Explore before composing.** Read enough to partition the work. A bad partition is paid for once per member, and members open more files than the brief names.

2. **Compose the items.** One item per member, each a distinct scope, with no two members given conflicting work. When members change files, end every item with `Owns: <paths>` — the files that member may change — and put no path in two items. Members that only read, inspect or report need no `Owns:`.

   **Models.** Optionally name what each item runs on; `harness.md § Models` lists the names this harness accepts and marks its default.

3. **Spawn them.** Start the whole stage together, per `harness.md § Spawn` — that section names this harness's spawn tool, the member type to pass and how many members run at once. A stage wider than that cap runs in batches, never as a refused spawn. Then hold until **every** member has reported, per `harness.md § Wait and resume`; the wave is not half-done when half the members answer.

   Decide permissions before spawning — nobody can approve a member's tool call mid-wave — per `harness.md § Member permissions`.

   **Spawn responses.** A response that spawns makes no other tool call beside that stage's spawn calls — anything else you would do now was chosen before the members' answers existed. How many spawn calls one response holds is `harness.md § Spawn`'s to say. If the run outlives the turn, `harness.md § Notify and background` says how to reach the user and how to keep it going.

4. **Check ownership.** Run `git status --short` in the project and in every directory the members were granted. Every changed path must be in the `Owns:` list of the member that reported changing it. Anything else: stop and report it before committing. The lead commits the wave once; members never commit.

5. **Write the records.** Under `<project-root>/.claude/swarm/<wave-id>/` — `<wave-id>` is one path segment, no `/` — write `input.json`, `results.json` and `registry.json` exactly as `records.md` specifies. Each member's `result` is that member's own final message, copied verbatim; never a summary you composed from it.

6. **Run the transcript check** from this skill's folder:

   ```bash
   bun scripts/cli.ts transcripts <project-root> <wave-id>
   ```

   It finds each member's transcript the way `harness.md § Transcripts` describes, writes `transcripts.json` beside the records, and prints one line of the shape

   ```
   TRANSCRIPTS: wave=<wave-id> result=<pass|fail> members=<n>
   ```

   with the real wave id and result filled in. Exit 0 is a pass; exit 1 prints one `TRANSCRIPTS: member=<agentId> ok=false detail=<why>` line per failing member. A failure means the harness's own transcript does not agree with the record you wrote — fix the record, not the check.

7. **Report.** Say what each member returned, in substance, and which files changed. A long member answer belongs in the records, not in the reply. **End the report with the transcript check's `TRANSCRIPTS:` line, copied verbatim from its output — retype nothing, paraphrase nothing: that line is the wave's evidence.**

A throwaway probe wave — the argument reads `W0 probe` — runs the same way: take the items, and the answer each member must return, from the argument itself. It owns no files, so step 4 has nothing to check, but steps 5 and 6 still run: the records and the transcript check are exactly what such a probe reads back.

## Swarm Mode

You are now in "agent swarm" mode. The user may send tasks that require a large number of parallel subagents.

## Workflow

You do not need to use your todo tool to record this workflow.

1. First, you may need to do a small amount of exploratory work before deciding how to divide the task across subagents. You may not need subagents during this exploratory phase.

2. After exploring, if you are convinced no subagent is needed to complete the task, tell the user why and wait for further instructions; otherwise, continue with the appropriate delegation.

3. Once you have enough context, do not handle the main work yourself. Use your spawn tool to run one member per item — `harness.md § Spawn` names the call and the arguments it takes — partitioning the problem so each item gives one subagent a distinct part of the work. Pass the same member type to every item when the whole wave should use a non-default one.

## Coordination

- Give each subagent a distinct scope of work.
- Avoid duplicating work across subagents.
- Avoid assigning conflicting changes or responsibilities to different subagents.
- Remember that subagents have your full capabilities. Do not overload their prompts with excessive detail; only describe the necessary background and each subagent's specific task.
- Unless the user explicitly specifies a lower limit, do not try to conserve the number of agents. `harness.md § Spawn` states how many this harness runs at once; decompose work as finely as that allows while keeping subagent responsibilities non-conflicting, and combine tasks only when they are genuinely inseparable. If the subagents only need to read, inspect, or report back without making changes, their scopes may overlap slightly.

## Swarm Mode Ended

Swarm Mode has ended. You are no longer required to follow the Swarm Mode workflow.

The user's next request is likely to be a regular request that does not need a wave. If the request still benefits from parallel subagents, you may spawn them, but decide from the new request itself rather than the ended Swarm Mode workflow.

## Halt conditions

- **Members would mutate overlapping files** — re-partition before spawning. Nothing serializes writes between members.
- **A member fails, is refused or returns nothing** — name it and say what it covered; never report the wave as complete without it.
- **A spawn is refused** — this harness runs a bounded number of members at once (`harness.md § Spawn`); run the stage in batches rather than retrying the refused call.
- **A changed path is in no `Owns:` list** — stop, name the path and the member, and commit nothing.
- **The transcript check fails** — the records and the harness's own transcripts disagree. Report which member and why; never edit a transcript, and never hand-write `transcripts.json`.

## Rules

- **The records are yours; the transcripts are the harness's.** Write `results.json` from what the members returned. The check exists to catch a record that has drifted from the member's own final message — run it every wave, including a throwaway one.
- **One wave at a time in a project.** Start no second wave before the first one's records and check are done.
- **The wave's four record files are committed with it** — `input.json`, `results.json`, `registry.json`, `transcripts.json`; the rest of the wave directory stays local. A gate on another machine reads the committed four.
- **Do not start this procedure from inside a member.** Members do the wave's work, not waves of their own: a wave of one is not a wave.
