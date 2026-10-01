# Swarm Build Plan — template

Status: **portable template.** Copy into a project as `plans/BuildPlan.md`, fill the slots
(Appendix B), and the copy becomes that project's plan of record. The rules that drive it are
in `constraints.md`; this harness's own steps — spawn, waiting, member permissions, models, the
lens commands, transcripts, notification — are in `harness.md` beside this file.

---

## 0. How to use this template

Two layers — keep them apart:

- **Invariant core** (§§ 1–13): the build loop, the user's place in it, wave mechanics,
  review, gates, evidence, records. Change these only deliberately, and log the change in
  § 15 of the project copy.
- **Project slots** (`<PROJECT>`, seams, hot files, test/lint commands, live matrix,
  milestones): filled per project with Appendix B.

One plan file per project (`plans/BuildPlan.md`: strategy, standing principles, decision
ledger, amendment log) plus one file per wave (`plans/W<N>.md`), written before dispatch and
amended in place as results land. File layout: Appendix A.

---

## 1. The build loop

```
Recon swarm ──▶ Calibration interview ──▶ Milestone plan
                                              │
      ┌───────────────────────────────────────┘
      ▼
  per wave:  Probes ─▶ Decisions ─▶ Wave plan ─▶ Skeletons ─▶ Staged dispatch
                                                                  │
             Records ◀─ Retro fold-in ◀─ Wave gate ◀─ Fix + re-verdict ◀─ Review lenses
      │
      ▼
  Milestone gate (with the user) ──▶ next milestone's calibration
```

1. **Recon swarm** (read-only) maps the ground before anything is planned: pinned
   versions, APIs, the reference's behavioral invariants, long-lead externalities, and the
   baseline performance figures every later sketch cites — latency and bandwidth of each
   external dependency, data sizes, the target machine's disk and network.
2. **Calibration interview** settles tensions and open questions, one at a time, each with
   options, pros and cons, and a recommendation. Answers land in the decision ledger.
3. **Milestone plan** orders waves (§ 3) and names each milestone's stop-and-evaluate.
4. **Per wave:** probes → decisions → wave plan → lead skeletons → staged dispatch →
   review lenses → fix via resume + finder re-verdict → lead integration → wave gate →
   retro fold-in → records. A red wave gate blocks the next dispatch.
5. **Milestone gate** with the user: live matrix, human walkthrough, model-split verdict.

**Why this shape.** Swarms compress writing; the proving loop (unit → loopback → live →
dogfooding) stays roughly constant, so it is the bottleneck. The order front-loads
falsifiers: fakes, a frozen event vocabulary and recorded fixtures look like
over-engineering for one builder, and they are what makes parallel execution safe. Limits
that follow from it: security-critical protocol wiring stays serial and human-gated; live
device work stays with the lead and the user; a stage is a handful of members, and only
genuinely independent units are swarmed — every member costs tokens.

**Wave rhythm.** A wave spans sessions: a planning session writes `plans/W<N>.md` and a
carry; a fresh session runs skeletons through the gate. The plan files, not the
conversation, carry the wave across the reset.

## 2. Where the user is in the loop

Input is front-loaded. The user decides at the calibration interview and at the per-wave
decision point after probes, then walks the live and milestone gates. Everything between
runs without permission pauses: a lead that stops to ask "dispatch now?" when nothing is
being decided is spending the user's attention on a ritual.

**Settle the standing permissions at calibration** so they are not asked per wave: when the
lead commits (per stage / per wave), when it pushes, when it opens and merges PRs, and
which live or costly actions still need a go. Most permission pauses in practice were
"commit?" and "push?".

### Standing permissions

The lead reads calibration as done when this section exists and carries no unfilled
slot. (Prose here must not spell a slot token itself: any upper-case name in angle brackets
counts as unfilled.)

- Commit: `<COMMIT_POLICY>` (per stage / per wave)
- Push, PR open and merge: `<PR_POLICY>` (one PR per wave; merge on green CI)
- Live or costly actions that still need the user's go: `<GO_LIST>`
- Secondary model (recon, probes, implementation tracks, adversarial lens): `<SECONDARY_MODEL>`
- Wave gate: `/swarm-gate`

The lead asks the user for the secondary model, with the list from `harness.md § Models` in
front of them, and never picks it itself; an answer the user hands back is recorded
`ADOPTED (delegated)`.

