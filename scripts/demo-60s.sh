#!/usr/bin/env bash
# Reproduce the README demo in under 60 seconds, from a fresh clone.
#
#   bash scripts/demo-60s.sh            # bundled fixture — always works, no setup
#   bash scripts/demo-60s.sh --self     # your own real agent sessions
#   bash scripts/demo-60s.sh --self <file.jsonl>
#
# Everything runs locally. No network, no telemetry, no account.
# Every number this script prints is measured on your machine at run time —
# nothing here is a claim copied from a benchmark.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="demo-60s.html"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }

T0=$(date +%s%N)

bold "1/3  build (TypeScript -> dist/, no bundler, no runtime deps)"
if [ ! -f dist/cli.js ]; then
  npm run build >/dev/null 2>&1 || { echo "build failed — run 'npm install' first" >&2; exit 1; }
fi
echo "    dist/cli.js ready"

bold "2/3  pick a session"
INPUT=""
if [ "${1:-}" = "--self" ]; then
  if [ -n "${2:-}" ] && [ -f "${2:-}" ]; then
    INPUT="$2"
  else
    # Largest real session log on this machine, newest hosts first.
    INPUT=$(ls -S "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl \
                 "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1 || true)
  fi
  if [ -z "$INPUT" ] || [ ! -f "$INPUT" ]; then
    echo "    no agent session log found under ~/.codex or ~/.claude" >&2
    echo "    falling back to the bundled fixture" >&2
    INPUT=""
  fi
fi
[ -n "$INPUT" ] || INPUT="fixtures/claude-mini.jsonl"

MB=$(du -m "$INPUT" | cut -f1)
echo "    $INPUT  (${MB} MiB)"

bold "3/3  replay"
START=$(date +%s%N)
node dist/cli.js replay "$INPUT" --out "$OUT" --json 2>/tmp/mfdemo-stats.json || true
END=$(date +%s%N)
MS=$(( (END - START) / 1000000 ))

SIZE=$(du -h "$OUT" | cut -f1)
echo
echo "  input        ${MB} MiB of raw JSONL"
echo "  output       $SIZE, one file, no sibling assets"
echo "  wall clock   ${MS} ms"
if [ -s /tmp/mfdemo-stats.json ]; then
  sed 's/^/  /' /tmp/mfdemo-stats.json | tr -d '\n' | sed 's/  */ /g'; echo
fi
TOTAL_MS=$(( ($(date +%s%N) - T0) / 1000000 ))
echo
if [ "$TOTAL_MS" -lt 1000 ]; then ELAPSED="${TOTAL_MS} ms"; else ELAPSED="$(( TOTAL_MS / 1000 )).$(( (TOTAL_MS % 1000) / 100 )) s"; fi
bold "done in $ELAPSED — open it:"
echo "  open $OUT            # macOS"
echo "  xdg-open $OUT        # Linux"
echo
echo "Scrub the timeline, click any step, expand a diff. The whole film is in that one file."
