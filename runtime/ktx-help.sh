#!/usr/bin/env bash
# ktx-help.sh <claude|codex|kimi|opencode> — prompt hook for ktx prompt triggers.
# Reads the hook payload on stdin, runs every trigger in triggers.json whose
# pattern matches the prompt, and hands their output back to the harness:
#   claude, codex — JSON hookSpecificOutput.additionalContext
#   kimi, opencode — plain stdout (the harness appends it to the prompt)
# The prompt may be a string (Claude, Codex, OpenCode) or a list of content parts (Kimi).
# A prompt that starts with an explicit invocation (/ktx:, /ktx/, /skill:, $ktx:) has
# already started the skill, so no prompt trigger fires beside it (D-W2-6); that
# same invocation is what {invoke} in an instruction stands for (D-W2-10).
# Fail-open: any error means no output and exit 0, so a broken trigger never
# blocks the user's prompt.
# Every harness runs this file as `bash <path> <harness>`, never by its own path.
harness="${1:-}"
root="$(cd "$(dirname "$0")/.." && pwd)"
triggers="$root/triggers.json"

# This harness's own invocation form, and where it keeps the skills whose run
# scripts a trigger may name: OpenCode's data dir is ktx/ beside the skills dir
# it installs into (D-W5-2), so its runs resolve one level up. An unknown
# harness injects nothing at all.
case "$harness" in
  claude) invoke="/ktx:" ; skills="$root/skills" ;;
  kimi) invoke="/skill:" ; skills="$root/skills" ;;
  codex) invoke='$ktx:' ; skills="$root/skills" ;;
  opencode) invoke="/ktx/" ; skills="$root/../skills" ;;
  *) exit 0 ;;
esac

prompt=$(jq -r '.prompt | if type == "array" then map(select(.type == "text") | .text) | join("\n")
  elif type == "string" then . else empty end' 2>/dev/null) || exit 0
[ -n "$prompt" ] && [ -f "$triggers" ] || exit 0

# D-W2-6: any of the four invocation forms, whatever harness is running.
case "$prompt" in
  /ktx:* | /ktx/* | /skill:* | '$ktx:'*) exit 0 ;;
esac

context=""
count=$(jq 'length' "$triggers" 2>/dev/null) || exit 0
i=0
while [ "$i" -lt "$count" ]; do
  skill=$(jq -r ".[$i].skill // empty" "$triggers" 2>/dev/null)
  match=$(jq -r ".[$i].match // empty" "$triggers" 2>/dev/null)
  run=$(jq -r ".[$i].run // empty" "$triggers" 2>/dev/null)
  instruction=$(jq -r ".[$i].instruction // empty" "$triggers" 2>/dev/null)
  i=$((i + 1))
  # Consumer side of the triggers.json seam: an entry missing skill, match or
  # instruction is skipped. A skill is a plain name, so it can never climb out
  # of skills/, and a run stays inside the skill's own folder.
  case "$skill" in '' | *[!a-z0-9-]*) continue ;; esac
  [ -n "$match" ] && [ -n "${instruction//[[:space:]]/}" ] || continue
  case "$run" in /* | *..*) continue ;; esac
  printf '%s' "$prompt" | grep -qiE -- "$match" || continue
  # Every {invoke} names the harness's own command for this skill.
  instruction="${instruction//\{invoke\}/$invoke$skill}"
  if [ -n "$run" ]; then
    # The script runs through the interpreter its own first line names, as the
    # kernel would run it, but the file itself is never launched: macOS holds a
    # newly written executable at its first launch, and every build writes this
    # file anew (Backlog 2026-10-01-hook-first-run-stall). A file with no #! line
    # is launched as it is.
    script="$skills/$skill/$run"
    first=""
    [ -f "$script" ] && IFS= read -r first < "$script" 2>/dev/null
    interp=()
    case "$first" in '#!'*) first="${first#'#!'}" ; read -r -a interp <<< "${first%$'\r'}" ;; esac
    if [ "${#interp[@]}" -gt 0 ]; then
      output=$("${interp[@]}" "$script" "$prompt" 2>/dev/null) || continue
    else
      output=$("$script" "$prompt" 2>/dev/null) || continue
    fi
    context+="[ktx:$skill] $instruction"$'\n'"$output"$'\n'
  else
    # run: "" — an instruction-only trigger, injected with no subprocess at all.
    context+="[ktx:$skill] $instruction"$'\n'
  fi
done

[ -n "$context" ] || exit 0
case "$harness" in
  claude | codex) jq -n --arg c "$context" '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", additionalContext: $c}}' ;;
  kimi | opencode) printf '%s' "$context" ;;
esac
exit 0
