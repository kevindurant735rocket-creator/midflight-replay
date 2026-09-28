# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **`midflight agents` — fleet-level detection, measured on the machine it runs on.**
  `midflight doctor` answered "is THIS file parseable" and nothing answered "which agents
  do I have, and which of those can you read?". `src/agents.ts` walks 11 known host stores
  (`~/.codex/sessions`, `~/.claude/projects`, `~/.cursor`, `~/.gemini`, opencode,
  Copilot CLI, Aider, Continue, Cline, Windsurf, Factory Droid) and reports per host:
  status, real file count, real bytes, newest log date. `--probe` parses the newest log of
  every readable host, so "readable" means this file parsed just now.
  A host whose store exists but has no adapter is printed with its file count and the
  reason, per the KNOWN-GAPS rule that a gap you can see beats a gap you cannot.
  Measured on the machine that built it: `2 of 3 installed agents readable`, Cursor
  reported as `no adapter (1 file found)`, newest Codex log 2269 steps / 0 parse errors.

- **`midflight install <agent>|--all` — one file, into whichever agent you run.**
  The "works inside my agent" claim had no installation surface at all: no skill, no
  hook, no MCP server, no plugin. `src/install.ts` writes a single `SKILL.md` into the
  host's own skills or rules directory, with frontmatter shaped per host
  (`name`+`description` for Codex/Claude Code/opencode/Gemini, `description`-only for
  Cursor, none for Copilot prompts) and a test locking that mapping. Deliberately not a
  hook or a wrapper: midflight reads the log the agent already writes, so there is
  nothing to intercept, and a wrapper around a long-running session is one more thing
  that can break it. It writes nothing without being asked, is idempotent, refuses to
  overwrite a different file without `--force`, and every command named inside the skill
  is asserted to exist in the same build.

### Added

- **`npm run smoke:real` — the parser checked against every real session on the machine.**
  Aimed at the gap the fix below exposed: 135 fixture tests were green while three real
  sessions were silently mis-parsed. It walks `~/.claude/projects` and `~/.codex/sessions`,
  parses everything it finds, and fails on the first mis-parse. `REAL-LOG-SKIP` (exit 0)
  when the machine has no agent logs. `npm run smoke:real:ci` caps it at the 40 largest
  rollouts for CI. It is wired into `.github/workflows/ci.yml`, and it was falsified
  before it was trusted: against the pre-fix parser it reports
  `REAL-LOG-FAIL: 3 of 886`, against the fixed one `REAL-LOG-OK n=886`.

### Fixed

- **A valid Codex rollout was reported as corrupt.** `node:readline` — the line reader
  behind every session parse — also breaks on `U+2028` LINE SEPARATOR and `U+2029`
  PARAGRAPH SEPARATOR, which RFC 8259 permits unescaped inside a JSON string. One such
  character inside a tool output split a record in three, and all three fragments then
  failed `JSON.parse`. `readLines` now splits on byte `0x0A` only, and does it on Buffers
  so a multi-byte character split across a 64 KiB read boundary is reassembled rather than
  truncated. Measured on the real 114 MiB session that exposed it: **30 phantom parse
  errors, `ok: false` → `ok: true`, and one step recovered that was being dropped** (the
  fragment carrying the rest of that record). Same file, 30 736 physical lines before and
  after — only the reader changed. 6 regression tests lock it.

### Added

- **`postmortem` — counts loops, repeated edits, and context pressure.** The last
  thing the roadmap promised, now shipped and measured on a real session.
  `midflight postmortem <session.jsonl> [--json]`, and it exits 0 even when it finds
  something: a loop in your session is a fact, not a parse error.
  - **Loops** — the same tool with byte-identical arguments, `LOOP_RUN_MIN` (3)
    times in a row among tool calls. On a real 110 MiB Codex session from this
    machine: 14 findings, the worst a poll that ran **9 times** with the arguments
    unchanged.
  - **Repeated edits** — a file edited `REPEAT_EDIT_MIN` (3) or more times, with the
    share of the session by step count. `file_event` steps count; deletes do not,
    because a file removed three times is not churn.
  - **Near-full context** — peak occupancy at or above `NEAR_FULL_FRACTION` (0.85)
    of the reported window, plus first-hand compaction events.
  - **The same panel is in the report**, under the coverage bar. Every finding is a
    clickable row that jumps the timeline to the step that started it — a reviewer's
    first question about an agent's work is "what went wrong", and the report used to
    only answer "when". It is computed on the *thinned* timeline so every row points
    at a step that exists in that file; KNOWN-GAPS §7 says so, and says which of the
    two commands to trust for the full count.
  - 18 tests. Thresholds are exported constants, not inline numbers, so a reader can
    argue with the bar instead of trusting it.
  - 4 new browser assertions, one of which caught the first version of the panel
    rendering findings that no click could reach.

- **`postmortem` found a bug in itself, before anyone else could.** Occupancy was
  first computed as `input + cachedInput`, which double counts (cached tokens are a
  subset of input on both hosts) and printed a real session at "263.6% of the
  window". Fixed to `input` alone. When input exceeds the host's own declared
  window — a real session reports 322,441 tokens against a 243,200-token window —
  the tool now prints the raw tokens and marks the ratio as a floor instead of
  printing a percentage above 100% as though it were a measurement. Two tests lock
  both halves of that.

