#!/usr/bin/env bash
# The one list of checks. CI runs this file, the pre-push hook runs this file, and
# `npm run acceptance` asserts against the same set. There is deliberately no second copy.
#
# Why one file: ci.yml used to hand-write `node dist/cli.js replay fixtures/...` while the
# local gate called npm scripts. Two lists drift, and the drift is invisible until the day
# CI is green and the release is broken. That is not hypothetical — verify-tarball.sh spent
# a whole release reading fixtures out of the checkout instead of the tarball.
#
# Usage: bash scripts/ci-checks.sh [--ci]     (--ci allows network, e.g. playwright install)
set -uo pipefail
cd "$(dirname "$0")/.."

CI=0
[ "${1:-}" = "--ci" ] && CI=1
fail=0
WORK=$(mktemp -d "${TMPDIR:-/tmp}/mf-ci-XXXXXX")
# no `rm -f`: it is rejected outright by the Codex exec policy on this machine, and a
# shipped script that a maintainer cannot run is a script that stops being run.
trap 'find "$WORK" -depth -delete 2>/dev/null || true' EXIT
step() { printf '\n--- %s\n' "$1"; }
ok()   { printf '  ok   %s\n' "$1"; }
bad()  { printf '  FAIL %s (rc=%s)\n' "$1" "$2"; fail=1; }
run()  { local name="$1"; shift
         local log="$WORK/$(printf '%s' "$name" | tr -c 'a-zA-Z0-9' '-').log"
         "$@" >"$log" 2>&1; local rc=$?
         if [ $rc -eq 0 ]; then ok "$name"
         else bad "$name" "$rc"; tail -n 6 "$log" | sed 's/^/       | /'; fi; }

step "install"
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then ok "dependencies present"
else run "npm ci" npm ci; fi

step "static"
run "typecheck"            npm run --silent typecheck
run "build"               npm run --silent build
run "unit tests"          npm test --silent
run "internal links"      npm run --silent check:links
run "README commands"     npm run --silent check:readme
run "README numbers"      npm run --silent check:claims

step "the shipped tarball"
run "pack + install + every subcommand" bash scripts/verify-tarball.sh

step "self-check on fixtures, no network, no workspace writes"
T="$WORK/reports"; mkdir -p "$T"
run "replay codex fixture"  node dist/cli.js replay fixtures/codex-mini.jsonl --out "$T/a.html"
run "replay claude fixture" node dist/cli.js replay fixtures/claude-mini.jsonl --out "$T/b.html"
run "replay script-escape"  node dist/cli.js replay fixtures/script-escape.jsonl --out "$T/c.html"
run "replay cursor fixture" node dist/cli.js replay fixtures/cursor-mini.jsonl --out "$T/d.html"
run "doctor json"           node dist/cli.js doctor fixtures/codex-mini.jsonl --json
# a truncated session must be rejected, and rejection is only a feature if it is non-zero
if node dist/cli.js doctor fixtures/codex-truncated.jsonl --json >/dev/null 2>&1; then
  bad "truncated session rejected" "accepted it"
else
  ok "truncated session rejected with non-zero exit"
fi

step "the front-page promise: the 60-second demo actually runs"
# The README's first section is a copy-paste. Until this ran in CI it was the one
# command on the page that nothing checked, which is exactly how a front page rots.
run "demo-60s.sh, bundled fixture" bash -c '
  D=$(mktemp -d "${TMPDIR:-/tmp}/mf-demo-XXXXXX")
  MIDFLIGHT_DEMO_OUT="$D/demo.html" bash scripts/demo-60s.sh >"$D/log" 2>&1
  rc=$?
  if [ $rc -ne 0 ]; then tail -5 "$D/log"; find "$D" -depth -delete; exit $rc; fi
  [ -s "$D/demo.html" ] || { echo "demo produced no file"; find "$D" -depth -delete; exit 1; }
  node dist/cli.js doctor "$D/demo.html" >/dev/null 2>&1 || true
  grep -q "const D = " "$D/demo.html" || { echo "demo output is not a midflight report"; find "$D" -depth -delete; exit 1; }
  echo "DEMO-OK $(wc -c <"$D/demo.html" | tr -d " ") bytes"
  find "$D" -depth -delete'

step "a real browser, on the reports the tool actually ships"
if [ ! -d node_modules/playwright ] && [ $CI -eq 1 ]; then
  run "install chromium" npx playwright install --with-deps chromium
fi
if [ -d node_modules/playwright ]; then
  run "browser acceptance (zero network requests, scrub, diffs)" bash -c '
    T=$(mktemp -d "${TMPDIR:-/tmp}/mf-br-XXXXXX")
    node dist/cli.js replay fixtures/codex-mini.jsonl    --out "$T/codex.html"    >/dev/null
    node dist/cli.js replay fixtures/claude-mini.jsonl  --out "$T/claude.html"   >/dev/null
    node dist/cli.js replay fixtures/script-escape.jsonl --out "$T/escape.html"  >/dev/null
    node dist/cli.js replay fixtures/cursor-mini.jsonl  --out "$T/cursor.html"   >/dev/null
    node dist/cli.js replay fixtures/windsurf-cascade-plaintext.pb --out "$T/windsurf.html" >/dev/null
    node dist/cli.js replay fixtures/codex-mini.jsonl --out "$T/thin.html" --max-steps 5 >/dev/null
    node scripts/browser-check.mjs "$T/codex.html" "$T/claude.html" "$T/escape.html" "$T/cursor.html" "$T/windsurf.html" "$T/thin.html"
    find "$T" -depth -delete 2>/dev/null || true'
  run "real host logs, both readable agents" npm run --silent smoke:browser:real
else
  printf '  skip browser checks (no playwright installed; CI installs it)\n'
fi

step "real agent logs on this machine (skips cleanly when there are none)"
run "real-log smoke" npm run --silent smoke:real:ci

step "release gates"
GATE_S="${GATE_S:-$HOME/.codex/skills/01-project-gigafactory/scripts}"
GATE_R="${GATE_R:-$HOME/.codex/gf-runs/artifacts/midflight-replay-release}"
if [ -f "$GATE_S/fast-gate.sh" ]; then
  run "fast-gate"  bash "$GATE_S/fast-gate.sh"  "$GATE_R"
  run "deai-check" bash "$GATE_S/deai-check.sh" "$GATE_R"
  run "bloat-check" bash "$GATE_S/bloat-check.sh" "$GATE_R"
else
  printf '  skip gigafactory gates (not present at %s; a maintainer machine has them)\n' "$GATE_S"
fi

echo
if [ $fail -eq 0 ]; then echo "CI-CHECKS-OK"; else echo "CI-CHECKS-FAILED"; fi
exit $fail
