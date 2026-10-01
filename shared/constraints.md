# Swarm build constraints

The rules a swarm build runs under, read once per session. `swarm-build`'s body and its
`references/stages.md` cite them by number; `scripts/cli.ts` enforces 3, 4, 7 and 7a
mechanically, and the wave gate is where most of the rest surfaces.

1. **No ritual pauses.** Between stages 5 and 10 the lead asks nothing unless the stop rule (2)
   fires. A "dispatch now?" prompt carries no decision; the lead dispatches. Standing
   permissions — when to commit, push, open and merge PRs, and which live or costly actions
   still need a go — are settled once at stage 2 and recorded in `plans/BuildPlan.md`, never
   asked per wave.
2. **Stop / park rule.** A finding stops the build (the next dispatch is blocked; independent
   in-flight tracks may finish) when it changes a frozen contract (disposition PROMOTED),
   contradicts a `RATIFIED` decision, or crosses the wave's "Explicitly NOT in" line. Any other
   finding is parked: a ledger entry, only dependent tracks held, surfaced at the wave gate.
   The lead never classifies a finding as parkable when it names a frozen type or a ratified
   decision. Parking decides only whether to stop now: by the wave gate, a parked defect in code
   the wave ships is fixed or accepted as a documented deviation, and only missing scope — work
   handed to a later wave — stays parked (TigerStyle's zero technical debt).
3. **Red wave gate blocks the next dispatch.** No stage-7 dispatch of wave N+1 while any wave-N
   gate row is unobserved or red. "Lenses PASS" means the re-verdict ran and passed; a FAIL
   followed by fixes is not a PASS.
4. **Records gate the next wave.** Stage 4 of wave N+1 refuses until stage 11 of wave N has
   written the amendment-log entry, the model-split entry, a record line per dispatch, and a
   disposition per retro item.
5. **Ownership.** Every implementation item ends with `Owns:`; no path in two items. After each
   stage, `git status --short` in every granted directory is checked against the lists; a path
   outside them halts. Members never commit.
6. **Staged dispatch.** A build wave is a sequence of member waves ordered by the file-touch map
   in the wave file; not one call.
7. **Lenses on different models, on a frozen tree.** The adversarial lens runs on the secondary
   model, the recon lens on the lead's model. Both review a named commit; the lead makes no edit
   to the reviewed tree until both lenses report. Contracts and skeletons — their frozen seam
   assertions and the wave's performance sketch included — get one adversarial pass before the
   first dispatch against them. The TigerStyle pass and the swarm gate's stress pass run on the
   lead's model, never the pool.
7a. **Explicit dispatch records.** Every dispatch names its model explicitly, and lenses and
   probes are read-only runs unless the brief requires running commands. Members' models reach
   the records from the transcript verdict, never from the brief.
8. **Evidence.** Every gate row, amendment entry and disposition carries the exact command and
   its observed output. A gate line (e.g. "lint clean") is re-checked against its output before
   it is committed.
9. **Member reach.** Implementation waves dispatch with the member permissions the user named at
   calibration, recorded in the decision ledger, bounded by what `harness.md § Member permissions`
   refuses. Pre-flight (stage 0) checks that the bounds in force cover the wave plan's no-go
   commands — anything members must never run: pushes, publishes, device or remote-host
   commands, the project's own external-state tools — and that no gate command members must run
   is refused; either miss halts pre-flight with the command named.
10. **Live-touch boundary.** Members bind local/loopback only; live legs and anything touching
    devices, relays, releases or shared infrastructure are lead- or user-run. Rows that cost
    money need the user's go.
11. **Session resets.** At every wave boundary the lead writes the carry into the plan files —
    the wave file's § 11 and the plan's amendment log — sized so a fresh session resumes at the
    next stage from the plan files alone.
12. **Halt conditions** (in addition to 2–4): pre-flight FAIL; tests red after integration; a
    denial whose override the lead cannot self-authorize; stuck signals; an exit other than 0 or
    1 from `scripts/cli.ts`; a member's `Owns:` violation; CI `terminal=true AND
    all_success=false`; a finding still open after the second fix round (a stop — the brief or
    the contract is wrong).
