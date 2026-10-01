#!/usr/bin/env bash
# howdoi.sh [--any] <question...> — rank runbook sections (a heading and the
# text under it) by the question's words, and print the best sections with
# their matching lines.
#
# A question word scores 3 when it is in a section's heading, else 2 when it is
# in the file's name, and 1 more when it is anywhere in the section's text.
# Without --any nothing is printed unless two different question words are in
# the top section's heading or file name: the prompt hook runs this on every
# prompt that looks like a question, and most of those are not about runbooks.
# --any is for an explicit invocation and prints the best sections regardless,
# and so does a prompt containing "runbook". That word itself is never a search term.
#
# Runbook roots: $KTX_RUNBOOK_ROOTS (colon-separated), else one directory per
# line in ~/.config/ktx/runbook-roots.
# Aliases: $KTX_RUNBOOK_ALIASES, else ~/.config/ktx/runbook-aliases. A line
# "tailscale: headscale mesh vpn" lets the question word on the left match the
# runbook words on the right; it still counts as one question word. # comments.
# Decision log: each run without --any appends one JSON line (question, top
# section, whether it printed) to $KTX_HOWDOI_LOG, else
# ~/.cache/ktx/howdoi-decisions.jsonl. Skipped silently when it cannot be written.
# Exit: 0 matches printed, 1 no match, 2 no roots configured, rg missing, or bad usage.
set -uo pipefail

# Without rg no file is found, which would look like "no match".
if ! command -v rg >/dev/null 2>&1; then
  echo "howdoi: rg (ripgrep) is not installed" >&2
  exit 2
fi

max_sections=5
max_lines=6
min_title_words=2

any=0
if [ "${1:-}" = "--any" ]; then
  any=1
  shift
fi

question="$*"
if [ -z "$question" ]; then
  echo "usage: howdoi.sh [--any] <question>" >&2
  exit 2
fi

# A prompt that names the runbooks ("check the runbooks", "is there a runbook
# for…") is asking for them, so the title rule does not apply to it.
case "$(printf '%s' "$question" | tr '[:upper:]' '[:lower:]')" in
  *runbook*) min_title_words=0 ;;
esac

roots=()
if [ -n "${KTX_RUNBOOK_ROOTS:-}" ]; then
  IFS=':' read -r -a roots <<<"$KTX_RUNBOOK_ROOTS"
elif [ -f "${HOME:-}/.config/ktx/runbook-roots" ]; then
  while IFS= read -r line; do
    [ -n "$line" ] && roots+=("${line/#\~/$HOME}")
  done <"$HOME/.config/ktx/runbook-roots"
