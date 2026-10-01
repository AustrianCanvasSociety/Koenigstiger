---
name: howdoi
description: Answer "how do we / how do I" questions about our own machines, network, services and workflows from our runbooks, not general knowledge. Use for operational questions such as adding a computer to the tailnet, restoring a backup, or rotating a credential.
---

# howdoi

Our runbooks are the source of truth for how we run our own machines and services. What a tool can do in general is not an answer about how we do it.

1. **Search.** If a `[ktx:howdoi]` block is already in context for this question, use it. Otherwise run `scripts/howdoi.sh --any "<the question>"` from this skill's folder. It prints the best-matching runbook sections as `path:line  § heading`, each with its matching lines.
2. **Read.** Open the top-ranked sections at the cited lines and read each one through before answering.
3. **Answer from the runbook.** Quote commands exactly as the runbook gives them and cite every file you used as `path:line`.
4. **No match.** If the search finds nothing relevant, say our runbooks don't cover it, then give general guidance labelled as general.
