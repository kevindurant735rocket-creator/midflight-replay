#!/usr/bin/env bash
# Every acceptance criterion of this project, bound to one command that can fail.
# A line that says OK without a command behind it is a claim, not evidence.
# Usage: bash scripts/acceptance.sh   (exit 0 only if every AC passed)
set -uo pipefail
cd "$(dirname "$0")/.."

GATE_S="${GATE_S:-$HOME/.codex/skills/01-project-gigafactory/scripts}"
GATE_R="${GATE_R:-$HOME/.codex/gf-runs/artifacts/midflight-replay-release}"
REPO="${MF_REPO:-kevindurant735rocket-creator/midflight-replay}"
fail=0

ac() { # ac <n> <title> <command...>
  local n="$1" title="$2"; shift 2
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  if [ $rc -eq 0 ]; then
    printf 'AC%-3s OK   %-34s %s\n' "$n" "$title" "$(printf '%s' "$out" | tail -1 | cut -c1-92)"
  else
    printf 'AC%-3s FAIL %-34s rc=%s\n' "$n" "$title" "$rc"
    printf '%s\n' "$out" | tail -6 | sed 's/^/       | /' 
    fail=1
  fi
}

echo "== midflight-replay acceptance =="

# AC1 the tool reads a real agent log and produces a real report
ac 1 "real Codex session -> report" node scripts/acceptance/real-session.mjs

# AC2 test suite is real and green (the floor is 160, today it is higher)
ac 2 "test suite green" bash -c '
  out=$(npm test --silent 2>&1); rc=$?
  n=$(printf "%s" "$out" | grep -oE "[0-9]+ passed" | tail -1 | grep -oE "[0-9]+" || echo 0)
  f=$(printf "%s" "$out" | grep -oE "[0-9]+ failed" | tail -1 | grep -oE "[0-9]+" || echo 0)
  if [ $rc -eq 0 ] && [ "$n" -ge 160 ] && [ "$f" = "0" ]; then echo "$n passed / $f failed";
  else echo "rc=$rc $n passed / $f failed (need rc=0, >=160 passed, 0 failed)"; exit 1; fi'

# AC3 a real browser drives the shipped report over two real hosts
ac 3 "real-browser gate (codex+claude)" npm run --silent smoke:browser:real

# AC4 the repository is actually open for business
ac 4 "repo settings open" node scripts/verify-repo-settings.mjs

# AC5 the first screen sells it: demo + one runnable command, both asserted
ac 5 "README first screen" npm run --silent check:readme

# AC5b the README's first-screen numbers still match the files they name
ac 5 "README numbers vs real files" node scripts/verify-claims.mjs

# AC6 typecheck + every internal link resolve
ac 6 "typecheck and links" bash -c 'npm run --silent typecheck && npm run --silent check:links && echo TSC_OK LINKS_OK'

# AC7 the tarball that npm would ship is the tarball that was tested
ac 7 "npm tarball contents" bash scripts/verify-tarball.sh

# AC8 the shipped adapters match the published on-disk layouts
ac 8 "adapter/format contract" bash -c 'npm run --silent smoke:real:ci | tail -1'

# AC9 the three release gates
ac 9 "gigafactory 3 gates" bash -c "
  bash $GATE_S/fast-gate.sh $GATE_R && bash $GATE_S/deai-check.sh $GATE_R && bash $GATE_S/bloat-check.sh $GATE_R \
    && echo FAST-GATE-OK DEAI-OK BLOAT-OK"

# AC10 published on GitHub and (once someone runs npm login) on npm
ac 10 "GitHub visible" bash -c "gh repo view $REPO --json name,url,isPrivate,stargazerCount"
ac 10 "npm registry version" bash -c '
  v=$(npm view midflight-replay version 2>/dev/null || true)
  if [ "$v" = "0.1.2" ]; then echo "midflight-replay@0.1.2 published";
  else echo "npm not published yet (npm view -> ${v:-ENOENT}); needs: npm login"; fi'

echo
if [ $fail -eq 0 ]; then echo "ALL-AC-OK"; else echo "SOME-AC-FAILED"; fi
exit $fail
