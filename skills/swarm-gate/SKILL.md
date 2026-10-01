---
name: swarm-gate
description: Gate a swarm build — per wave or per milestone — with tests, the tests catalog, review lenses, stress, scope, records and the user's acceptance, reading the wave's records and transcript verdict. A procedure the user starts by name.
---

# swarm-gate

Gate a swarm build that has no phase plan — the quality half of the `swarm-build` procedure's stage 10, and its stage 12 checklist. The mechanical gate stays the wave's verdict of record: this procedure produces the rows it reads.

Run the `bun` commands below from this skill's folder, and resolve `<project-root>` before starting (`git -C <dir> rev-parse --show-toplevel`). `<skill-dir>` below is this skill's own folder; the catalog check runs from the project root.

## Usage

- `swarm-gate wave W<N> <project-root>` — at stage 10, after the lenses' re-verdict.
- `swarm-gate milestone M<k> <project-root>` — at stage 12, once the stage finder reports every listed wave of the milestone complete. Item 9's `M<k> closed:` entry is what releases the next milestone's waves.

**When it applies.** The plan declares it in `### Standing permissions` with the line `- Wave gate: /swarm-gate`. From then on the gate refuses a wave (`check=swarm-gate-rows state=missing`) until its § 9 carries one row per item below. A project with its own phase gates keeps that line out of its plan: those gates cover the same ground and add the completion checks this procedure leaves out.

## Wave mode

**Pre-stage (stage 6).** Add these seven rows to `plans/W<N>.md` § 9 with state `PENDING`, command and expected filled in. The row names are exact — the gate matches `swarm-gate: <item>`:

| row | command | expected |
|---|---|---|
| `swarm-gate: tests` | the wave's full test command set, from the tree at the frozen commit | every suite green, counts named |
| `swarm-gate: TESTS.md` | `bash <skill-dir>/scripts/tests-catalog-check.sh --since <wave base> --until HEAD` from the project root | exit 0; `not-updated` rows answered |
| `swarm-gate: tigerstyle` | the tigerstyle lens (`lenses/tigerstyle.md`) through `harness.md § Lens command`, over `git diff <wave base>..<frozen commit>` at stage 8, then over the fix commits | no open finding |
| `swarm-gate: security` | the security lens (`lenses/security.md`) through `harness.md § Lens command`, over the same diff | no open finding |
| `swarm-gate: simplify` | the simplify lens (`lenses/simplify.md`) through `harness.md § Lens command`, over the wave's changed files | no open finding |
| `swarm-gate: stress` | the stress lens (`lenses/stress.md`) through `harness.md § Lens command`, on the lead's own model; the lead adds the inputs it reports as tests | per new handler or parser, tests in three classes (valid, invalid, valid turning invalid) plus one at and one past every declared limit; all green |
| `swarm-gate: scope` | `git diff --name-only <wave base>..HEAD` against the wave's `Owns:` lists plus the lead's plan, docs and TESTS.md files, and the manifest and lockfile diff | no path outside them; no dependency added without a `D-W<N>-k` decision saying why the code can't live in-tree |

`<wave base>` is the commit in the wave file's § 1. Write a pipe inside a table cell as `\|` — the gate reads it as a literal pipe, while a bare `|` starts a new column; a long pipeline still reads better as a named script.

**TigerStyle (stage 8).** While the lenses run, run the tigerstyle lens yourself over the frozen diff, on your own model. Its findings go into stage 9's fix round beside the lenses'. At stage 10, re-run it over the fix commits only and fill the row.

**Run (stage 10).** On the frozen commit, after both lenses report and any fix round has its re-verdict:

1. Run each row's command. Paste the observed result into the row — counts, exit code, finding tally — and set `OBSERVED`, or `RED` when it misses its expectation. Never write `OBSERVED` for a row whose command did not run this session.
2. **Review rows** (tigerstyle, security, simplify, stress): every finding gets a disposition in the wave file § 11 — `FIXED <sha>`, `PARKED <ledger id>` (missing scope only — work the wave does not ship, handed to a later wave; a defect in code the wave ships is `FIXED` or `REJECTED`, never parked), or `REJECTED <reason>`. The row's observed cell carries the tally, e.g. `4 findings: 3 FIXED, 1 PARKED D-W2-3; 0 open`. An open finding makes the row `RED`. A fix changes code, so the tests row re-runs after it. The stress row's observed cell counts per class, e.g. `valid 6 · invalid 9 · edge 5 · limits 4/4`; a zero in any class for a new handler is `RED` unless the cell says why that class does not apply. `.claude/no-tigerstyle` at the project root opts out of the tigerstyle and simplify rows project-wide; say so in the observed cell.
3. **Buglog and lessons** go to § 11 as retro items, dispositioned `FOLDED` or `LEAD-PRACTICE` there (the records check reads them): every hook denial or system reminder that fired twice or more this wave, every same-correction-twice, every non-obvious finding. Surface the repeat patterns in the session transcript named by `harness.md § Transcripts`.
4. **The transcript verdict.** Run `bun scripts/cli.ts transcripts <project-root> <wave-id>` from this skill's folder, with each member's id and session recorded as `harness.md § Transcripts` says. It writes `.claude/swarm/<wave-id>/transcripts.json`, which the gate's `transcript-verdict` check reads, and prints a `TRANSCRIPTS:` line. Run it on the machine that ran the wave: the transcripts live in that machine's harness home. Another machine reads the committed verdict and checks only that `results.json` still hashes as recorded.
5. **The gate.** Run `bun scripts/cli.ts gate <project-root> W<N>` and emit its `GATE:` lines verbatim. `result=complete` is the only complete wave.

## Milestone mode

Run once the stage finder reports `next=12`. Emit one line per item, `SWARM-GATE: milestone=M<k> item=<id> state=ok|missing|red detail=<…>`; any state other than `ok` holds the milestone.

1. **`waves`** — `scripts/cli.ts stage <project-root>` reports stage 12, and `scripts/cli.ts gate <project-root> <wave>` reports `result=complete` for every wave the milestone lists.
2. **`tests`** — the whole project's test surface, green, from a clean checkout of the main branch after the last wave's merge, plus the project's own CI command green on that commit.
3. **`catalog`** — `bash <skill-dir>/scripts/tests-catalog-check.sh --since <milestone base> --until HEAD` from the project root: every test the milestone added is in `TESTS.md`.
4. **`criteria`** — each stop-and-evaluate criterion in the plan's `### Milestones` entry gets an evidence row: the command, the observed output, and for live legs the artifact identity at both ends. When `.claude/proj-kickoff-notes.md` has `## Claim:` blocks, run each probe and report its delta from the kickoff baseline.
5. **`walkthrough`** — the user drives or watches each user-facing surface the milestone shipped; a screenshot or transcript is the evidence.
6. **`buglog`** / **`lessons`** — surface buglog entries idle across the milestone for removal, and review the lessons this milestone added.
7. **`model-split`** — the milestone verdict written in `docs/model-split.md`.
8. **`acceptance`** — the user's explicit acceptance, quoted. The lead never fills this item.
9. **`record`** — an amendment-log entry `- **<date> — M<k> closed:** …` in `plans/BuildPlan.md`.

## Rules

- **A gate assesses; it does not pass.** Rows carry observed output; the milestone verdict is the user's (item 8).
- **One observation per row, this session.** A row copied from an earlier run, or filled from memory, is a fabrication.
- **No step or phase checks.** A swarm-only project has no step or phase plan files to scope against, and no master plan to update.
