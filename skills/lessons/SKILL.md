---
name: lessons
description: Log a domain insight, API quirk or empirical finding to the project's lessons file, .claude/lessons.md. A procedure the user starts by name with a description of what was learned.
---

# lessons

Add an entry to the project's lessons log: domain insights, empirical findings, API quirks and non-obvious discoveries. Lessons are durable, project-scoped knowledge. They are distinct from `buglog.md`, which tracks recurring agent mistakes, and from notes on an investigation still in progress.

The user's description of what was learned: $ARGUMENTS

If `$ARGUMENTS` above was left as written, use the text the user typed after the command instead.

## Steps

1. **Locate the log.** It lives at `<project-root>/.claude/lessons.md`, where the project root is the top of the current git checkout (or the working directory outside git). If `.claude/` or `lessons.md` does not exist, create them. A new file starts with this header, with the project's directory name for `<PROJECT>`:

   ```markdown
   # <PROJECT> — Lessons Learned

   Domain insights, API quirks, and code-level learnings for the project.
   Distinct from `buglog.md` (recurring agent mistakes) and journey notes (in-flight investigation).

   Add entries continuously during work, not just at phase gates. Review at the start of each new phase.

   Format per entry: Date, Title, What we learned, How to apply going forward.

   ---
   ```

2. **Check for a duplicate from the headings only.** Run `scripts/headings.sh <project-root>` from this skill's folder. It prints each entry heading of the log with its line number, not the whole file. If a similar finding is already logged, read only that entry, then update or extend it instead of adding a new one.

3. **If the description is empty**, ask the user what was discovered or learned, and how it should apply going forward. Stop until they answer.

4. **Append the entry.** Put it under a `## YYYY-MM-DD — <context>` date section, adding one for today if it is missing. The entry id is `<YYYY-MM-DD>-<kebab-slug>`, a date-prefixed slug from the finding's short title (for example `2026-04-19-worktree-absolute-paths`). Slugs, not sequence numbers, keep two parallel sessions from colliding on the same number.

   ```markdown
   ### <YYYY-MM-DD>-<kebab-slug> — <short title>
   **Date:** <YYYY-MM-DD>
   **What we learned:** <the finding, observation, or domain insight>
   **How to apply:** <concrete guidance for future work>
   **Sources:** <optional — commit SHAs, session id first 8 characters, paths>
   ```

   Cite another lesson by its full slug id (for example `` `2026-04-18-harness-alongside-detector` ``), never by a number.

   When the lesson came from something the user said, quote it verbatim and short if it names the failure, states a rule or makes a checkable claim. Summarize it instead when it carries only frustration and no diagnostic detail.

5. **Confirm.** Tell the user the entry was added and show its heading line.
