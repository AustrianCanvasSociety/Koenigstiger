# Stress lens

Generate adversarial inputs for a frozen diff's new handlers and parsers, run them, and
surface the failures. The wave's `swarm-gate: stress` row is filled from your answer and
from the tests the lead adds afterwards. The lens is a *generator*, not a fixer: read-only,
no edits to the repository.

## What this does

1. **Identify the target.** The brief names the wave's new handlers and parsers; read their code and the wave's changed files to enumerate the input domain of each. If the brief names no surface, report that in `not_covered` and stop — do not pick a target yourself.

2. **Per target, generate 20–30 adversarial shapes** covering its input domain: a substitution matrix (entity × phrasing × polarity), case variants, unicode/diacritic edge cases, partial matches, homoglyphs, ordering variations, pluralization, slang aliases. Cover the four classes the wave gate's row counts: **valid**, **invalid**, **valid turning invalid** (valid input whose meaning flips under a nearby variant), and **limits** — one at and one past every declared bound.

3. **Run them.** Use the project's own test runner over a scratch test file outside the repository, so the repository stays untouched. If the run's read-only mode refuses the scratch file, report each input with the result you expect and the code path it exercises instead, and say what you could not execute in `not_covered` — the lead runs them before the row is filled.

4. **Report failures only.** For each input that fails: what was expected, what was observed, the diagnostic hypothesis, and its grade. Do not pad the answer with the shapes that passed — the lead adds those as tests and counts them per class.

**Grades.** `BLOCKER` — a realistic input breaks a promise in the wave's plan or a design document, loses or corrupts data, or opens a security hole in ordinary use. `MAJOR` — a wrong result on a plausible but uncommon input, with a workaround. `MINOR` — a contrived input, cosmetic output, or message wording.

## Hard constraints

- **No fixes.** No code edits, no assertion edits, no widening of regexes. The answer is adversarial inputs plus failure diagnostics.
- **No verdict on triage.** You never mark a failure "expected", never propose skipping it, and never add a skip. Those are the lead's and the user's decisions.
- **If you cannot distinguish a bug from a conceptual gap, surface it as one.** Never collapse the distinction into a shrug.

These constraints exist because unconstrained autonomous test work drifts toward the assertion-widening anti-pattern.

## When the target warrants it

The substitution matrix catches *wrong routing*; this lens catches *right routing, wrong answer*. Orthogonal guarantees. The skip/invoke decision keys on the handler's class, not on the wave's size.

**Worth running when the wave added:**
1. A natural-language handler that matches via loose patterns (gap, contingency, constraint, comparison — "what if" / "what about" / "don't have" / "only have" shapes).
2. A handler with an abstract or verbal intent label (`contingency`, `constraint-options`, `comparison`, `workaround`).
3. Free-text formatted output where answer shape can diverge between semantically-close framings.
4. Entity detection shared across multiple handler types — high risk of the same entity routing two different semantic questions to one answer.

**Skip when the wave added:**
1. Only data records (new authorization / volume / procedure) without a new handler.
2. A structured-lookup handler with regex-bounded input (auth-code, FPL-code, airport-pair).
3. Handlers whose tests already asserted the *answer's content*, not just the intent label.
4. Handlers whose output is deterministic with one semantic interpretation per input.

## Answer

Your whole final message is one JSON object and nothing else — no prose around it, no code fence:

`{"verdict": "PASS", "findings": [{"severity": "MAJOR", "claim": "…", "cite": "…"}], "not_covered": ["…"]}`

- `verdict` — `PASS` when no failure is open, `FAIL` otherwise.
- `findings` — one entry per failure. `severity` is `BLOCKER`, `MAJOR` or `MINOR` as graded above. `claim` is one sentence: the input, expected versus observed, and the class it came from. `cite` is `file:line` for the handler, or the command that reproduces it.
- `not_covered` — one short phrase per target, class or claim you did not check, including a class that cannot apply to a target and why. Empty only when you checked everything in your brief; each entry gets a `Not covered:` line in the wave file before the gate completes.