fi
if [ ${#roots[@]} -eq 0 ]; then
  echo "howdoi: no runbook roots — set KTX_RUNBOOK_ROOTS or list directories in ~/.config/ktx/runbook-roots" >&2
  exit 2
fi

tab="$(printf '\t')"

# log_decision <injected true|false> <score> <title words> <top path:line>
log_decision() {
  [ "$any" -eq 0 ] || return 0
  command -v jq >/dev/null 2>&1 || return 0
  local log="${KTX_HOWDOI_LOG:-${HOME:+$HOME/.cache/ktx/howdoi-decisions.jsonl}}"
  [ -n "$log" ] || return 0
  mkdir -p "$(dirname "$log")" 2>/dev/null || return 0
  {
    jq -cn --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg q "${question:0:2000}" \
      --argjson injected "$1" --argjson score "$2" --argjson title "$3" --arg top "$4" \
      '{ts: $ts, question: $q, injected: $injected, score: $score, title_words: $title, top: $top}' >>"$log"
  } 2>/dev/null
  return 0
}

# One row per section that scores above 0, best first:
# score, title words, order, first line, file, heading, matching lines (\034-separated).
ranked=$(
  rg --files --glob '*.md' -- "${roots[@]}" 2>/dev/null | LC_ALL=C sort |
    HOWDOI_QUESTION="$question" \
      HOWDOI_ALIASES="${KTX_RUNBOOK_ALIASES:-${HOME:+$HOME/.config/ktx/runbook-aliases}}" \
      awk -v max_lines="$max_lines" '
      # A word as it is compared: lowercase, and a plural "s" dropped.
      function stem(w) {
        if (length(w) > 3 && w ~ /s$/ && w !~ /ss$/) return substr(w, 1, length(w) - 1)
        return w
      }
      # The words of s, in order, into list[1..n]: 3+ characters, not a number.
      function words(s, list,    n, i, k, raw, w) {
        s = tolower(s)
        gsub(/[^a-z0-9]+/, " ", s)
        k = split(s, raw, " ")
        n = 0
        for (i = 1; i <= k; i++) {
          w = stem(raw[i])
          if (length(w) >= 3 && w !~ /^[0-9]+$/) list[++n] = w
        }
        return n
      }
      function add_words(s, set,    n, i, list) {
        n = words(s, list)
        for (i = 1; i <= n; i++) set[list[i]] = 1
      }
      # Score the section that ends at line last, and print its row.
      function flush(last,    o, i, h, f, b, score, title) {
        if (last < first) return
        score = 0
        title = 0
        for (o = 1; o <= norigin; o++) {
          h = 0; f = 0; b = 0
          for (i = 1; i <= nterm; i++) {
            if (origin[i] != o) continue
            if (term[i] in head_words) h = 1
            if (term[i] in file_words) f = 1
            if (term[i] in body_words) b = 1
          }
          score += (h ? 3 : (f ? 2 : 0)) + b
          if (h || f) title++
        }
        if (score > 0) {
          gsub(/\t/, " ", heading)
          printf "%d\t%d\t%d\t%d\t%s\t%s\t%s\n", score, title, ++order, first, file, heading, shown
        }
      }
      function open_section(n, text) {
        first = n
        heading = text
        shown = ""
        nshown = 0
        split("", head_words)
        split("", body_words)
      }
      function scan(    l, n, i, low) {
        split("", file_words)
        base = file
        sub(/.*\//, "", base)
        sub(/\.md$/, "", base)
        add_words(base, file_words)
        fence = 0
        n = 0
        open_section(1, "")
        while ((getline l < file) > 0) {
          n++
          if (l ~ /^(```|~~~)/) fence = !fence
          if (!fence && match(l, /^#+ /) && RLENGTH <= 5) {
            flush(n - 1)
            open_section(n, substr(l, RLENGTH + 1))
            add_words(l, head_words)
          }
          add_words(l, body_words)
          if (nshown < max_lines) {
            low = tolower(l)
            for (i = 1; i <= nterm; i++) {
              if (index(low, term[i])) {
                gsub(/\t/, " ", l)
                shown = shown (nshown++ ? "\034" : "") n ":" l
                break
              }
            }
          }
        }
        close(file)
        flush(n)
      }
      BEGIN {
        n = words("the and for how what when where which with that this from have has does did should would could into about there their then them they you your our ours make need want using over some just like also more most than been were will can not are was but all any get got set use new now who why its out one two add runbook", list)
        for (i = 1; i <= n; i++) stop[list[i]] = 1
        # Question words, each its own origin; an alias adds terms under the same origin.
        # "check the runbooks" is the request to search, not something to search for.
        question = tolower(ENVIRON["HOWDOI_QUESTION"])
        gsub(/(check|see|search|consult|read|look (in|at)) (the |our )?runbooks?/, " ", question)
        n = words(question, list)
        for (i = 1; i <= n; i++) {
          if (list[i] in stop || list[i] in origin_of) continue
          term[++nterm] = list[i]
          origin[nterm] = ++norigin
          origin_of[list[i]] = norigin
        }
        aliases = ENVIRON["HOWDOI_ALIASES"]
        while (nterm > 0 && aliases != "" && (getline line < aliases) > 0) {
          sub(/#.*/, "", line)
          colon = index(line, ":")
          if (!colon || words(substr(line, 1, colon - 1), key) != 1 || !(key[1] in origin_of)) continue
          n = words(substr(line, colon + 1), list)
          for (i = 1; i <= n; i++) {
            term[++nterm] = list[i]
            origin[nterm] = origin_of[key[1]]
          }
        }
        if (nterm == 0) exit
      }
      { file = $0; scan() }
    ' | LC_ALL=C sort -t "$tab" -k1,1nr -k3,3n
)

if [ -z "$ranked" ]; then
  log_decision false 0 0 ""
  exit 1
fi

IFS="$tab" read -r top_score top_title _ top_line top_file _ <<<"$ranked"
if [ "$any" -eq 0 ] && [ "$top_title" -lt "$min_title_words" ]; then
  log_decision false "$top_score" "$top_title" "$top_file:$top_line"
  exit 1
fi
log_decision true "$top_score" "$top_title" "$top_file:$top_line"

echo "Runbook matches for: $question"
printf '%s\n' "$ranked" | awk -F'\t' -v any="$any" -v need="$min_title_words" -v max="$max_sections" '
  !any && $2 < need { next }
  ++n > max { exit }
  {
    printf "%d. %s:%d  § %s  (score %d)\n", n, $5, $4, ($6 == "" ? "(top of file)" : $6), $1
    k = split($7, lines, "\034")
    for (i = 1; i <= k; i++) if (lines[i] != "") print "   L" lines[i]
  }'
