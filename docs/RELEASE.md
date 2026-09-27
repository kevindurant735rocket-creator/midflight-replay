# Release runbook

Every command below has been run on this machine. Copy-paste in order; each block
ends with the exit code you should see.

**Naming is resolved. Every row below was measured, not assumed — and the first
draft of this file was wrong, so re-run the probe before you trust it again.**

| name | npm | github.com | verdict |
|---|---|---|---|
| `midflight` | `404` **free** | `404` | legal, but a bare adjective — `gh search midflight` returns a wall of ad/telemetry repos, and the repo name alone tells a browser nothing |
| `agent-replay` | `200` — v0.1.1, *"DevTools for replaying AI agent sessions"* | free, but **25+ repos share the exact name** | unusable on npm (a direct competitor owns it), and legal-but-invisible on GitHub |
| `flightrec` | `200` — v0.9.0, *"A flight recorder for Codex sessions"* | `404` | unusable on npm, also a direct competitor |
| **`midflight-replay`** | **`404`** | **`404`** | **chosen** — free on both, and the name states what the thing is |

Measured 2026-09-27 21:10 by HTTP status, not by memory:

| probe | result |
|---|---|
| `curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/<name>` | `midflight` 404 · `agent-replay` 200 · `flightrec` 200 · `midflight-replay` 404 |
| `curl -sL -o /dev/null -w '%{http_code}' https://github.com/kevindurant735rocket-creator/<name>` | all four 404 |

An earlier draft of this table claimed `midflight` returned `200` with zero versions.
That was wrong; it is `404`, i.e. free. It was still not chosen, but for a
different reason than the one printed above: **discoverability**, not availability.
Re-probe the four names on the day you publish and expect `midflight-replay` to be
the only one still 404 on both sides.

So: **repo = npm package = `midflight-replay`**, and the **binary stays `midflight`**.
The CLI and the package deliberately differ, the same way `@angular/cli` ships `ng`;
the README Install section says so in one line so nobody files "why don't these match".

Re-probe before publishing (as of 2026-09-27, `midflight` and `midflight-replay`
are the two 404s on npm; the other two are taken):

```bash
for n in midflight agent-replay flightrec midflight-replay; do
  echo -n "npm/$n  "; curl -s -o /dev/null -w "%{http_code}\n" "https://registry.npmjs.org/$n"
  echo -n "gh/$n   "; curl -s -o /dev/null -w "%{http_code}\n" -L "https://github.com/kevindurant735rocket-creator/$n"
done
# 200 on npm means someone else owns it -> publishing fails with EPUBLISHCONFLICT.
# Stop here if midflight-replay is not 404 on both lines.
```

---

## 0. Pre-flight (no network, no side effects)

```bash
cd ~/Desktop/项目/agent-replay
npm ci
npm run typecheck        # exit 0
npx vitest run           # 57 passed
npm run build            # exit 0
node dist/cli.js doctor fixtures/codex-mini.jsonl --json      # exit 0
node dist/cli.js doctor fixtures/codex-truncated.jsonl --json  # exit 1  (negative test)
```

## 1. Prove it on your own logs before anyone else sees it

```bash
# Codex — the 109 MB session
node dist/cli.js replay ~/.codex/sessions/2026/09/23/rollout-2026-09-23T16-24-08-*.jsonl \
  --out /tmp/mf-codex.html
# → steps 3716/14905  coverage=diff-only

# Claude Code
node dist/cli.js replay ~/.claude/projects/-Users-*/88095c95-*.jsonl --out /tmp/mf-claude.html
# → steps 3000/3111   coverage=partial  unknown=0  compaction=10

open /tmp/mf-codex.html     # drag the axis, click a step, check the header badges
```

Sanity-check the two claims the README makes, yourself, on your own machine:

```bash
grep -c old_string ~/.codex/sessions/2026/09/23/rollout-2026-09-23T16-24-08-*.jsonl   # expect 0
```

If that is not `0` on your log, your coverage verdict will differ from ours. The
tool tells the truth about *your* log, not about the one in the README.

## 2. Browser assertions (the "zero network" claim is only worth what it is tested against)

```bash
node scripts/browser-check.mjs /tmp/mf-codex.html /tmp/mf-claude.html   # 60 passed, 0 failed
node scripts/browser-check.mjs docs/demo-claude.html docs/demo-codex.html  # 58 passed, 0 failed
```

Both must end `0 failed` and include `ok   no requests fired during interaction`.

## 3. Create the repo and push

```bash
gh auth status                 # expect: logged in, scopes gist, read:org, repo
gh repo create kevindurant735rocket-creator/midflight-replay \
  --public --description "Turn a finished AI coding-agent session into a single scrubbable HTML file you can attach to a PR." \
  --source . --remote origin --push
```

If the repo name is taken, stop and pick another — do **not** silently rename the npm
package to match, and do not rename the repo to `midflight` without also updating
`package.json`'s `repository` / `homepage` / `bugs` blocks, which all point at
`kevindurant735rocket-creator/midflight-replay`.

Enable these on the repo after push:

- **Topics** (this is what `gh api` and GitHub search read):
  `agent`, `ai`, `llm`, `observability`, `postmortem`, `replay`, `forensics`,
  `developer-tools`, `cli`, `codex`, `claude`, `session-log`, `pr-review`
- **Social preview** — `docs/images/replay-claude.png` is already 880px wide and
  is the first image in the README, so it renders correctly as the preview.

## 4. Tags and release

```bash
git tag -a v0.1.0 -m "midflight 0.1.0 — forensic replay for AI coding agents"
git push origin v0.1.0
gh release create v0.1.0 --title "v0.1.0" --notes-file CHANGELOG.md
```

## 5. npm

```bash
npm pack --dry-run           # expect: 49.5 kB, 29 files, CHANGELOG.md + README.md + LICENSE present
npm whoami                   # must be an account that owns the `midflight` name
npm publish --access public
npm view midflight version   # must print 0.1.0
```

Post-publish smoke test, from a clean directory — this is the only test that proves
`npx` works for a stranger:

```bash
cd /tmp && npx -y midflight@0.1.0 doctor ~/Desktop/项目/agent-replay/fixtures/codex-mini.jsonl
```

## 6. The 24 hours after

Watch for the three failure modes that actually cost stars, in this order:

1. **`npx midflight` fails** — almost always a missing `dist/` in the tarball, or a
   lost shebang. Re-check `npm pack --dry-run` and `head -1 dist/cli.js`.
2. **The README's numbers are quoted back at you as universal** — they are measured
   on *one* log. Anyone who disputes them should be told to run `doctor` on their own.
   That argument is a feature; do not defend the number, point at the command.
3. **Nobody pastes the HTML** — the most likely friction is GitHub stripping
   something. `--paste` exists for exactly this. If someone reports it, the answer is
   `assertPasteSafe`, not a workaround.
