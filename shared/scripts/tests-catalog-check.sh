#!/usr/bin/env bash
# tests-catalog-check.sh — the swarm-gate TESTS.md row: every test file a commit
# range added or changed is in its nearest TESTS.md, and the catalog was updated
# for it.
#
# Usage: tests-catalog-check.sh --since <ref> [--until <ref>]
#   Run from the repo root. Without --until, or with --until HEAD, the range
#   runs to the working tree, so uncommitted wave work and catalog lines count
#   (the row is filled before the wave's commit).
#
# Tools: bash, git, grep, sed, sort, basename/dirname — no jq, no rg.
#
# Test files: *_test.*, *.test.*, *.spec.*, test_*.*, test-*.{sh,py,ts,js},
# files under a tests?/ dir, and source files whose diff adds a line carrying
# an inline test: a Rust test attribute, `def test_`, `func TestX`, or an
# `it(` / `test(` / `describe(` call. Deleted files are skipped.
#
# Per test file, looked up in the nearest ancestor TESTS.md by basename:
#   ok: <file> (<catalog>)              — catalogued, catalog line added this range
#   not-updated: <file> (<catalog>)     — catalogued before; no line added for it
#                                         this range (advisory: new tests in an
#                                         already-listed file are uncatalogued)
#   not-in-catalog: <file> (<catalog>)  — blocking
#   no-catalog: <file>                  — no TESTS.md above it; blocking
#
# Exit: 0 no blocking rows, 1 any blocking row, 2 bad args.

set -uo pipefail

since="" until=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) since="${2:-}"; shift 2 ;;
    --until) until="${2:-}"; shift 2 ;;
    *) echo "tests-catalog-check: unknown arg: $1" >&2; exit 2 ;;
  esac
done
[ -n "$since" ] || { echo "tests-catalog-check: --since required" >&2; exit 2; }
# Each ref reaches `git diff` as a revision, where one starting with `-` would be read
# as an option (`--output=<file>` writes a file): refuse it before git sees it.
for ref in "$since" "$until"; do
  case "$ref" in -*) echo "tests-catalog-check: $ref is not a git ref" >&2; exit 2 ;; esac
done

range=("$since")
[ -n "$until" ] && [ "$until" != "HEAD" ] && range=("$since" "$until")

name_re='(_test|\.test|\.spec)\.[A-Za-z]+$|(^|/)test_[^/]*\.[A-Za-z]+$|(^|/)test-[^/]*\.(sh|py|ts|js)$|(^|/)tests?/[^/]+\.[A-Za-z]+$'
inline_re='^\+.*(#\[(test|tokio::test|cfg\(test\))\])|^\+[[:space:]]*(def test_|func Test[A-Z]|(it|test|describe)\()'

nearest_catalog() { # <file> → path of nearest ancestor TESTS.md, or empty
  local d
  d=$(dirname "$1")
  while :; do
    [ -f "$d/TESTS.md" ] && { printf '%s\n' "${d#./}/TESTS.md" | sed 's|^\./||; s|^/||'; return; }
    [ "$d" = "." ] || [ "$d" = "/" ] && return
    d=$(dirname "$d")
  done
}

files=$(git diff --name-only --diff-filter=d "${range[@]}" 2>/dev/null)
# Working-tree range: new files not yet added are wave work too.
[ "${#range[@]}" -eq 1 ] && files+=$'\n'$(git ls-files --others --exclude-standard 2>/dev/null)
files=$(printf '%s\n' "$files" | sed '/^$/d' | sort -u)

targets=""
while IFS= read -r f; do
  [ -n "$f" ] || continue
  if [[ "$f" =~ $name_re ]]; then
    targets+="$f"$'\n'
  elif [[ "$f" != *.md ]] && git diff "${range[@]}" -- "$f" 2>/dev/null | grep -qE "$inline_re"; then
    targets+="$f"$'\n'
  fi
done <<<"$files"

blocking=0
while IFS= read -r t; do
  [ -n "$t" ] || continue
  key=$(basename "$t")
  catalog=$(nearest_catalog "$t")
  if [ -z "$catalog" ]; then echo "no-catalog: $t"; blocking=1; continue; fi
  if ! grep -qF "$key" "$catalog"; then echo "not-in-catalog: $t ($catalog)"; blocking=1; continue; fi
  # A catalog absent at --since is new this range: every line in it is added.
  if ! git cat-file -e "$since:$catalog" 2>/dev/null \
     || git diff "${range[@]}" -- "$catalog" 2>/dev/null | grep -E '^\+' | grep -qF "$key"; then
    echo "ok: $t ($catalog)"
  else
    echo "not-updated: $t ($catalog)"
  fi
done < <(printf '%s' "$targets" | sort -u)

exit "$blocking"
