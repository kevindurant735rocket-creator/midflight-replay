#!/usr/bin/env bash
# Prove the tarball a release would publish actually works, before it is published.
#
# `npm publish` is irreversible for 72 hours, and `prepublishOnly` runs in this
# checkout — it never sees the file layout the registry will serve. A package can
# therefore pass every gate here and still install broken. So: pack, install into
# a clean prefix, and run every subcommand from the installed binary.
#
# This exists because it already caught a real bug: diffs within three lines of
# end-of-file produced patches `git apply` refused, and no test in the checkout
# could see it, because the checkout is not what npm serves.
#
# Usage: bash scripts/verify-tarball.sh [expected-version]
# Exit 0 = the tarball is good. Non-zero = do not publish.
set -uo pipefail

EXPECT="${1:-$(node -p "require('./package.json').version")}"
NAME=$(node -p "require('./package.json').name")
T=$(mktemp -d "${TMPDIR:-/tmp}/midflight-tarball-XXXXXX") || exit 1
fail() { echo "  FAIL: $*" >&2; find "$T" -depth -delete 2>/dev/null; exit 1; }
trap 'find "$T" -depth -delete 2>/dev/null' EXIT

echo "== tarball gate: $NAME@$EXPECT =="

TGZ=$(npm pack --pack-destination "$T" 2>/dev/null | tail -1)
[ -n "$TGZ" ] && [ -f "$T/$TGZ" ] || fail "npm pack produced nothing"
echo "  packed $TGZ ($(du -h "$T/$TGZ" | cut -f1))"

# The registry serves exactly this file list. dist must be in it, or the bin is a dead path.
tar tzf "$T/$TGZ" | grep -q '^package/dist/cli.js$' || fail "dist/cli.js is not in the tarball"
tar tzf "$T/$TGZ" | grep -q '^package/README.md$' || fail "README.md is not in the tarball"

npm i -g --prefix "$T/prefix" "$T/$TGZ" >/dev/null 2>&1 || fail "clean-prefix install failed"
BIN="$T/prefix/bin/midflight"
[ -x "$BIN" ] || fail "bin/midflight missing after install"
[ -x "$T/prefix/bin/midflight-replay" ] || fail "bin/midflight-replay missing after install"

GOT=$("$BIN" --version)
[ "$GOT" = "$EXPECT" ] || fail "--version printed '$GOT', expected '$EXPECT'"
echo "  installed binary reports $GOT"

"$BIN" doctor fixtures/claude-mini.jsonl >/dev/null 2>&1 || fail "doctor exited non-zero on a real fixture"
"$BIN" stats fixtures/codex-mini.jsonl >/dev/null 2>&1 || fail "stats exited non-zero on a real fixture"
"$BIN" replay fixtures/claude-mini.jsonl --out "$T/r.html" >/dev/null 2>&1 || fail "replay exited non-zero"
[ -s "$T/r.html" ] || fail "replay wrote an empty report"
grep -q 'const D = {' "$T/r.html" || fail "replay report has no embedded payload"

# revert is the newest surface and the one a fresh install is most likely to miss.
"$BIN" revert "$T/r.html" --list >/dev/null 2>&1
RC=$?
[ "$RC" = 0 ] || [ "$RC" = 1 ] || fail "revert --list exited $RC (expected 0 or 1)"
"$BIN" revert fixtures/claude-mini.jsonl --list >/dev/null 2>&1
[ $? = 2 ] || fail "revert accepted a file that is not a report (should exit 2)"

echo "  TARBALL-OK: every subcommand runs from the installed package"
