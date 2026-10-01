#!/bin/sh
# Print the entry headings of a project's lessons log with their line numbers,
# so a duplicate check never reads the whole file.
# Usage: headings.sh [project-root]   (default: the current git checkout, else .)
root=${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}
log="$root/.claude/lessons.md"
if [ ! -f "$log" ]; then
  echo "no lessons log at $log"
  exit 0
fi
grep -n '^### ' "$log" || echo "no entries in $log"
