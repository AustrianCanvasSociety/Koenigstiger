# TigerStyle review lens

A static review of a frozen diff against the TigerStyle rules — Safety, Performance and
Developer Experience — run by the lead on the lead's own model. Read-only: you report
findings, you change nothing. The wave's `swarm-gate: tigerstyle` row reads your verdict.

## Applicability

| Diff shape | Action |
|---|---|
| **Hot-path** (parsers, classifiers, pipeline handlers, data-plane logic, search algorithms) | Run all rules. |
| **Glue / config / shell / prose** | Most rules don't bind. Run only Naming + Comments + Commit Messages. Use the simplify lens for the project-conventions sweep. |
| **Auto-generated** (snapshots, lockfiles, fixtures) | Skip. |

Adapted from [TigerBeetle's TIGER_STYLE.md](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/TIGER_STYLE.md). The Go panic-for-validation idiom in the wider TigerStyle document is unidiomatic outside TigerBeetle-class infrastructure; treat it as illustration of *intent*, not idiomatic Go.

## Safety rules

### Control flow
- **Simple, explicit control flow only.** No recursion (ensures bounded execution). Minimal abstractions — every abstraction risks leaking.
- **Split compound conditions** into nested `if/else`. Each branch handles one case clearly. Cover positive AND negative space.
- **State invariants positively.** Prefer `if (index < count) { holds } else { doesn't }` over `if (index >= count) { doesn't }` — the first matches how a loop condition compares `index` to `count`.

### Bounds
- **Put a limit on everything.** All loops and queues have fixed upper bounds. Fail fast when limits are exceeded.
- **Bounded loops only.** Where a loop genuinely can't terminate (event loop), assert that fact explicitly.

### Assertions

Detect **programmer errors**, not operating errors. The only correct response to corrupt logic is crash. Assertions downgrade catastrophic correctness bugs into liveness bugs.

| Rule | Example |
|------|---------|
| Pre/postconditions and invariants | Validate arguments at function entry |
| Density averages ≥2 per function | Check inputs AND outputs/state; don't flag a trivial helper for having fewer |
| Pair assertions — same property, two paths | Assert before write AND after read |
| Split compound: `assert(a); assert(b);` | not `assert(a && b)` |
| Implication as single-line `if` | `if (a) assert(b)` |
| Positive AND negative space | Check what you expect AND what you don't |
| Compile-time constants | Verify config-value relationships |
| Assertion as documentation | True assertion > comment when condition is critical |

Non-null operators (TS `!`, Rust `unwrap()`) are silent contract claims, not assertions — flag and ask whether the invariant is provable from local control flow.

### Memory & resources
- **Allocate at startup, not runtime** where feasible. Pre-allocate buffers, pools, connection limits.
- **Smallest possible scope** for variables. Declare close to use.
- **Group allocation/deallocation** visually (blank line before alloc, defer/close immediately after).

### Error handling
- **All errors handled** — handle, propagate, or assert can't happen. Never silently ignore. (92% of catastrophic distributed-system failures stem from incorrect non-fatal-error handling — [Yuan et al., OSDI '14](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf).)
- Watch for: unchecked `Sscanf` / `parseInt` / `JSON.parse`; `default: return nil` in switch; `?? defaultValue` masking missing-key cases; `try/except: pass`; `|| true` chained with assignment then unconditional use; truncate-on-cancel without an error signal.

### Functions
- **Hard limit: 70 lines per function.** If it doesn't fit on a screen, split it.
  - Push `if`s up, `for`s down — centralize control flow in the parent, move pure logic to leaves.
  - Keep leaf functions pure; parent manages state.
  - Good shape: few params, simple return, meaty logic inside.
- **Simpler return types reduce call-site complexity.** `void` > `bool` > `value` > `optional` > `error`. Watch for `return null` / `return None` overloading multiple distinct failure modes — use a discriminated union or named error.
- **Compiler warnings at strictest setting.** Treat warnings as errors.

### External events
- Don't react directly to external events. Run at your own pace; batch instead of context-switching per event.

## Performance rules

