---
name: swarm-build
description: Drive a multi-wave build from a project's plans/BuildPlan.md — a recon swarm, a calibration interview, then per wave probes, decisions, staged dispatch through this harness's own subagents, two review lenses, fixes, a mechanical wave gate and records. It resumes at the first stage whose output is missing on disk. With --stage it reports where the build is and stops. A procedure the user starts by name.
---

# swarm-build

Conduct a swarm build: the sequence of waves — each one the `swarm` procedure's steps, run by
you — and the gate between them. The rules every stage runs under are in `constraints.md`;
this harness's own steps are in `harness.md`, cited below by section. A project's plan of record is a copy of
`references/plan-template.md`; the calibration interview is `references/interview.md`; each
stage's own steps and what it writes are in `references/stages.md`.

## Usage

`swarm-build <project-root> [--wave W<N>] [--stage]`

- `<project-root>` — absolute path, resolved before invoking (`git -C <dir> rev-parse
  --show-toplevel`). Never left to the current directory: the plan files, the wave's records
  under `.claude/swarm/` and every member's working directory are anchored on it.
- `--wave W<N>` — re-enter a wave the stage finder has already passed (a reopened gate, a
  milestone-gate finding). Say why in the wave file's § 11 when you use it.
- `--stage` — report where the build is and stop, without working it.

## Find the stage

From this skill's folder:

```bash
bun scripts/cli.ts stage <project-root>
```

Emit the `STAGE: wave=<W> next=<n> name=<name> why=<…>` line verbatim, then work that stage.
It reads only disk and writes nothing: `docs/pins.md` (1), `### Standing permissions` with no
unfilled slot (2), `### Wave list` rows plus `### Milestones` criteria (3), then per listed
wave `plans/W<N>-invariants.md` (4), `plans/W<N>.md` (5), its § 9 gate rows (6), the gate
checks (7–10), the records checks (11), and the milestone gate (12) once every listed wave of
a milestone is complete and the amendment log has no `M<k> closed:` entry. Stages 7–10 are one
span on disk — read the wave file's §§ 7–11 to see which of dispatch, review, fix or gate is
next. After a session reset, this line is where the new session starts.

### `--stage`: report and stop

Resolve the root the way Usage says and say aloud which way you got it — the argument, or
`git rev-parse --show-toplevel` of the current directory. Run the finder, then make your whole
answer that one line, verbatim:

```
STAGE: wave=<W> next=<n> name=<name> why=<…>
```

Then stop: read no plan file, spawn nothing, edit nothing. Every other run of this procedure
opens with the same line from the same finder, so the two can never disagree.

## Work the stage

One stage at a time, top to bottom: `references/stages.md` holds each stage's steps and what it
writes. Re-run the finder after each stage rather than tracking the number yourself — it reads
the disk, and the disk is the state. A stage's members are one wave of this harness's own
subagents (`harness.md § Spawn`), and the wave's records are what the gate reads.

## Recon lens

Runs on your own model, as one read-only run of the lens command beside the adversarial lens,
so the two cannot share a model and neither reviews a tree you are editing.

1. `git -C <project-root> worktree add <scratchpad>/w<N>-recon <frozen-sha>` — the fresh tree
   it re-runs commands on.
2. Run the recon lens command from `harness.md § Lens command` in that tree, with your own
   model named on it: re-run the wave's headline commands, verify each citation against its
   primary source, and make the whole final message the lens schema JSON of the template § 9.
3. Save that JSON to `plans/w<N>-lens/recon.json` with `"model": "<the model it ran on>"`, and
   point the recon gate row at that path. Remove the worktree after.

## Gate

```bash
bun scripts/cli.ts gate <project-root> W<N>
```

Emit every `GATE:` line verbatim. Exit 0 with `result=complete` is the only "wave complete";
exit 1 names each blocking check — fix that check and re-run; never advance to wave N+1's
probes (stage 4) or dispatch (stage 7) past a blocked gate (constraints 3, 4). What it holds
you to:

- a lens row's `PASS` counts only when the wave's recorded answer for the cited member says
  `PASS` — a FAIL followed by fixes is not a PASS until a re-verdict says so;
- that answer is the member's own: run
  `bun scripts/cli.ts transcripts <project-root> <wave-id>` on the machine that ran the wave,
  as `harness.md § Transcripts` says, and the gate reads the committed verdict it writes,
  confirming `results.json` still hashes to the one that check read. Committed with the wave,
  the verdict lets a gate on another machine check for later edits, though it cannot re-run the
  check itself;
- no adversarial member ran on the recon lens's model;
- every `not_covered` item a lens reported has a `Not covered:` line;
- the records exist for this wave.

A gate assesses; it does not pass. Its `complete` is a precondition for the next wave, not the
milestone verdict — that stays the user's (stage 12).

## Stop, park, notify

Mid-wave findings follow constraint 2: **stop** (block the next dispatch; independent in-flight
tracks may finish) when a finding changes a frozen contract, contradicts a `RATIFIED` decision,
or crosses the wave's "Explicitly NOT in" line; otherwise **park** it in the ledger and surface
it at the gate. Never classify a finding that names a frozen type or a ratified decision as
parkable. Between stages 5 and 10 ask nothing else (constraint 1).

When the user is away, tell them as `harness.md § Notify and background` describes: `wave <N>
gate complete — <sha>`, `STOP — <finding>; <decision needed>`, `HALT — <reason>; <next
action>`, `milestone <M> gate ready — <rows>`.

## Halt conditions

Constraint 12: pre-flight FAIL; tests red after integration; a denial you cannot self-authorize
(`harness.md § Member permissions`); a stuck signal; a changed path outside every `Owns:` list;
CI `terminal=true` with `all_success=false`; a finding still open after the second fix round;
an exit from `scripts/cli.ts` that is neither 0 nor 1 — exit 2 is a usage error, so surface its
stderr verbatim.

## Rules

- **Plan files carry the build, not the conversation.** Anything a fresh session needs goes
  into `plans/`; the carry at each wave boundary points at them.
- **Never write a lens row `PASS` by hand** without citing the member (adversarial) or the
  saved report (recon) whose answer is PASS.
- **Name the model on every dispatch**, per `harness.md § Models`, and take the models the
  records carry from the transcript verdict, never from the brief (constraint 7a).
- **Members never commit, push or touch live state**; you commit per the standing permissions
  (constraints 5, 10).
- **A ratified decision that widens scope is written down where the work is tracked** — the new
  paths go into the file list of the step that owns them, in the same commit as the decision. A
  decision you `ADOPTED` never widens it. The build's own records (`plans/BuildPlan.md`, wave
  files, probe and lens dumps, pins, model split) are never listed: they are the build's
  machinery, not its product.

The finder and the gate are two plain `bun` scripts in this skill's folder, `scripts/cli.ts`
and `scripts/gate.ts`: they read disk and write nothing.
