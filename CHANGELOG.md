# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **A link that only resolves on the author's machine is now a broken link.** The link
  checker verified that referenced files exist, never that git ships them, and it only read
  markdown `[](...)` links — so the entire first screen (all HTML) was unchecked. The README
  spent a release promising this repo runs its action on its own pull requests, pointing at
  `.github/workflows/self-replay.yml`, a file `.git/info/exclude` kept out of every published
  tree. It now states the truth in both languages, and `scripts/link-check.mjs` fails on any
  reference that exists on disk but not in a commit, plus every `href`/`src`/`srcset` and
  in-page anchor that the markdown-only loop could not see. Three regression tests keep both
  halves honest, including a negative case that must stay red.
- **The `npm` badge is gone from the first screen.** The package is not published, so the
  badge pointed at a 404 — a worse first impression than no badge, and the README already
  said so in words. It comes back with the package.


- **Dropping steps is now stated, not implied.** A 6,267-step session replayed with the
  default 3,000-step ceiling printed `3000/6267 步` and stopped. The numbers looked like a
  formatting detail, so a user opened the report, found half the conversation gone, and had
  no way back to the flag that caused it. The terminal now prints the same sentence the
  report page does: how many steps were dropped, which kinds, and that `--max-steps` keeps
  more. (Report page, terminal and `thinBanner` share one string — they cannot drift.)
- **The thinning banner answers in the report's own words.** It listed what it dropped by
  the parser's enums (`reasoning 729 · assistant 800`) while every step row three lines
  below said 推理 / 助手. One page, two vocabularies, and the reader had to guess which half
  spoke English. Dropped kinds now use the same Chinese labels as the timeline, with the
  raw kind kept for any adapter that introduces a new one.

- **`revert --list` no longer prints a padded internal enum.** The source column read
  `[log         ]` / `[file-history]` — machine padding in the one screen where a user
  decides which edit to undo. Both sources now use the Chinese words already settled
  elsewhere in this codebase, and the success line says `来源：` instead of `source=log`.
- **A loop finding no longer prints raw JSON or a float that looks like a bug.** On a
  real 109MiB Codex session, `write_stdin {"session_id":49146.0}` repeated three times and
  the headline showed the whole object — the reader had to parse JSON to learn one integer,
  and `49146.0` reads like a defect in this tool. When no known argument key carries the
  meaning, the label now names the short scalar fields (`write_stdin「session_id=49146」`).
- **A loop's step list matches its own count.** Evidence read `第 893-901 步` next to
  `连续 3 次`: the range counts every step, the run counts only tool calls, so the two numbers
  disagreed. The steps that actually repeated are now named (`第 893、897、901 步`) and the
  arguments are still quoted — that line is the proof, the headline is the signpost.
- **`doctor` now speaks one language on the failure screen.** It printed `FAIL`, then
  `adapter=unknown agent=codex lines=2 steps=0`, then V8's own sentence
  (`invalid JSON: Unexpected token 'g'`), then `2 bad line(s)` — a second, unexplained
  language on the one screen a user reaches when their log will not read. The verdict,
  the counts, the record kinds (`每类步数：工具调用 127 · 助手回复 89`) and every parse
  failure are now in the reader's words, with V8's wording kept only as the reason. The
  dangling `steps by kind:` with nothing after it is gone. `--json` keeps its English
  keys on purpose: that is a machine contract, not a sentence.
- **Success lines agree with the report.** `replay` and `revert` announced success as
  `wrote demo.html  steps 382/382  coverage=partial`; the report itself already labels
  that verdict `部分可撤回`, so the terminal and the page used two vocabularies for one
  fact. Both now read `已写入 …  382/382 步  撤回：部分可撤回`.
- **A first record with no timestamp no longer claims it reused a previous one.** There
  was no previous timestamp to reuse; it is dated at the session start, and the warning
  says exactly that.
- **No step wears the Unix epoch as its clock.** A record with no timestamp is dated at
  the session start, so `new Date(0)` printed `1970-01-01 00:00:00` on the *first* step of a
  real Claude session — the first thing in the detail pane, and indistinguishable from a real
  1970 timestamp. The pane now says `时间 未知 · 这条记录自己没写时间，显示顺序仍然准确`.