### Design-phase thinking
- **Back-of-envelope sketches** for the four resources: network, disk, memory, CPU. Two characteristics each: bandwidth, latency.
- Optimize for **slowest resource first** (network > disk > memory > CPU), adjusted for access frequency.

### Batching
- Amortize costs by batching: network calls, disk I/O, memory access patterns, CPU work.
- Predictable access patterns, large chunks of work, no zig-zagging.

### Control plane vs data plane
- Separate control plane (setup, config, metadata) from data plane (hot path). Batching is what makes the split pay: per-batch checks run once per batch, not once per item, so the hot path keeps its assertions without losing throughput. Don't strip assertions from the data plane — batch so they're cheap. Trace flags checked once at function entry, not every iteration.

### Be explicit
- Minimize dependence on the compiler to do the right thing for performance. Extract hot loops into standalone functions with primitive arguments (no `self` / `this`): the compiler no longer has to prove it can keep struct fields in registers, and a reader can spot redundant computation.
- Watch for **latent quadratics**: loop-with-`replaceAll` until-no-match (use single regex pass), N+1 lookups in hot paths, repeated allocation inside loops, `string +=` accumulation in JS/TS.

## Developer experience rules

### Naming

| Principle | Good | Bad |
|-----------|------|-----|
| Descriptive, no abbreviations | `connection_timeout_ms` | `conn_to` |
| Units/qualifiers last, descending significance | `latency_ms_max` | `max_latency_ms` |
| Related names same length | `source` / `target` | `src` / `dest` |
| Nouns over participles | `replica.pipeline` | `replica.preparing` |
| Helper prefixed with caller | `read_sector_callback` | `on_read_done` |
| Callbacks last in parameter list | `fn read(path, opts, cb)` | `fn read(cb, path, opts)` |

- **Order matters.** Important things at top. `main` first. Struct fields before methods.
- **Don't overload names** across contexts. Watch for parallel const groups with overlapping string values (e.g. `PermissionAllow="allow"` and `DecisionAllow="allow"` as untyped strings) — promote to named types so the type system enforces non-conflation.

### Comments
- **Always say why.** Code says what and how. Comments say why.
- **Always say how** for tests. Describe goal and methodology at the top.
- Comments are sentences: capital letter, full stop. End-of-line comments can be phrases.
- Magic numbers / tunable thresholds without rationale are comment-debt — even when values are correct.

### Variables & state
- **Don't duplicate state.** No aliases that can go stale. Watch for global mutable state mirrored in return values.
- **Calculate close to use.** Minimize gap between place-of-check and place-of-use (POCPOU).
- **Index vs Count vs Size are distinct types.** Index is 0-based, Count is 1-based, Size = Count × unit. Name accordingly.

### Division intent
- Show rounding intent explicitly: exact, floor, or ceiling division. Implicit `int(float * x)` in Go and `>> 1` in JS/TS rely on language-specific truncation rules — make intent visible.

### Dependencies
- **Minimize dependencies.** Each is supply-chain risk + perf risk + maintenance burden.
- **Pass options explicitly** to library calls. Don't rely on defaults that may change.

### Formatting
- Canonical formatter (`gofmt`, `rustfmt`, `prettier`, `black`).
- Hard limit: **100 columns**. No exceptions.
- Braces on every `if` unless it fits on a single line (defense against "goto fail" bugs).

### Commit messages
- **Descriptive commit messages** that inform and delight. PR descriptions are invisible in `git blame` — the commit message IS the documentation.

## Answer

Your whole final message is one JSON object and nothing else — no prose around it, no code fence:

`{"verdict": "PASS", "findings": [{"severity": "MAJOR", "claim": "…", "cite": "…"}], "not_covered": ["…"]}`

- `verdict` — `PASS` when nothing is open, `FAIL` otherwise.
- `findings` — one entry per open finding. `severity` is `BLOCKER` (a safety rule a shipped path breaks), `MAJOR` (performance or a rule with real cost) or `MINOR` (naming, comments, formatting). `claim` is one sentence; `cite` is `file:line`, or the command whose output shows it.
- `not_covered` — one short phrase per file, seam or claim you did not check. Empty only when you checked everything in your brief; each entry gets a `Not covered:` line in the wave file before the gate completes.
