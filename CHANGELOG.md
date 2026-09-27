# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-09-27

First public release. Parses real Codex and Claude Code session logs and turns
them into a single scrubbable HTML file.

### Added

- **`replay`** — one self-contained HTML file: no server, no CDN, no build, no
  network request at any point after generation. Verified in a real browser:
  `58 passed, 0 failed` assertions, including "no requests fired during
  interaction".
- **`replay --paste`** — a GitHub-safe digest. Only `details / summary / table /
  pre / code / div`; machine-asserted zero `<script>`, zero `<style>`, zero
  `on*=` handlers, zero external references. Sections drop in reverse priority
  order under a byte budget, and the block says how many were dropped.
- **`doctor`** — non-destructive inspection: adapter detection, step counts by
  kind, parse errors by line number, `unknownSteps`. Exits non-zero on a bad log.
- **Adapters** for Codex rollout JSONL and Claude Code project JSONL.
- **Honest coverage bar** — `full` / `partial` / `diff-only` / `no-edits`, with
  the reason printed next to it instead of an empty diff and no explanation.
- **Unclassified-step disclosure** — session-metadata steps the adapter cannot
  classify are counted in the header and named, so `unknown` never reads as a
  broken parser. Guarded on a truthy count: clean sessions stay silent.
- **Context accounting** — cumulative token track, compaction markers, and a
  count of unexplained context drops.
- **Redaction** — home directories, SSH paths, API keys, emails. The report says
  which rules fired and how many times, never the value. `--no-redact` opts out.
- **CI** on Node 20 and 22, running `doctor` against both a valid and a
  deliberately corrupted fixture.

### Also enforced in CI

- **Browser acceptance is now a CI job** (`browser` in `.github/workflows/ci.yml`),
  not a local claim: it installs Chromium and asserts 58 assertions per run,
  including "no network request fired during interaction". The zero-network
  property is the product, so it gets a job instead of a paragraph.
- **Both binaries are published**: `midflight` and `midflight-replay`, so
  `npx midflight-replay …` works whether you remember the short name or the
  package name.

### Measured on real logs

| Session | Size | Parse | Output | Steps | Coverage |
|---|---|---|---|---|---|
| Codex rollout | 109 MB | 379 ms | 3.24 MB | 3,716 / 14,905 | `diff-only` — 1,720 shell-carried mutations, 0 before-images |
| Claude Code | 31 MB | 123 ms | 2.05 MB | 3,000 / 3,622 | `partial` — 244 edits, 127 with before-image |

The 109 MB file peaked at 273 MB RSS (`286,736,384` bytes) — it is streamed
line-by-line and never held in memory whole. Both rows are reproducible with the
commands printed beneath the table in the README.

### Non-goals for 0.1.0

- Not a live dashboard. midflight is forensic: it reads a session that already
  ended.
- Not a PR bot. No GitHub App, no CI integration, no comment posting.
- Not an agent-instrumentation layer. There is no hook and no wrapper, which is
  exactly why it cannot report anything the log does not contain.

[0.1.0]: https://github.com/kevindurant735rocket-creator/midflight-replay/releases/tag/v0.1.0