The last line declares a swarm-only project: its wave gates then require the seven
`swarm-gate: <item>` rows (§ 10). Delete it at calibration when the project is phased and
its own step and phase gates cover the swarm work.

### Decision ledger

Every calibration answer and every later decision that binds more than one wave:

| id | decision | status |
|---|---|---|
| D-1 | `<DECISION>` | RATIFIED (user) / ADOPTED (lead) / ADOPTED (delegated) |

**Mid-wave findings — stop or park, by impact:**

| The finding… | Action |
|---|---|
| changes a frozen contract (disposition PROMOTED, § 9) | **stop** — wait for the user |
| contradicts a ratified decision in the ledger | **stop** |
| moves something across the wave's "Explicitly NOT in" line | **stop** |
| is still open after the second fix round (§ 9) | **stop** — the brief or the contract is wrong |
| stays inside one track's owned files and no sibling needs it | **park** — ledger entry, hold only dependent tracks, surface at the wave gate |

A stop still lets independent tracks finish; it blocks the next dispatch. **Parking decides
only whether to stop now.** By the wave gate a parked defect in code the wave ships is
FIXED or ACCEPTED (§ 9); only missing scope — work handed to a later wave — stays parked.
What ships meets the design goals, even when features are missing.

**The probe swarm exists to make stops rare.** Findings a probe could have made before
planning are the costliest kind to make mid-wave.

## 3. Ordering principles