### Added

- **`midflight revert` — the report's inverse.** Given a report and a step index, it
  prints one unified diff that undoes that step, ready for `git apply -R`:

  ```
  midflight revert replay.html --list                    # which steps can be undone
  midflight revert replay.html --step 42 --out p.diff   # write the patch
  git apply --check -R p.diff                           # verify
  ```

  It never writes to the working tree. The only command that does is `git apply`,
  which stays yours, after you have read the patch. `--list` needs nothing but the
  report file, so it works for a colleague who does not have your checkout.

  **Both sides of the hunk are whole files, never fragments.** An `old_string` /
  `new_string` pair from a log is a fragment: rendered alone it yields `@@ -1,1 @@`
  with no context and no true line number, and `git apply --check` fails to place it
  even though the edit is real. So the before-state comes from the host's own backup
  when file-history linked one ([P0-1](#unreleased)), otherwise from the log's
  `old_string` substituted back into the file as it stands, and the after-state is the
  file as it is on disk right now — which is the state the patch has to apply to.

  It **refuses loudly, non-zero**, instead of emitting something that looks like a
  revert: `NO_BEFORE_IMAGE` (no before-image at all), `TREE_DIVERGED` (the file no
  longer contains what the step wrote, or contains it more than once), `TREE_UNREADABLE`
  (the target is gone), `EMPTY_DIFF` (before and after are identical). Reverting a
  reconstruction is a way to lose work; a tool that says "no" is worth more than one
  that guesses.

  Verified end to end against a real git repository: a real session log → real report →
  `revert --step` → `git apply --check -R` exits 0 → `git apply -R` restores the file
  byte for byte. 17 tests cover both sources, every refusal, and the guarantee that
  the working tree is untouched.

- **Before-images from the host's own backup store** — `midflight` now reads
  `~/.claude/file-history/<sessionId>/<hash>@v<n>` and pairs each `file-history-delta`
  with the edit that produced it. The join is the transcript, not a guess:
  `delta.messageId` → the assistant record's `uuid` → the `tool_use` in that message
  whose `file_path` equals `backup.realParentDir + basename(trackingPath)`. When the two
  paths disagree the tool falls back to the message's single edit, and refuses entirely
  when that would be ambiguous — a wrong before-image is worse than a missing one.

  When the log *also* carries an `old_string`, the two are cross-checked rather than one
  silently overwriting the other; a mismatch is surfaced, because a log that disagrees
  with the host's backup is exactly the kind of thing a forensic tool exists to show.

  Measured across every local session with a backup directory (40 sessions, 290 deltas):
  274/274 `messageId`s resolve, the named backup exists 274/274, 0 disagreements. The
  rescue path is proven by stripping `old_string` from all 211 tool calls of session
  `671a21ed`: `backups=113 joined=55 agree=0 disagree=0 recovered=55` — 55 edits that
  were previously unrecoverable now render real diffs, badged
  `before-image 来自 file-history 备份 · 可逆放（非日志内联）`.

  Per-file read ceiling is 4 MiB. Oversize, missing, unreadable and host-untracked
  backups are each counted and reported, never silently dropped. `doctor --json` and the
  report header both surface the counts.

### Fixed

- **The release now proves its own tarball.** `npm publish` cannot be undone for 72
  hours, and `prepublishOnly` runs in this checkout — it never sees the file layout
  the registry will serve, so a package can pass every gate here and still install
  broken. `scripts/verify-tarball.sh` packs the tarball, installs it into a clean
  prefix, and runs every subcommand from the installed binary (`--version`, `doctor`,
  `stats`, `replay`, `revert`, plus the behavioural check that `revert` rejects a file
  that is not a report). The release **refuses to publish** if any of it fails. Run it
  on its own with `npm run verify:tarball`.

- **Edits near the end of a file produced diffs `git apply` could not place.** A
  trailing newline is a line terminator, not an empty final line, but the splitter
  kept the phantom — so every hunk within three lines of EOF carried a context line
  the file did not contain, and `git apply --check` rejected a perfectly good patch.
  Found by installing the packed tarball into a clean prefix and reverting a real
  report; the earlier test had passed only because its change sat outside the
  context window. Files with no trailing newline now also get git's
  `\ No newline at end of file` marker, which they need to be appliable at all.
  A create no longer reports a phantom empty added line either.

- Edits larger than `--per-step-chars` no longer lose their diff. The per-step clip made
  the stored tool arguments unparseable JSON, which silently erased the applied text
  (and therefore the diff). The applied text is now lifted from the unredacted input,
  redacted and clipped independently of the displayed arguments.
- The before-image agreement check no longer compares *redacted* text. Redaction is not a
  homomorphism across a JSON-escape boundary, so a secret straddling one produced false
  disagreements on agreeing pairs. The check now runs on the unredacted values, which are
  compared and dropped — never rendered.

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
