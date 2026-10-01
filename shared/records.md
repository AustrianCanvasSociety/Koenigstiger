# Wave records

One wave writes four files into `<project-root>/.claude/swarm/<wave-id>/`, where `<wave-id>` is one path segment. The lead writes the first three from the members' own final messages; the transcript check writes the fourth. All four are committed with the wave and the rest of the wave directory stays local, so a gate on another machine reads exactly what the machine that ran the wave observed.

**Check that all four are staged before committing.** An ignore file inside `.claude/swarm/` — some tools write one holding `*` — overrides the project's root ignore, so a wave directory the nearer file excludes stays excluded however the root ignore reads. Confirm `git status` lists `input.json`, `results.json`, `registry.json` and `transcripts.json`, and force-add with `git add -f` any that is absent: records that never entered the commit cannot gate the wave on another machine.

**At most 128 members per wave.** The transcript check fails a `results.json` holding more (the widest single spawn call of any harness, Kimi's). A stage wider than that runs as more than one wave, each with its own wave id and records; batching under a harness's smaller cap (`harness.md § Spawn`) stays inside one wave.

Only the fields below are read anywhere. A wave directory needs nothing else — no log, no spec file, no cost figure — and any other key is noise the gate ignores.

## input.json

```json
{ "description": "W4" }
```

`description` — the only field read: the wave's tag. Exactly `W<N>` for wave N of the plan, or `W<N> ` followed by free text describing the dispatch. A directory whose `description` neither equals nor begins with the wave's tag is not that wave's dispatch and is not counted at all, so keep the tag exact: the gate matches it literally.

## results.json

```json
[
  { "agentId": "agent-0", "status": "completed", "result": "the member's final message" }
]
```

An array, one entry per member:

- `agentId` — the id the harness reported the member under, and the same id `registry.json` carries for it.
- `status` — `"completed"` for a member that answered. Any other value fails that member's row.
- `result` — **a string**: the member's final message as it came back. Shape trap 1: a member asked to answer in JSON still returns *text* — store that text unparsed, and let the reader parse it. A `result` holding an object instead of a string is why a wave with a perfectly good member still gates red.

## registry.json

```json
{ "members": [ { "agent_id": "agent-0", "model": "…", "session": "…" } ] }
```

- `agent_id` — matches a `results.json` `agentId`; it is how the transcript check finds the member's `session`.
- `model` — the model that member ran on, named as `harness.md § Models` names it. The probe's records check requires it; the gate does not read it: each lens member's model comes from the transcript check's verdict (`transcripts.json`), the spelling the member's own transcript records.
- `session` — optional: the lead's own session or thread id, recorded per `harness.md § Transcripts` (a headless run records its own). Member ids repeat across sessions on some harnesses, so an id alone can match two transcripts; `session` narrows it. Record it whenever that sheet says this harness needs it.

## transcripts.json

Written by `scripts/cli.ts transcripts`, never by hand. It holds what the check saw: `result` (`pass` or `fail`), `results_sha256` — the sha256 of the exact `results.json` bytes checked — and one entry per member, each carrying its `agentId`, the model the harness recorded for it and the sha256 of that member's transcript.

The gate reads this file as the wave's evidence: it must exist, say `pass`, list exactly the `results.json` members, and its `results_sha256` must still equal the sha256 of `results.json` today. That last field is what lets the verdict survive a later edit — touching `results.json` after the check invalidates the verdict, and the wave has to be checked again.

## Plan-side records

The same wave leaves rows in the plan, and the gate reads those too:

- `plans/W<N>.md` § 9 — one row per item, with the cells `row`, `command`, `expected`, `observed` and `state`. An adversarial lens row's `observed` cell is `<wave-id>/<agent-id>`; a recon lens row's is a **project-relative path** to that lens's JSON report. Shape trap 2: no leading slash on that path — the gate joins the cell to the project root, and an absolute path there finds nothing.
- `plans/W<N>.md` § 11 — one line per dispatch, starting `Driver record: <wave-id>` with the wave id as the first token. The gate scans for that literal prefix at the start of a line and wants one for every wave directory tagged with the wave; the name is the gate's own, not a process's. The same section needs a `### Retro` list whose every item carries `FOLDED` or `LEAD-PRACTICE`.
- `plans/BuildPlan.md` — an amendment-log entry `- **<date> — W<N> closed:** …`.
- `docs/model-split.md` — an entry `- **<date> — W<N>:** …`.

Each is looked up by the wave's tag, so write the tag the same way in all of them.