- **The CLI's own plumbing is no longer billed to the reader.** Claude Code writes
  `<command-name>/model</command-name>` and `<local-command-caveat>` into the *user* turn, so
  the list showed `<command-name>/model</command-name> <command-message>mo…` under a `用户`
  label and asked the reader to account for their own CLI. Those rows are now `命令行`, reading
  `执行了命令 /model`, `命令输出：Set model to …`, `命令行说明：Caveat: …`. Row kind is unchanged,
  so counts, the timeline strip and postmortem are untouched.

## [0.1.2] - 2026-09-28

### Added

- **Two more hosts, and a new honesty state for them.** `cursor` and `windsurf`
  adapters ship, both marked `unverified`: the parser exists and is tested, but it has
  never run against a real log of that host, so it is not counted as readable in
  `midflight agents`. Promotion to `verified` is mechanical — a real log has to pass the
  `smoke:real` CI gate first.
  - Cursor: reads the CLI's plain Anthropic-shaped `agent-transcripts` JSONL. The IDE's
    `store.db` is a protobuf store with no published schema and is deliberately not read.
  - Windsurf: the cascade store is encrypted at rest. The adapter measures Shannon entropy
    on *your* bytes and says the session cannot be replayed, instead of drawing an empty
    timeline that looks like a bug.
- `npm run smoke:browser:real` — a real-browser gate over the two newest **real** Codex and
  Claude Code sessions, 62 interaction assertions against the report the tool actually ships.

### Fixed

- **A 2.2 MB report used to open completely blank.** Tool output containing `<!--` or
  `<script` pushed the HTML tokenizer into script-data-escaped state, so the document's own
  closing tag never closed the script and the whole app became one unparseable blob — zero
  page errors, zero DOM, no way to tell it apart from a slow load. Every `<` is now escaped
  as `\u003c` in the data handed to the page, which JSON and JS both decode back losslessly.
- **Pointing `replay` at the wrong file looked exactly like success.** Any file that
  existed produced `wrote replay.html  steps 0/0` and exit code 0 — the same sentence
  and the same code as a healthy run, for a report with no content in it. Grab the
  wrong path, or hand it a log that got truncated mid-write, and nothing said so.
  `replay` now fails with exit 1 when *every* line failed to parse, prints the first
  offending line and points at `midflight doctor` for the full reason, and warns on
  stderr when only *some* lines are damaged. A file with zero lines is still a
  legitimate empty session and still exits 0 — confusing those two would make the tool
  refuse a file that was fine. `test/cli-exit.test.ts` locks all four cases.
- `midflight agents` counted the same file twice when a host's roots overlapped
  (`.cursor` plus `.cursor/projects`), inflating session counts and bytes.
- `parseSession`'s unknown-format fallback always picked the first adapter, because every
  adapter emits an `unknown` step. It now picks the one that classifies the most steps.
- **Thirteen findings used to look like one finding.** A real 110 MB Codex session tripped
  the loop detector 13 times, and every row read the same sentence — "同一个调用连续跑了
  N 次，参数完全相同" — with the command itself parked in a tooltip nobody opens. The
  headline now carries the call: `exec_command「sleep 12; cat log.txt」连续跑了 4 次`.
  Codex hands `args` over as raw JSON *text* while Claude Code hands over an object, so
  reading only the object form is what left every codex loop labelled with a JSON blob;
  both shapes are parsed now. The panel also leads with the shape of the findings
  ("死循环 13 · 上下文压力 1") so a reader sees where to look before reading rows.


## [0.1.1] - 2026-09-28

### Fixed

- **The coverage bar no longer contradicts the sentence under it.**
  On a session whose changes all arrived through shell commands there are zero
  reversible edits out of 1,720 changes, and the bar used to fill 100% while the
  text right below it said 0 of 238 could be undone. Two readers, two opposite
  conclusions. `computeCoverage` now also reports `totalChanges` (structured
  edits + shell-borne ones) and `reversibleRatio` (reversible / total), and the
  bar divides by every change instead of by the reversible ones. It reads
  `可撤回 0%（0 / 1.7k 处改动）`, which agrees with the explanation underneath.

