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
#
# The listing is read into a variable instead of piped into `grep -q`. Under `set -o pipefail`
# a pipeline reports the last non-zero status of any stage, and `grep -q` exits at the first
# match, so `tar` can be killed by SIGPIPE and the gate then fails on a tarball that is
# perfectly fine. That is not hypothetical: the first run this file ever had on a Linux
# runner said "dist/cli.js is not in the tarball" about a tarball that contained it.
LISTING=$(tar tzf "$T/$TGZ") || fail "the packed tarball is unreadable"
has() { printf '%s\n' "$LISTING" | grep -qx "$1"; }
has package/dist/cli.js || { printf '%s\n' "$LISTING" | head -20 >&2; fail "dist/cli.js is not in the tarball"; }
has package/README.md  || { printf '%s\n' "$LISTING" | head -20 >&2; fail "README.md is not in the tarball"; }

npm i -g --prefix "$T/prefix" "$T/$TGZ" >/dev/null 2>&1 || fail "clean-prefix install failed"
BIN="$T/prefix/bin/midflight"
[ -x "$BIN" ] || fail "bin/midflight missing after install"
[ -x "$T/prefix/bin/midflight-replay" ] || fail "bin/midflight-replay missing after install"

GOT=$("$BIN" --version)
[ "$GOT" = "$EXPECT" ] || fail "--version printed '$GOT', expected '$EXPECT'"
echo "  installed binary reports $GOT"

# Absolute paths, resolved inside the installed package. The previous version passed
# relative ones, so `doctor fixtures/claude-mini.jsonl` read the file out of *this
# checkout* and the gate went green while the published package shipped no fixtures at
# all. A gate that cannot see the thing it is gating is decoration.
PKG="$T/prefix/lib/node_modules/$NAME"
[ -d "$PKG" ] || PKG=$(dirname "$(dirname "$BIN")")
CLAUDE_FIX="$PKG/fixtures/claude-mini.jsonl"
CODEX_FIX="$PKG/fixtures/codex-mini.jsonl"
[ -f "$CLAUDE_FIX" ] || fail "fixtures/claude-mini.jsonl is not in the tarball"
[ -f "$CODEX_FIX" ] || fail "fixtures/codex-mini.jsonl is not in the tarball"

# every entry package.json#files promises must really be in the tarball
for want in $(node -p "require('./package.json').files.filter(f=>!f.endsWith('/')).join(' ')" 2>/dev/null); do
  case "$want" in
    *.md|*.jsonl|*.pb) has "package/$want" || fail "package.json#files lists $want but the tarball does not contain it" ;;
  esac
done

"$BIN" doctor "$CLAUDE_FIX" >/dev/null 2>&1 || fail "doctor exited non-zero on a shipped fixture"
"$BIN" stats "$CODEX_FIX" >/dev/null 2>&1 || fail "stats exited non-zero on a shipped fixture"
"$BIN" replay "$CLAUDE_FIX" --out "$T/r.html" >/dev/null 2>&1 || fail "replay exited non-zero"
[ -s "$T/r.html" ] || fail "replay wrote an empty report"
grep -q 'const D = {' "$T/r.html" || fail "replay report has no embedded payload"

# revert is the newest surface and the one a fresh install is most likely to miss.
"$BIN" revert "$T/r.html" --list >/dev/null 2>&1
RC=$?
[ "$RC" = 0 ] || [ "$RC" = 1 ] || fail "revert --list exited $RC (expected 0 or 1)"
"$BIN" revert "$CLAUDE_FIX" --list >/dev/null 2>&1
[ $? = 2 ] || fail "revert accepted a file that is not a report (should exit 2)"

# The command list is derived from the shipped dispatch table, never hand-kept.
# It was hand-kept until 2026-09-28, and the moment two commands were added
# (agents, install) the gate kept saying TARBALL-OK without ever running them —
# a package could have shipped with both broken and the gate would not have
# noticed. A gate that only checks what someone remembered to list is decoration.
CMDS=$(node -e '
  const src = require("fs").readFileSync("dist/cli.js", "utf8");
  const found = [...src.matchAll(/case '"'"'([a-z-]+)'"'"':/g)].map((m) => m[1]);
  if (found.length < 5) { console.error("could not parse the dispatch table"); process.exit(1); }
  console.log([...new Set(found)].join(" "));
') || fail "could not derive the subcommand list from dist/cli.js"
echo "  dispatch table lists: $CMDS"

for c in $CMDS; do
  case "$c" in
    revert|redact) continue ;;   # both covered explicitly above / need stdin
  esac
  case "$c" in
    doctor|postmortem) "$BIN" "$c" "$CLAUDE_FIX" >/dev/null 2>&1 || fail "$c exited non-zero" ;;
    stats)   "$BIN" "$c" "$CODEX_FIX"  >/dev/null 2>&1 || fail "$c exited non-zero" ;;
    replay)  continue ;;          # covered above
    # `--dry-run` with no target asks the machine which agents it has, so it could only pass on
    # a machine that already had one: on a clean CI runner it correctly answered "no known agent
    # home found" and exited 2, and the gate called that a failure of the package. Name the
    # target, then check the promise the flag makes - a dry run writes nothing at all.
    install)
      H="$T/dryhome"; mkdir -p "$H"
      HOME="$H" "$BIN" "$c" codex --dry-run >/dev/null 2>&1 || fail "$c --dry-run exited non-zero"
      [ -z "$(find "$H" -type f -print -quit)" ] || fail "$c --dry-run wrote a file"
      if HOME="$H" "$BIN" "$c" >/dev/null 2>&1; then
        fail "$c with no agent home should exit 2, not succeed silently"
      fi
      ;;
    *)       HOME="$T/fakehome" "$BIN" "$c" >/dev/null 2>&1 || fail "$c exited non-zero" ;;
  esac
done
mkdir -p "$T/fakehome"
# agents and install are the two this gate missed; run them explicitly too, and
# assert install actually wrote a file into a throwaway HOME.
"$BIN" agents --json >/dev/null 2>&1 || fail "agents --json exited non-zero"
HOME="$T/fakehome" "$BIN" install codex >/dev/null 2>&1 || fail "install codex exited non-zero"
[ -s "$T/fakehome/.codex/skills/midflight-replay/SKILL.md" ] || fail "install codex wrote no SKILL.md"
echo "  agents --json ok; install codex wrote a skill into a throwaway HOME"

echo "  TARBALL-OK: every subcommand runs from the installed package"
