#!/usr/bin/env bash
# The three sample outputs the README tells a visitor to open are committed files, which
# is the only reason a stranger can click "open one" with nothing installed. Nothing
# regenerated them: the postmortem panel shipped, and the samples kept showing a UI from
# before it. A committed artifact nobody rebuilds is a screenshot with extra steps.
#
#   bash scripts/demo-samples.sh          check: regenerate into a temp dir, compare
#   bash scripts/demo-samples.sh --write  refresh the committed files
#
# Both outputs are byte-deterministic (no build time, no run time in the payload), so
# "stale" is a real signal and not a clock artefact.
set -euo pipefail
cd "$(dirname "$0")/.."

CODEX=fixtures/codex-mini.jsonl
CLAUDE=fixtures/claude-mini.jsonl

generate() { # $1 = destination dir
  mkdir -p "$1"
  # The CLI reports success on stderr; a build step that narrates is noise in a gate log.
  node dist/cli.js replay "$CODEX"   --out "$1/demo-codex.html"        >/dev/null 2>&1
  node dist/cli.js replay "$CLAUDE"  --out "$1/demo-claude.html"       >/dev/null 2>&1
  node dist/cli.js replay "$CLAUDE"  --paste > "$1/demo-claude-paste.html" 2>/dev/null
}

if [ "${1:-}" = "--write" ]; then
  T=$(mktemp -d "${TMPDIR:-/tmp}/mf-demo-XXXXXX")
  generate "$T"
  for f in demo-codex.html demo-claude.html demo-claude-paste.html; do
    cp "$T/$f" "docs/$f"
  done
  find "$T" -depth -delete
  echo "DEMO-SAMPLES-WROTE 3 files under docs/"
  exit 0
fi

T=$(mktemp -d "${TMPDIR:-/tmp}/mf-demo-XXXXXX")
trap 'find "$T" -depth -delete' EXIT
generate "$T"
stale=0
for f in demo-codex.html demo-claude.html demo-claude-paste.html; do
  if ! cmp -s "$T/$f" "docs/$f"; then
    echo "  STALE docs/$f — regenerating it now would change $(wc -c <"docs/$f" | tr -d ' ')B into $(wc -c <"$T/$f" | tr -d ' ')B"
    stale=1
  fi
done
[ "$stale" -eq 0 ] && echo "DEMO-SAMPLES-OK 3 files match the current build" || { echo "run: bash scripts/demo-samples.sh --write"; exit 1; }