- **A report that failed to parse no longer ships as a blank page.**
  While renaming a label, one `</div>` escaped its string literal in `report.ts`.
  The inlined script then died on `SyntaxError: Invalid regular expression`, the
  page rendered completely empty, and all 147 tests stayed green because none of
  them looked at the generated script. AC-19 now extracts the inlined `<script>`
  and constructs it with `new Function`, which parses without executing. Verified
  in both directions: the good source passes, and re-injecting the exact quote
  bug makes it fail with the same SyntaxError the browser reported.

### Changed

- **Wording on screen now says what the number means.** `副轴 · 上下文构成（字符
  质量，非精确 token 归因）` → `副轴 · 上下文占用（按字符数估算，不是精确 token 数）`;
  `蒸发（压缩丢弃）` → `压缩时丢弃的内容`; `事后法证` → `自动检查` in the report title
  strip; the context-window field carries a `token` unit; and a compaction row
  no longer repeats its own label (`压缩丢弃 | 压缩丢弃 N 字符` → `压缩丢弃 | 丢弃
  N 字符`). The same three strings changed in the `--paste` digest.
  `事后法证` (a forensic term) and `事后解剖` became `自动检查` in the title strip
  and the findings panel, which had also disagreed with each other.

  Note on the de-AI gate: `deai-check.sh` only reads `.md/.txt/.html`. Run against
  the repo root it also ingests `.release-assets/*.html`, which embeds a real
  session log and trips on the operator's own shell text — a false positive, not
  a documentation problem. Scoped to the 12 hand-written Markdown files the
  result is `DEAI-OK hard=0 soft=0 files=12`. Earlier rounds of this changelog
  quoted `files=12` while actually pointing the gate at the artifacts directory;
  this is the first run that scanned the documents it claims to cover. The
  on-screen strings in `src/*.ts` are outside what `deai-check.sh` inspects at
  all, and were checked by hand instead.


### Added

- **`npm run check:readme` — every command printed in README.md is executed before publish.**
  The pitch is a copy-paste, so a command in the README that does not run is the
  cheapest way to lose the visitor who has not starred the repo yet. The gate pulls
  each `midflight` / `npx midflight-replay` line out of the README, runs it against
  the built binary, expands the documented `ls -t ... | head -1` and `*/*.jsonl` globs
  against real session logs, and adds `--dry-run` to any `install` line so it never
  touches the operator's own agent config. It is wired into `prepublishOnly`, so the
  package cannot be published with a README command that is stale. Measured:
  `README-CMDS-OK n=12`; negative-tested by breaking one command, which drops it to
  `README-CMDS-FAIL 11/12` and exit 1.

  The gate skips, loudly, what a given machine cannot answer: a box with no agent
  logs and no installed host reports `README-CMDS-OK n=6` plus a skip count rather
  than a red publish. It still fails when a glob matches nothing while the store
  exists — that is the failure mode a hardcoded date produces.

### Fixed

- **README no longer asks for a session log from a fixed date.**
  `$(ls -t ~/.codex/sessions/2026/09/27/*.jsonl | head -1)` was the copy-paste line
  in both READMEs. It worked on the machine that wrote it and would have failed for
  every visitor afterwards. It is now `~/.codex/sessions/*/*/*/*.jsonl`, which
  matches the layout Codex actually uses. Found by the new README gate, not by
  reading the README.

### Fixed

- **`scripts/verify-tarball.sh` no longer trusts a hand-kept command list.**
  The gate packed the tarball, installed it into a clean prefix and ran a list of
  subcommands that was written out by hand. Measured 2026-09-28: that list had never
  included `postmortem`, and it stopped including `agents` and `install` the moment
  those were added — so a package could have shipped with three of its seven commands
  broken and the gate would still print `TARBALL-OK`. The list is now derived from the
  shipped dispatch table in `dist/cli.js`, every derived command is executed, and
  `install codex` is additionally asserted to have written a real `SKILL.md` into a
  throwaway `$HOME`. Deriving it found the `postmortem` hole on the first run, which is
  the argument for deriving it.

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
  `before-image 来自 file-history 备份 · 可撤回（非日志内联）`.

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
