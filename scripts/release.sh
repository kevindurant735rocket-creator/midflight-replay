#!/usr/bin/env bash
# One-shot launch for midflight-replay. Dry-run unless --yes is passed.
#
#   bash scripts/release.sh                     # print every step, mutate nothing
#   bash scripts/release.sh --yes               # GitHub + npm
#   bash scripts/release.sh --yes --no-npm      # GitHub only (hold npm until 'npm login')
#   bash scripts/release.sh --yes --npm-only    # npm only (GitHub already done)
#
# Why a script and not the copy-paste block in docs/RELEASE.md: that block is six
# irreversible commands spread over forty lines. Dry-run as the DEFAULT is the
# difference between "read the docs" and "verified".
set -euo pipefail

YES=0; DO_GH=1; DO_NPM=1
for arg in "$@"; do
  case "$arg" in
    --yes)      YES=1 ;;
    --no-npm)   DO_NPM=0 ;;
    --npm-only) DO_NPM=1; DO_GH=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
OWNER=${OWNER:-kevindurant735rocket-creator}
REPO="$OWNER/$NAME"

run() { printf '  $ %s\n' "$*"; if [ "$YES" = 1 ]; then "$@"; else printf '    [dry-run] skipped\n'; fi; }

echo "== preflight =="
gh auth status >/dev/null 2>&1 || { echo "FAIL: gh not authenticated" >&2; exit 1; }
echo "  gh auth ok ($(gh api user --jq .login))"
[ -z "$(git status --porcelain)" ] || { echo "FAIL: working tree dirty — commit first" >&2; exit 1; }
echo "  working tree clean, $(git rev-list --count HEAD) commits at $(git log -1 --format=%h)"

echo "== GitHub: $REPO =="
if [ "$DO_GH" = 0 ]; then
  echo "  skipped (--npm-only)"
else
  if gh repo view "$REPO" >/dev/null 2>&1; then
    echo "  repo exists"
  else
    run gh repo create "$REPO" --public --description \
      "Forensic replay for AI coding agents — turn a session log into one self-contained HTML timeline. Zero dependencies, zero network."
  fi
  run git push -u origin main
  run gh repo edit "$REPO" --add-topic ai-agent --add-topic agent-tracing \
    --add-topic observability --add-topic code-review --add-topic forensic \
    --add-topic visualization --add-topic session-log --add-topic claude-code \
    --add-topic codex --add-topic static-analysis --add-topic developer-tools \
    --add-topic debugging
  echo "  seed issues (file these by hand — see docs/ISSUES/):"
  for f in docs/ISSUES/*.md; do
    [ -e "$f" ] || continue
    echo "    gh issue create --repo $REPO --title \"$(head -1 "$f" | sed 's/^# //')\" --body-file $f"
  done
  run git tag -a "v$VERSION" -m "$NAME $VERSION"
  run git push origin "v$VERSION"

  # Ship one real 100+ MB replay as a downloadable asset. It is the cheapest
  # possible refutation of "this is a mock" — open the file, no install needed.
  run mkdir -p .release-assets
  SAMPLE=$(ls -S "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -1 || true)
  if [ -n "$SAMPLE" ]; then
    run node dist/cli.js replay "$SAMPLE" --out .release-assets/codex-109mb-report.html
  else
    echo "  no Codex session log found — releasing without the sample asset"
  fi
  ASSET_ARGS=()
  if [ -f .release-assets/codex-109mb-report.html ]; then
    ASSET_ARGS=(.release-assets/codex-109mb-report.html#codex-109mb-session-replay.html)
  fi
  run gh release create "v$VERSION" --repo "$REPO" \
    --title "v$VERSION — forensic replay for AI coding agents" --notes-file CHANGELOG.md \
    ${ASSET_ARGS[@]+"${ASSET_ARGS[@]}"}
fi

echo "== npm =="
if [ "$DO_NPM" = 0 ]; then
  echo "  skipped (--no-npm)"
elif ! npm whoami >/dev/null 2>&1; then
  echo "  SKIP: npm not logged in. Run 'npm login', then: bash scripts/release.sh --yes --npm-only" >&2
else
  echo "  publishing as $(npm whoami)"
  # `npm publish` cannot be undone for 72h, and prepublishOnly runs in this checkout,
  # never against the layout the registry serves. So prove the tarball first. This is
  # not ceremony: it is the gate that caught patches `git apply` could not place.
  if bash scripts/verify-tarball.sh "$VERSION"; then
    :
  else
    echo "  REFUSING TO PUBLISH: the tarball did not survive a clean install." >&2
    exit 1
  fi
  run npm publish --access public
  run npm view "$NAME" version
fi

echo
[ "$YES" = 1 ] && echo "DONE" || echo "DRY-RUN ONLY — nothing changed. Re-run with --yes."
