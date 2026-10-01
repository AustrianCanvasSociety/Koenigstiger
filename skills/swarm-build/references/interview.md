# Interview — sequential decision walk

Drive a sequential decision interview with the user when analysis has surfaced 3+ open
questions whose answers shape downstream work. Persist the analysis and each Q&A as it closes.
Ask one question at a time as inline prose; iterate per-question with clarifications until the
user's decision can be articulated unambiguously, then move on. Use when the questions are
sequential (later decisions may depend on earlier ones) and the user wants to commit to
decisions rather than vibe through them. Not for exploratory chat or single-question asks —
ask those inline directly. This is the calibration stage (`references/stages.md`, stage 2); the
answers land in the plan's `### Decision ledger`.

## Pre-flight: persist the analysis

Before asking the first question, save the analysis as `.claude/decisions/<YYYY-MM-DD>-<slug>.md`. Create the directory if absent.

Structure:

```markdown
# <Title> — decision interview

**Started:** <date -Iseconds>
**Status:** in-progress

<One sentence on what the interview is shaping.>

## Inputs surveyed

<paste the synthesis: what was reviewed, what each input pushes toward>

## Decision paths considered

<paste the candidate paths / options laid out, including the for/against for each>

## Lessons-shaped guardrails

<paste relevant lessons or principles that constrain the decision>

## Open questions

1. <Q1>
2. <Q2>
3. <Q3>
...

## Decisions

(filled in as the interview progresses — one block per closed question)
```

The `Open questions` and `Decision paths` sections are a snapshot of what was on the table when the interview started. **Do not edit them mid-interview** — only the `## Decisions` section grows.

## Per-question loop

For each question in order:

1. **Ask the question.** One question per turn. Restate with enough context that the user can answer without re-reading the analysis, then present the options with pros/cons + a recommendation — the user may not be a coder, so write so they can decide:

   ```markdown
   **Q<N>: <question, plain language>**

   **A) <name>** — <one sentence, no jargon>
     - Pro: <benefit>
     - Pro: <benefit>
     - Con: <cost>

   **B) <name>** — <one sentence>
     - Pro: <benefit>
     - Con: <cost>

   **Recommendation: A.** <1–2 sentences on why, grounded in the analysis or the user's stated constraints. Name what would flip it — the evidence or constraint that switches the call to B.>
   ```

   Option count follows the analysis — don't pad, don't cap. If more than 4 options are on the table, stop and consider whether the question should be split into two.

2. **Receive the response.**

3. **Evaluate closure.** The question is closed when:
   - You can articulate the decision in one sentence with no ambiguity.
   - The decision is concrete enough that downstream work could proceed from it without re-asking.
   - The user has committed to a specific answer (not "I'm leaning toward X" or "probably Y").

4. **If not closed, ask a clarifying question.** One axis at a time — don't batch clarifications. After 2-3 clarifications without closure, surface that the question may be malformed and offer to reframe.

5. **When closed, record the decision** in the artifact's `## Decisions` section:

   ```markdown
   ### Q<N>: <one-line restatement of the question>

   **Final answer:** <one sentence>

   **Reasoning:** <user's stated reasoning, paraphrased — capture the *why* so future re-reads understand the constraint>

   **Closed:** <date -Iseconds>

   **Downstream impact:** <what this decision enables/locks for subsequent questions or work>
   ```

6. **Move to the next question.** Do not summarize the just-closed answer back to the user before asking the next one — that adds noise. The record-in-artifact step is the persistence; the conversation moves forward.

## Closure heuristics

| User says | Closed? | Action |
|---|---|---|
| "Let's go with X" / "X for sure" / "definitely X" | yes | record + move on |
| "I think X" / "probably X" | no | ask: "committing to X, or still weighing?" |
| "X, but Y if Z" | no | ask what determines whether Z happens; lock the trigger |
| "Whatever you recommend" | no | the interviewer is not the decision-maker; ask the user to commit |
| "Skip this one for now" | deferred | mark deferred; if it blocks later questions, surface the dependency |
| "I don't know yet" | no | ask: "what would you need to know to decide?" — capture the unblocker |

## After all questions close

1. Flip the artifact's `**Status:**` to `closed <date>`.
2. Summarize the decisions for the user — one sentence per decision, in question order. This is the only point at which a recap is appropriate.
3. Surface any new questions raised during the interview that weren't in the original list. Ask the user whether to interview on those next or defer.
4. If the interview's decisions trigger immediate downstream work (plan write, branch open, etc.), name the work — don't auto-start it. The user decides whether to proceed in the same session.

## Don't

- **Don't batch questions.** Sequential means sequential. Even if Q2 is obviously coupled to Q1, ask Q1, get closure, then ask Q2.
- **Don't use a question tool.** Ask as inline prose; the user answers in the conversation like any other turn.
- **Recommendation must be falsifiable.** Name what would flip it — the evidence, constraint, or condition under which the call switches to a different option. A bare "I recommend A" collapses the user's thinking into assent; "I recommend A *because X; switch to B if Y*" gives them a wedge to push back without re-doing the analysis.
- **Don't accept abdication.** "Whatever you think" / "you decide" — push back and ask the user to commit. If the user genuinely wants you to decide a sub-choice, capture that delegation explicitly in the record.
- **Don't proceed if downstream impact is unclear.** If Q1's answer would change which option Q2 is asking about, resolve that coupling before asking Q2.
- **Don't edit `Open questions` or `Decision paths` mid-interview.** Those are the snapshot. Only `## Decisions` grows.
- **Don't auto-commit the artifact between questions.** The artifact accrues all decisions in one commit at interview close (or whenever the user asks to checkpoint).
- **Don't manufacture losing options on Lean-pinned questions.** When the analysis artifact already articulates `Lean: X` per question, present "confirm the Lean, or redirect?" inline (one line per question); don't construct B/C against the Lean's own reasoning. Manufactured forks add cross-out work, not decision quality. Genuine forks (taste / scope / naming / severity calls where reasonable engineers genuinely disagree) stay legitimate — the compression applies only to questions the analysis already resolved.

## After-interview commit

The decisions artifact is project-tracked content. After the interview closes:

1. `git add .claude/decisions/<YYYY-MM-DD>-<slug>.md`
2. `git commit -m "chore(decisions): close interview — <slug>"`
3. Push only on an explicit user authorization — a decisions artifact is not covered by
   standing permissions that name commits alone (constraints 1, 10).

## Output

Finish with one line: `interview: N decisions recorded, M deferred — .claude/decisions/<YYYY-MM-DD>-<slug>.md`.
