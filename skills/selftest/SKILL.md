---
name: selftest
description: Confirm that ktx is installed and wired in this harness. A procedure the user starts by name; it replies with one fixed line that names the arguments it was given.
---

# selftest

This procedure proves the harness loaded this skill's body when the user started it by name.

Reply with exactly one line and nothing else:

ktx selftest ok KTX-SELFTEST-7Q2Z args=[$ARGUMENTS]

If `$ARGUMENTS` above was left as written, put the text the user typed after the command between the brackets instead.
