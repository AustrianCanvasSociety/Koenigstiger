# Stages

Each stage the finder names, what to do there, and what it writes. The rules behind every one
of them are in `constraints.md`; the plan sections they fill are in `plan-template.md` beside
this file.

## Pre-flight, once per session (stage 0)

Emit one `PREFLIGHT: <check> ok|FAIL <detail>` line each; any FAIL halts:

- tree clean: `git -C <project-root> status --short` empty
- the models you will dispatch on are the ones `harness.md § Models` lists, and every gate
  row's command resolves (`command -v <binary>`)
- member bounds (constraint 9): what `harness.md § Member permissions` grants the members
  covers the plan's no-go commands, and refuses no gate command a member must run
- free disk for probe and build scratch

## The stages

| # | Stage | Do | Written |
|---|---|---|---|
| 1 | Recon swarm | Copy `plan-template.md` to `plans/BuildPlan.md` if absent. One read-only wave (`harness.md § Spawn`): pinned versions / APIs / reference invariants / long-lead externalities / baseline performance figures (external latency and bandwidth, data sizes, target disk and network) | `docs/pins.md` + digest |
| 2 | Calibration | `interview.md` — one question at a time, options + pros/cons + a recommendation. Settle the standing permissions here, never per wave, the secondary model among them: ask it with the `harness.md § Models` list shown, never pick it yourself. Ask about the implementation waves' member permissions the same way (`harness.md § Member permissions`) and record the answer in the decision ledger — a harness can refuse a launch the user did not name. Ask only what bears on the user's own calls; a question the user hands back is recorded `ADOPTED (delegated)` with your lean, reopenable at the milestone gate | `### Decision ledger` entries; `### Standing permissions` filled |
| 3 | Milestone plan | Order waves (template § 3); milestone stop-and-evaluate criteria | `### Wave list` rows; `### Milestones` |
| 4 | Probes | One wave of read-only members — write members under a read-only brief when probes must run code — each brief asking for the report shape the wave will cite, against a named commit; instruct them to falsify the brief, and to measure the figures the wave's performance sketch will cite. Re-run yourself any probe claim a decision will cite, and paste the command and output | `plans/W<N>-invariants.md`, raw in `plans/w<N>-probe/` |
| 5 | Decisions | Posture calls to the user, one at a time; the rest `ADOPTED` by you | `D-W<N>-k` in `plans/W<N>.md` § 4 |
| 6 | Wave plan + skeletons | `plans/W<N>.md` §§ 1–9 with every gate row `PENDING`; a file-touch map whose every stage has ≥ 2 tracks (split a lone track along a real seam, or make it lead work — template § 8); skeleton commits carrying the frozen seam assertions, paired across tracks (template § 3); § 6 opens with the performance sketch, figures cited to pins or probes, or `no hot path — <why>`; one adversarial pass on contracts, assertions, sketch and skeletons before the first dispatch | wave file, skeleton commits |
| 7 | Staged dispatch | One wave per stage of the file-touch map: items each ending `Owns: <paths>`, write members, the model the decision ledger records, spawned per `harness.md § Spawn` and awaited per `harness.md § Wait and resume`; the records per `records.md`. After each wave: the ownership check, then your commit | per-stage commit |
| 8 | Review | Freeze a commit. Adversarial lens: a wave of ≥ 2 members split by seam — one member is not a wave — each run per `harness.md § Lens command` and told its whole final message is the template § 9 lens schema, with one gate row per member. The same pass applies to the contract lens before stage 7. Recon lens: the body's own Recon lens section. On a project whose gate is the swarm gate, run the TigerStyle lens yourself over the same frozen diff meanwhile; its findings join the fix round. No edit to the tree until both lenses report | findings + dispositions (template § 9) |
| 9 | Fix + re-verdict | Resume the implementers (`harness.md § Wait and resume`), then resume the member that raised the finding; point the adversarial gate row at the re-verdict member. At most two rounds: a finding still open after the second re-verdict is a stop (template § 9) | re-verdict in § 9 |
| 10 | Wave gate | When the plan declares `- Wave gate: /swarm-gate` (a swarm-only project), run the seven `swarm-gate: <item>` rows — the review lenses in `lenses/`, `scripts/tests-catalog-check.sh`, and your own `tests`, `stress` and `scope` rows — pre-staged at stage 6. Run every pre-staged row; fill `observed` + `state`. Open and merge the wave's one PR per the standing permissions, with the project's own tooling; its CI result is a row. Then the gate, as the body's Gate section describes | § 9 filled |
| 11 | Records | Amendment-log entry (`plans/BuildPlan.md` § 15), `docs/model-split.md` entry, a `Driver record:` line per dispatch (wave id, members × the model the transcript verdict recorded, permission mode, denials), each retro item `FOLDED` or `LEAD-PRACTICE`. Run `bun scripts/cli.ts transcripts <project-root> <wave-id>` on the machine that ran the wave and commit the verdict it writes with the wave's records — its `TRANSCRIPTS:` line is the record that each member's answer is its own. Then the gate again, then the carry into the plan files | records |
| 12 | Milestone gate | The swarm gate's milestone mode, where the plan declares it. With the user: live matrix, walkthrough, model-split verdict. You report evidence; the user calls it | — |

**Every dispatch's `description` starts with `W<N> `** (`W3 stage B — adapters`, `W3
adversarial lens`, `W3 re-verdict`); recon (stage 1) takes `recon`. The gate finds the wave's
dispatches by that prefix and refuses a wave with an unrecorded one.