1. **Contracts before implementations.** Freeze seams (types, wire shapes, names, and the
   assertions that state each seam function's pre- and postconditions) in writing before
   any parallel dispatch. At every cross-track seam the assertions are **paired**: the
   producing track asserts a property before it hands data over, the consuming track
   asserts it on receipt, each side in its own track's `Owns:`. Members may add assertions;
   removing or weakening a frozen one is a contract change (PROMOTED, § 9).
2. **Fakes before adapters.** Every external edge gets a trait/interface + in-memory fake
   in the first wave; real adapters stay thin.
3. **The serial core is only the real-spine proof**, and it stays thin.
4. **Verification apparatus is a deliverable** — conformance suites, loopback harnesses,
   fixtures.
5. **Homogeneous work** (hardening matrix, platform drills, release artifacts) is
   item-swarm work at wave ends, never a phase.
6. **Long-lead externalities start early** as background tracks (dep pins, toolchains,
   signing, store accounts).

Default wave order: contracts → thin real spine → breadth (one track per seam) →
views / packaging / hardening → milestone-specific reach. Slot the project's own order in
Appendix B when it differs.

### Wave list

The lead works the waves top to bottom; a wave is done when its gate and records
check complete (§§ 10, 12).

| wave | milestone | goal |
|---|---|---|
| W0 | `<MILESTONE>` | `<GOAL>` |

### Milestones

Stage 3 is done when the wave list has a filled row and every milestone it names has its
stop-and-evaluate criteria here.

- **`<MILESTONE>` — `<OUTCOME>`.** Stop and evaluate when: `<CRITERIA>`.

## 4. Roles and models

| Work | Model |
|---|---|
| Plan, decide, calibrate with the user | `<PRIMARY_MODEL>` (the lead) |
| Lead serial work: contract edits, skeletons, integration | `<PRIMARY_MODEL>` |
| Recon cross-check lens | `<PRIMARY_MODEL>` |
| Recon swarm, probes, implementation tracks | `<SECONDARY_MODEL>` |
| Adversarial lens over the wave diff | `<SECONDARY_MODEL>` |
| TigerStyle pass and the swarm gate's stress pass | `<PRIMARY_MODEL>` — never handed to the pool |
| Escalation to the primary model | per item, deliberate — never the swarm default |

- **The secondary model is chosen for cost, not as a weaker tier.** It carries the bulk of
  the tokens; briefs are self-contained so it needs nothing else.
- **The lenses run on different models on purpose.** The secondary-model adversarial lens
  is the leg most likely to find structural bugs.
- **The stress and TigerStyle passes stay on the lead's model.** On a build where every
  implementation track and lens ran on the secondary model, the secondary-model lenses
  caught the plan blockers while the lead-model stress pass found edge defects they had
  missed. Cheap tracks plus a strong stress pass is the split; a stress pass handed to the
  pool loses the half that finds edges.
- **An escalation is a data point about the brief**, not only about the item.
- Keep `docs/model-split.md` (living): the assignment table, what to watch (lens depth,
  brief sensitivity, escalation rate, evidence compliance, integration cost), and **one
  dated entry per wave**. The verdict is a milestone-gate deliverable.
- **Toolsets are per dispatch.** Probes, recon and lenses run read-only (a lens as its own
  command, `harness.md § Lens command`, or a read-only brief when it must run commands);
  implementation tracks get write access (`harness.md § Member permissions`). A guard
  message that names a tool must account for which kind of dispatch it refuses.
- **Every dispatch names its model explicitly**, and the record takes the model each member
  actually ran on from the transcript verdict, not from the brief or memory. Defaults can
  put a lens on a write-capable profile, and a plan that says which model ran a lens
  without checking goes wrong.

## 5. Wave plan file (`plans/W<N>.md`)

Sections, in order, each as a `## N. Title` heading — the gate reads § 9 and
§ 11 by number:

1. **Base** — `HEAD <sha>` the wave is briefed against.
2. **Carried into W<N>** — items inherited from earlier waves, each with its origin.
3. **Explicitly NOT in W<N>** — written as constraints ("there is never a `--x` flag in
   this milestone"), not statuses. This line is the stop rule's boundary (§ 2).
4. **Decisions** — `D-W<N>-k` entries: the question, options considered, the pick,
   rejected alternatives, consequences honestly stated, and a status (RATIFIED by the user
   / ADOPTED by the lead / RECORDED). Posture calls are always user-ratified.
5. **Probe results** — the digest, with a **"Falsifications of brief assumptions"**
   section and a list of what the lead did *not* re-verify. Raw dumps go in
   `plans/w<N>-probe/`.
6. **Skeletons** — what the lead lands before dispatch, pinned by commit, carrying the
   frozen seam assertions (§ 3). The section opens with a **Performance sketch**: each
   resource the wave touches (network, disk, memory, CPU) with its bandwidth or latency
   figure cited to `docs/pins.md` or a § 5 probe, the slowest resource after weighting by
   how often it is used, and the batching plan — or one line, `no hot path — <why>`.
7. **Dispatch stages** — the file-touch map and the resulting order, e.g.
   `A → (B ∥ C ∥ D) → (E ∥ F)`.
8. **Briefs** — one per track (§ 7).
9. **Pre-staged gate** — every gate command and its expected output, including any
   named known-failure row, as a table:

   ```
   | row | command | expected | observed | state |
   |---|---|---|---|---|
   | tests | <cmd> | <expected> | <observed, filled at the gate> | OBSERVED |
   | adversarial lens (<seam A>) | <the lens command> | PASS | <wave-id>/<agent-id> | PASS |
   | adversarial lens (<seam B>) | <the lens command> | PASS | <wave-id>/<agent-id> | PASS |
   | recon lens | <the lens command> | PASS | plans/w<N>-lens/recon.json | PASS |
   ```

   `state` is `PENDING` until run, then `OBSERVED`, `RED`, or `KNOWN-FAIL-AS-PREDICTED`;
   lens rows are `PASS` / `FAIL`. One member is not a wave, so the adversarial
   lens runs as ≥ 2 members split by seam, one row each; each row cites the member
   whose answer is that seam's verdict — after a fix round, the re-verdict's member.
10. **Integration record** — skeleton signature changes tracks proposed, ratified or
    declined; lead integration repairs.
11. **Records** — a per-dispatch record line (§ 12), lens findings with dispositions,
    gate evidence, retro. Line shapes the gate reads: `Driver record: <wave-id> — …` per
    dispatch; `Not covered: <item> — <why>` for each item a lens reported not covering;
    a `### Retro` list whose items each end in `FOLDED` or `LEAD-PRACTICE`.

Size the plan for a session reset: a fresh session reading only the plan file and the
wave file can continue.

## 6. Probes

- **Run before the wave plan is final.** Probes harvest behavioral invariants, not just
  signatures: comments and tests in the reference encode runtime rules. The invariant list
  ships in the briefs; it catches tests that are green while violating a rule.
- **Pin the base.** Probes run against a named commit.
- **Measure what the sketch needs.** Probe the figures this wave's design rests on — an
  external call's latency, a file's size, a query's cost — and record the command and
  output; the wave file's performance sketch (§ 5, item 6) cites them. The code that does
  not exist yet can't be measured; the ground it will run on can.
- **Re-observe before a decision rests on it.** A probe claim that a decision cites (a runtime
  behaviour, a file-system quirk, a library default) is re-run by the lead, and the command and
  output go in the invariants file. One wrong probe observation otherwise becomes a decision,
  and two probes can contradict each other without anyone noticing.
- **Instruct probes to falsify the brief's assumptions**, not to cite them. The
  falsifications section is the useful half of a probe report.
- **Verify shipped status by call-site search, never by a Status line.** Plan documents
  have their own revision series; a status line in a plan is not evidence that code exists
  or is called.
- **Pin reference facts to a commit SHA**, not a plan filename or line number.

## 7. Briefs

A brief is everything a member sees. Split it: the part of the spawn every member shares
holds the conventions, the evidence contract and the report format, and each item holds
that member's own brief. A shared part that carries every track's brief shows each member
all its siblings' work.

It carries:

- **Goal** and the acceptance it must meet. A scenario or API with no production caller is
  not done.
- **Baseline at dispatch** — the suite count and format/lint state the member starts from
  (e.g. "83/83 green, fmt + lint clean"), so its report can show the delta.
- **`Owns: <paths>`** — the files the member may change. No path appears in two items.
  Carve-outs are explicit (`src/** except src/lib.rs`). Hot files belong to the lead.
- **Base commit** (`HEAD <sha>`). A late dispatch is briefed against the newest base.
- **Frozen contract refs** and the construction sites of any frozen type the track touches,
  including the seam assertions the track owns — add to them, never remove or weaken them.
- **Available dependencies** — pre-declared by the lead; tracks reference, never add. A new
  one, the lead's included, is a `D-W<N>-k` decision saying why the code can't live in-tree.
- **Invariants** from the probes that the track's code must uphold.
- **Tests to write, in the falsifier form, stated verbatim:**
  (a) RED before GREEN — write the failing test against the pre-fix tree and observe it
  fail; (b) prove the test non-vacuous by falsifying it against a deliberately broken
  variant; (c) re-run RED against the final test file so both runs use identical inputs.
- **Evidence contract** — every claim in the report carries the exact command and its
  observed output (§ 11).
- **Propose vs apply** — for any file outside `Owns:`, "deliver a diff in the report, do
  not apply it." Never "consider whether X is needed."
- **Assertion reconciliation** — if the track's semantics turn a sibling's assertion red,
  report the exact patch; do not wait.
- **Scratch** — the member's own working directory, one fresh path per attempt, so no
  removal is ever needed.
- **Named patterns** — *snapshot-and-build* (copy the tree to scratch and build there) and
  *verify-while-sibling-mid-flight* (restore a sibling's file to the base inside your own
  scratch copy to test your work without touching theirs).
- **Deferrals as constraints**, restated from the wave plan.
- **User-accepted decisions — do not relitigate**, listed.
- **Transient breakage** — "if a sibling's in-flight work breaks your build, note it in
  the report and continue"; generated lockfiles may shift underneath and are never
  hand-edited.
- **Live tests are marked lead/user-only** (skipped by default in the member's runs).
- **Report format** — landed; files touched; evidence (command + output); contract-change
  candidates; cross-track notes; risks; what was not checked, or "nothing" — a report
  that silently skips part of its scope reads as full coverage.
- **Never** git mutations, devices, relays, releases, or other external state. The lead
  owns git and every live run.

Fix-round briefs (via resume) restate `Owns:` with its carve-outs: a resumed member keeps
its context, not necessarily its sense of boundary.

## 8. Dispatch

- **A wave is a staged sequence of dispatches**, ordered by the file-touch map — not one
  call. Each stage is one member wave; stages run in order; a stage's members run in
  parallel.
- **Every stage has ≥ 2 tracks.** One member is not a wave (resumes excepted). Plan
  the file-touch map so a single-track stage is split along a real seam (separate files), or
  run that track as lead work — never pad a stage with a filler item.
- **One writer per file per wave.** After each stage, check `git status --short` against
  each member's `Owns:` list before anything else; any path outside a list stops the wave.
- **The lead commits**, once per stage or once per wave; members never commit.
- **Skeletons unlock intra-wave dependencies.** Land the additive signature, feature flag
  or constructor a dependent track needs before dispatch, and pin it in the brief.
- **Pre-split shared files.** Where several tracks would add to one file (a module index,
  a shared fake, a word list), the lead splits it into per-track files or stubs before
  dispatch, so ownership lists never overlap.
- **Mid-wave contract changes:** adding a method to an interface is safe while tracks are
  in flight; adding a field to a struct that tracks construct waits until they land.
- **Held-out items:** a deliverable a mid-flight sibling would falsify (e.g. a release
  build of a moving tree) is dispatched at integration, not in the wave.
- **Concurrency cap** ~3–4 when the build system serializes on a lock, and never above the
  cap `harness.md § Spawn` names.
- **Background builds** write to a log file; poll the log, not the process. A test run past
  ~2× its known runtime gets sampled immediately (process state + one debug print).
- **Interrupted members:** check processes and the artifact directory before
  re-dispatching; a resume refused as "already running" means wait. A lost member's
  unfinished work may be adopted by the lead or a sibling, verified hunk by hunk.
- **Live-touch boundary:** members bind loopback/local only. Live runs are lead- or
  user-only; never delegated, never simulated.

## 9. Review lenses and dispositions

Two lenses over the wave diff:

1. **Adversarial lens** (`<SECONDARY_MODEL>`, a wave of ≥ 2 members — one member is not a
   wave — each scoped to one side of the wave's seams, and told the other
   side is covered) — hunt structural bugs, not nits. What did the tests miss? Is any
   production path dead (green tests calling code nothing else calls)? Is any headline claim
   false on a fresh run? Give it the integration seams explicitly.
2. **Recon cross-check lens** (`<PRIMARY_MODEL>`) — re-run the wave's headline commands on a
   fresh tree; verify citation fidelity against primary sources; report "N/M classes
   verified".

The two are scoped against each other in their briefs — one refutes by reading, one
re-observes evidence.

**TigerStyle pass beside them.** On a swarm-only project the lead runs the TigerStyle lens
(`lenses/tigerstyle.md`) over the same frozen diff while the lenses run. Its findings join
the fix round with the lenses', so style defects are fixed while the code is fresh rather
than after the re-verdict.

**Both lenses answer in one schema**, so the gate reads the verdict rather than the lead's
summary of it. No harness can force a subagent's output shape, so each lens's brief asks for
its whole final message to be that JSON and nothing else. The recon lens's answer is saved
to `plans/w<N>-lens/recon.json` with a `model` field naming the model it ran on (the gate
refuses any adversarial member on the recon lens's model):

```json
{
  "type": "object",
  "required": ["verdict", "findings", "not_covered"],
  "properties": {
    "verdict": { "enum": ["PASS", "FAIL"] },
    "findings": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["severity", "claim", "cite"],
        "properties": {
          "severity": { "enum": ["BLOCKER", "MAJOR", "MINOR"] },
          "claim": { "type": "string" },
          "cite": { "type": "string" }
        }
      }
    },
    "not_covered": { "type": "array", "items": { "type": "string" } }
  }
}
```

`not_covered` lists the files, seams or claims the lens did not check — empty only when it
checked everything in its brief. Each entry needs a `Not covered:` line in § 11 (the entry
verbatim, then ` — <why>`) before the gate completes, so the brief asks for **one short phrase
per entry** (a file, a seam, a claim), not a paragraph.

**Lenses review a frozen tree.** The lead does not fold in fixes while a lens is running;
an edit mid-review produces findings about the lead's own change and a verdict on a tree
that no longer exists. Pin the lens to the commit it reviews.

**Review before dispatch, too.** Contracts and skeletons — their frozen assertions and the
performance sketch included — get one adversarial pass before any track is dispatched
against them. A seam designed from the lead's mental model rather than from recon
evidence is cheapest to catch there, and so is a wrong `no hot path`.

Every finding gets a disposition, recorded in the wave file and the amendment log:

- **FIXED** — landed via resume on the original implementer.
- **DEFERRED** — missing scope only: named reason + the wave or version that picks it up.
  A defect in code the wave ships is never deferred — fix it, or accept it.
- **ACCEPTED** — a documented deviation, with why, at the site.
- **PROMOTED** — forces a contract change: a lead-only freeze commit, and a **stop** (§ 2).

**The finder re-verifies.** Resume the lens that raised a finding after the fix; it
confirms against its own finding and demands a regression test that fails on the pre-fix
tree with the value the finding predicted. A wave gate that requires "lenses PASS" means
the re-verdict ran and passed — a FAIL followed by fixes is not a PASS.

**At most two fix rounds per wave.** Round one fixes the lens and TigerStyle findings;
round two fixes what the re-verdict raises. A finding still open after the second
re-verdict means the brief or the contract is wrong: stop (§ 2) and put it to the user —
re-plan, escalate the item to the primary model, or cut it from scope.

**The lead may correct a finding's stated mechanism** before dispositioning it; record the
correction. A rationale recorded in a plan is a claim the lens can falsify — strike it
through when it falls, don't delete it.

Lens output is a hypothesis: re-verify any file:line claim the turn it is folded in.

## 10. Gates

- **Wave gate** (mechanical — the lead checks it):
  assembled-tree test suite green + format check + lint clean + consumer-side checks
  (incl. cross-target type checks) + CI green on the wave's PR + both lenses PASS after
  re-verdict + every pre-staged row observed. A named known-failure row passes only when it
  fails the way it was predicted to. **Red blocks the next dispatch.**
- **Swarm gate** (swarm-only projects, declared in § 2 Standing permissions): the wave
  file's § 9 also pre-stages `swarm-gate: tests`, `swarm-gate: TESTS.md`,
  `swarm-gate: tigerstyle`, `swarm-gate: security`, `swarm-gate: simplify`,
  `swarm-gate: stress` and `swarm-gate: scope`, run at the wave gate; the milestone gate
  runs their milestone mode. The mechanical gate refuses a declared wave that lacks any of
  the seven rows.
- **Milestone gate** (with the user): live matrix green, each leg asserting artifact
  identity (hash, byte count) at both ends + human walkthrough of any surface ("screenshot
  or it didn't happen") + model-split verdict written. Rows that cost money or touch
  shared infrastructure need the user's go before they run.
- **A gate assesses; it does not pass.** The lead reports evidence; pass/fail at the
  milestone gate is the user's call.
- **Pre-stage** every gate command and expected output in the wave file before the gate
  runs. Carry the gate environment forward and re-probe it at pre-staging; an environment
  change made to get a row green is recorded as an environment adaptation, not a product
  change.

## 11. Evidence contract

Every claim that reaches a wave file, the amendment log or a gate carries the exact
command, the observed output (or a path to the captured log), and for live legs the
artifact identity at both ends. Numbers reported to a gate are the run's numbers. A "PASS"
without a command is not evidence; a gate record that says "lint clean" is re-checked
against the lint output before it is committed.

## 12. Records

Written at every wave close — the lead does not start the next wave without them:

- **Amendment log entry** in `plans/BuildPlan.md` — what changed, what was folded in,
  decisions ratified, with evidence. It opens `- **<date> — W<N> closed:**`; a planning
  entry that names the wave is not its record.
- **Model-split entry** in `docs/model-split.md`, opening `- **<date> — W<N>:**`.
- **A record line per dispatch** (`Driver record: <wave-id> — …`, the lead-in the gate
  reads): wave id, members × the model the transcript verdict recorded for each, permission
  mode, denials, and notes worth keeping.
- **Retro** — "what went wrong, what would we do differently" — each item either folded
  into the plan (a rule change, logged) or kept as lead practice (said so).

## 13. Anti-pattern catalogue

| Shape | Fix |
|---|---|
| **Shared-manifest choke point** — a track references a dependency the root hasn't declared; every build blocks | Pre-declare dependencies in the skeleton; tracks reference, never add |
| **Silent cross-tree red** — a track's semantics turn a sibling's assertion red and it waits | Assertion reconciliation is a report item (§ 7) |
| **Assertion deleted to go green** — a member removes or loosens the check that fails | Seam assertions are frozen contract (§ 3); weakening one is PROMOTED |
| **Frozen-vocabulary breakage** — one new enum variant breaks N construction sites | Enumerate construction sites at freeze time; list them in dependent briefs |
| **Mid-wave field addition** — a struct gains a field while tracks construct it; in-flight builds go red | Methods mid-wave are safe; fields wait until tracks land (§ 8) |
| **Brief-shape failure misread as model limit** | Re-read the brief before blaming the model |
| **Seams from the mental model** — contracts designed before recon, then contradicted by the reference | Recon swarm before contracts; adversarial pass on contracts before dispatch (§ 9) |
| **Vacuous search test** — a test that looks for a matching case passes when none exists | Assert the case was found before asserting on it; falsifier form (§ 7) |
| **Lens on a moving tree** — the lead edits during review; findings describe the lead's own change | Freeze the tree for the lens (§ 9) |
| **Build output piped through `tail`** — the exit status and the failure scroll away | Log to a file; read the exit code |
| **Under-specified ownership** — two tracks edit one file, or a track edits a seam | `Owns:` lists + a lead-owned hot-file list; post-stage ownership check |
| **Invariant upheld one layer down, violated one up** — every track green | Caller-side tests for invariants; give the adversarial lens the integration seams |
| **Dead production path** — green tests call an API nothing in production calls | The adversarial lens checks for callers; acceptance names the production call site |
| **False premise in a brief** — a track built on an assumption the reference never held | Probes falsify assumptions before planning; the lens rechecks premises |
| **Citation on the wrong code path** — a `file:line` that resolves, on a different flow than claimed | A cite must sit on the claimed code path; verify the path, not just the line |
| **Status line trusted as shipped** — a plan says "Open", the code shipped (or vice versa) | Call-site search (§ 6) |
| **Gate record overclaims** — "lint clean" with warnings present | Re-check every gate line against its output before commit (§ 11) |
| **Proposal read as instruction** | "Deliver a diff, do not apply"; check at fold-in that proposal-only files are untouched |
| **Unpiped background build** hides progress and death | Log file; poll the log |
| **Timeout trusted to find a wedge** | Sample at ~2× known runtime |
| **Orphan process after interruption** | Process + artifact check before re-dispatch |
| **Partial-state cascade** — a refused step inside an `&&` chain leaves setup half-built; a later error looks unrelated | Idempotent, separately retryable setup; when an error looks inexplicable, look for an earlier refusal |
| **Environment blame** | Controlled reproduction first |
| **Records skipped when nothing enforces them** — lenses, amendment entries, model-split entries and exit gates drop out within a few waves | The lead refuses the next wave until § 12 records exist |

## 14. Harness notes

Every harness-specific step this template used to spell out — the fan-out and its concurrency
cap, waiting for members and resuming one, how members get write access and what bounds them,
the models a member or a lens can run on, the one headless command per review lens, where a
member's and a lens's transcripts are, and how to reach the user or run long work in the
background — is in `harness.md`, in this skill's folder. Read it as the rest of this section:
the rules above are written to hold in every harness, and that sheet is how they are carried
out here.

## 15. Amendment log

Newest last. Each entry: date, wave/milestone, what changed, evidence.

- **<DATE> (instantiated from the template).**

---

## Appendix A — file layout

```
plans/
  BuildPlan.md            # strategy, standing principles, decision ledger, amendment log
  W<N>.md                 # per-wave plan (§ 5)
  W<N>-invariants.md      # probe digest: invariants + falsifications + not-re-verified list
  w<N>-probe/             # raw probe dumps
  w<N>-lens/recon.json    # recon lens verdict (§ 9 schema + model)
  W<N>-hardening.md       # hardening scenarios: loopback shape + live shape + evidence row
docs/
  pins.md                 # pinned versions + baseline figures + mined decisions, cited by commit
  model-split.md          # living: assignment table, what to watch, one entry per wave
.claude/swarm/<wave-id>/  # the wave's records: input.json, results.json, registry.json,
                          # transcripts.json (written by scripts/cli.ts transcripts)
AGENTS.md / CLAUDE.md     # workspace conventions, swarm protocol, model policy
```

## Appendix B — instantiation worksheet

| Slot | Fill in |
|---|---|
| `<PROJECT>` | name + one-line outcome |
| Reference | read-only source of truth (if rebuilding/porting), pinned by commit |
| Seams | the interfaces and wire shapes frozen in the first wave |
| Fake / real edges | each external dependency → interface → fake → adapter |
| Hot files | paths the lead integrates |
| `<PRIMARY_MODEL>` / `<SECONDARY_MODEL>` | the lead's model / the user's answer at calibration (§ 2 Standing permissions), then copied into §§ 4 and 9; model names as `harness.md § Models` lists them |
| Test / format / lint / type-check commands | the wave-gate command set, verbatim |
| Member permissions | `harness.md § Member permissions` — the commands members must be able to run |
| Consumer surfaces | CLI / GUI / API — which is primary |
| Live matrix | the legs, with the artifact-identity assertion per leg |
| Hardening scenarios | the item-swarm list |
| Milestones | outcome + what "stop and evaluate" measures at each close |
| Standing principles | project-wide directives that every brief inherits |
