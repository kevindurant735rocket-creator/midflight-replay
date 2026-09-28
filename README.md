<h1 align="center">midflight</h1>

<p align="center">
  <b>Turn a finished AI coding-agent session into a single scrubbable HTML file you can attach to a PR.</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/midflight-replay"><img src="https://img.shields.io/npm/v/midflight-replay.svg" alt="npm version"></a>
  <a href="#install"><img src="https://img.shields.io/badge/node-%3E%3D20-5FA04E" alt="node >= 20"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT"></a>
</p>

## Run it on your own session &mdash; one command, nothing to clone

```bash
npx github:kevindurant735rocket-creator/midflight-replay replay "$(ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -1)" --out replay.html
```

That reads the most recent Codex session off this machine and writes one self-contained
`replay.html` you can open or attach to a pull request. On Claude Code, point it at
`~/.claude/projects/*/*.jsonl` instead. Not sure which logs you have? Ask:

```bash
npx github:kevindurant735rocket-creator/midflight-replay agents --probe
```

Everything runs on your own machine. No network calls, no telemetry, no database, and the
tool ships zero runtime dependencies &mdash; redaction of paths, keys and emails is on by
default. <sub>Requires Node 20+. Once the package is on npm this becomes
<code>npx midflight-replay</code>; until then the <code>github:</code> form above is the
one that actually installs.</sub>


<p align="center">
  <a href="#see-it-move">16s replay</a> ·
  <a href="#install">install</a> ·
  <a href="#which-agents">which agents</a> ·
  <a href="#the-two-outputs">outputs</a> ·
  <a href="#put-it-on-the-pull-request">action</a> ·
  <a href="#honest-coverage">coverage</a> ·
  <a href="#privacy">privacy</a> ·
  <a href="#faq">faq</a> ·
  <a href="#why-this-and-not-the-other-eight-tools">why not the other eight</a> ·
  <a href="#roadmap">roadmap</a> ·
  <a href="README.zh-CN.md">中文</a>
</p>

<p align="center">
  <img src="docs/demo/demo.gif" alt="16-second scrub-through of a real 32 MB Claude Code session: the timeline cursor moves, the context sawtooth drops on a compaction, a before-image diff opens" width="820">
</p>

<p align="center"><sub>The real thing, moving. 16 seconds of a 32 MB Claude Code session &mdash; 3,111 parsed steps, 10 first-hand compaction events. No mock data: the file was produced by <code>midflight replay</code> against a session log the agent wrote about its own work.</sub></p>

<p align="center">
  <img src="docs/images/replay-codex-109mb.png" alt="midflight replaying a real 109 MiB Codex session: 14,905 steps, 30,736 log lines, opened in under half a second" width="880">
</p>

<p align="center"><sub>A real Codex session from this machine &mdash; 109 MiB of raw JSONL, 14,905 parsed steps &mdash; turned into a 3.4 MiB single file in <strong>0.46 s</strong>. The code in the picture is the actual session log, not a mock.</sub></p>

---

## Sixty seconds, start to finish

```bash
git clone https://github.com/kevindurant735rocket-creator/midflight-replay.git
cd midflight-replay && npm install && bash scripts/demo-60s.sh --self
```

That is the whole demo. It finds the largest real session log on your machine
(`~/.codex` or `~/.claude`), replays it, and prints what it did:

```
  input        110 MiB of raw JSONL
  output       3.4M, one file, no sibling assets
  wall clock   454 ms
 { "kept": 4016, "total": 14905, "coverage": "diff-only", "parseMs": 387 }

done in 53 ms — open it:
  open demo-60s.html
```

Those are measured on the machine that ran it, not copied from a benchmark. Drop
`--self` to run against the bundled fixture instead if you want the 53 ms path with
no session logs present.

---

## See it move

<p align="center">
  <img src="docs/images/replay-claude.png" alt="midflight replay of a real Claude Code session" width="880">
</p>

A real Claude Code session from this machine — **31 MiB of raw JSONL, 3,111 parsed
steps, 10 first-hand compaction events** — compressed into a 16-second replay. No mock data,
no hand-written demo fixture: the file was produced by `midflight replay` against a
session log the agent wrote about its own work.

<p align="center">
  <img src="docs/demo/demo.webm" alt="16-second scrub-through of a 32MB Claude Code session: timeline scrub, context sawtooth, before-image diff" width="880" controls loop>
</p>

<p align="center">
  <a href="docs/demo/poster.png"><img src="docs/demo/poster.png" alt="poster frame of the midflight replay" width="880"></a>
</p>

What you are looking at, all of it measurable:

- the left axis is **3,000 displayed steps** of 3,111; the banner says so instead of
  pretending the file is complete
- the green area is the **context sawtooth** — it climbs on every turn and drops when
  the host compacts. 10 of those drops are marked `⇣ 第一手压缩事件`
- the right pane is a real `Edit` with a **before-image**, so you can watch the patch
  the agent actually applied, line-numbered
- the coverage bar reads **52%**, because 127 of 244 edits in that session carry a
  before-image and the rest are only visible as the agent's own description

Reproduce it:

```bash
midflight replay ~/.claude/projects/-Users-zhangfengrui/<session>.jsonl --out replay.html
open replay.html
```

`docs/demo/` is regenerated by `node scripts/record-demo.mjs <report.html> --out docs/demo`.

---

## Don't take our word for it — open one

Three real outputs are committed to this repo. Click, no install, no download,
no account. Every one is a single file with zero external references.

| | what you get | open it |
|---|---|---|
| **Interactive replay** — a Codex session | scrub the timeline, click any step, read the diff | [open](docs/demo-codex.html) · 25 KB |
| **Interactive replay** — a Claude Code session | the one with compaction sawtooth events | [open](docs/demo-claude.html) · 47 KB |
| **PR digest** — GitHub-safe | what you actually paste into a review comment | [open](docs/demo-claude-paste.html) · 1 KB |

The third one is the point of the project. GitHub strips `<script>` and
`<style>`, so every HTML exporter dies on a PR comment; that one is built from
`details / summary / table / pre / code / div` only, and survives the paste
intact. It is 1 KB, which is why it gets read.

---

## The problem

Here is a real session from this machine, measured with `midflight doctor` — no
rounding, no illustration:

| | |
|---|---|
| log size | **109 MiB** |
| steps | **14,905** |
| tool calls | **3,689** |
| of those, file mutations | **1,720** — every one carried by a shell command |
| before-images recorded | **0** |
| context compactions | **22** |

So the log knows *that* each of 1,720 files changed and *which command* changed it,
and it does not know what any of those files looked like beforehand. Twenty-two times
the agent's memory was compacted, and the log records the event but not what survived
it.

The code that came out of this is now a diff. The 109 MiB of reasoning that produced
the diff is a file no PR reviewer is going to open. So they read the diff like a
stranger, comment "any way to test this?", and move on. If you want to explain it,
you re-run the agent — which yields a *new* session that does not match the one that
wrote the code.

**midflight replays the session that actually made the code.** Not a summary, not a
report — a scrubbable timeline with the real diffs, the real context accounting, and
an honest statement of how much of it could be reconstructed.

One command:

```bash
npx midflight-replay replay ~/.codex/sessions/2026/09/27/rollout-....jsonl --out replay.html
```

`replay.html` is one self-contained file. No server, no CDN, no build step, no
network requests — it works from `file://`, from a PR comment attachment, from an
air-gapped laptop, from 2030.

---

## Install

Requires **Node 20+**. Nothing else.

```bash
npx midflight-replay replay <session.jsonl> --out replay.html
```

Or pin it — note the binary is `midflight`, so this gives you the `midflight`
command, like `@angular/cli` gives you `ng`:

```bash
npm i -g midflight-replay
midflight doctor <session.jsonl>
```

There is no `npm install` step for the tool itself — it ships zero runtime
dependencies. (The repo's devDependencies exist only to compile and test the source.)

---

## Which agents?

`midflight agents` walks the stores on the machine you run it on and prints what it
found. It is the honest answer to "can this read my agent?", measured every run:

```
$ midflight agents --probe
agent                 status       sessions   size        newest
--------------------  -----------  ---------  ----------  -----------------
Codex CLI             readable     849        678.5 MB    2026-09-28
Claude Code           readable     173        226.9 MB    2026-09-27
Cursor                no records   0          0 B         -
Gemini CLI            no records   0          0 B         -
opencode              no records   0          0 B         -
GitHub Copilot CLI    no records   0          0 B         -
Aider                 not instal…  -          -           -
Continue              not instal…  -          -           -
Cline                 not instal…  -          -           -
Windsurf              no records   0          0 B         -
Factory Droid         not instal…  -          -           -

2 of 7 installed agents readable; 4 not installed on this machine.
  ✓ Codex CLI: newest log: 4090 steps, 0 parse errors
  ✓ Claude Code: newest log: 140 steps, 0 parse errors
  - Cursor: Cursor 装在这台机器上，但还没找到 CLI 的对话记录（它们在 ~/.cursor/projects/*/agent-transcripts）
  - Windsurf: Windsurf 装在这台机器上，但 ~/.codeium/windsurf/cascade 下没有会话文件
```

`--probe` goes further: it parses the newest log of every readable agent, so
"readable" means *this file parsed just now*, not "should work".

The four states are kept apart on purpose. **readable** means a session file was found
and parsed. **unverified** means an adapter ships but has never been run against a real
log of that host — it is listed, and it does not count as readable. **no adapter** means
session files were found and this tool cannot read them yet, with the real file count
attached. **no records** means the host is installed but left nothing to read &mdash; a
different situation entirely, and one an earlier version got wrong: it counted the rule
files that `midflight install` writes into `~/.cursor/rules` and `~/.codeium/windsurf/rules`
as sessions, so a machine where Cursor had never stored a single chat reported
"1 file(s) found". The registry covers 11 hosts; Codex and Claude Code are the two with
adapters that have parsed a real log, Cursor and Windsurf ship adapters that are still
`unverified` until one of their real files shows up, and every other row says in one line
why it is not supported yet.

### The two adapters that are honest about not working yet

Both were added in 0.1.2, and both refuse to pretend:

- **Cursor.** The CLI writes plain Anthropic-shaped JSONL to
  `~/.cursor/projects/<encoded-path>/agent-transcripts/*.jsonl`, and that is what the
  adapter reads. The IDE's own `~/.cursor/chats/*/store.db` is a protobuf store with no
  published schema, so it is deliberately *not* read: half a session with a guessed field
  number is worse than no session.
- **Windsurf.** The cascade store is `~/.codeium/windsurf/cascade/<uuid>.pb` and it is
  encrypted at rest — real files measure 8.00 bits/byte of Shannon entropy. The adapter
  measures the entropy of *your* bytes and reports the session as unreplayable, instead of
  drawing an empty timeline that looks like a bug.

### Install it into your agent

```bash
midflight install codex        # one file, at ~/.codex/skills/midflight-replay/SKILL.md
midflight install --all        # every known host
midflight install --dry-run    # print the paths, write nothing
```

It writes a single `SKILL.md` and nothing else — no hook, no daemon, no config edit, no
network call. That is deliberate: midflight reads the log the agent already writes, so
there is nothing to intercept, and a wrapper around your agent is one more thing that can
break a long-running session. The skill is plain Markdown you can read before installing
it, it refuses to overwrite a different file without `--force`, and the commands inside it
are asserted by a test to exist in the same build.

| host | path | file |
|---|---|---|
| Codex CLI | `~/.codex/skills/midflight-replay/` | `SKILL.md` |
| Claude Code | `~/.claude/skills/midflight-replay/` | `SKILL.md` |
| opencode | `~/.config/opencode/skill/midflight-replay/` | `SKILL.md` |
| Gemini CLI | `~/.gemini/skills/midflight-replay/` | `SKILL.md` |
| Cursor | `~/.cursor/rules/midflight-replay/` | `*.mdc` |
| Windsurf | `~/.codeium/windsurf/rules/midflight-replay/` | `*.md` |
| GitHub Copilot | `~/.github/prompts/midflight-replay/` | `*.prompt.md` |

The frontmatter differs per host on purpose (`name`+`description`, `description` only, or
none) and a test locks that mapping, so the file is not a renamed copy of a README.

---

## Where are my session logs?

midflight reads the JSONL the agents already write. It never asks you to enable
anything, and it never touches your workspace.

| Agent | Default location | File |
|---|---|---|
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/` | `rollout-*.jsonl` |
| Claude Code | `~/.claude/projects/<mangled-cwd>/` | `<session-uuid>.jsonl` |

```bash
# newest Codex session
npx midflight-replay replay "$(ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -1)" --out replay.html

# newest Claude Code session
npx midflight-replay replay "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)" --out replay.html
```

Format is auto-detected from the first intact record, never from the file name, and
never from the directory. A file that is neither format is rejected with a line number.

---

## The two outputs

GitHub strips `<script>` and `<style>` from anything you paste into a comment. Every
HTML exporter dies on that. So midflight has two shapes, and you pick:

### 1. `--out replay.html` — the interactive replay

The full experience. Single file, everything inline.

- **Main axis** — the session timeline, one bar per step, coloured by kind
- **Secondary axis** — stacked context composition (messages / reasoning / tool calls
  / tool output) per step. Click a band or a legend entry to jump to the first step
  carrying it
- **Scrubber** — drag, or `space` play/pause, `←/→` or `j/k` single step,
  `PageUp/PageDown` ±20 steps, `Home/End`. Also clickable
- **Step detail** — payload, token accounting, and for edit steps a **unified diff**
  with line numbers
- **Compaction markers** — where context was compacted, drawn on the axis
- **Honest coverage bar** — see below

Measured on real data: 4,016 of 14,905 steps kept from a 109 MiB session, 3.38MB output,
scrub under 100ms per step.

### 2. `--paste` — the GitHub-safe digest

```bash
npx midflight-replay replay session.jsonl --paste > digest.html
```

A ≤60KB block containing only `details / summary / table / pre / code / div`.
Zero `<script>`, zero `<style>`, zero `on*=` handlers, zero external references —
machine-asserted in the test suite, not just intended. It is CSS-free by design, so
it stays readable even if a host strips every style attribute.

This is a postmortem digest, not a fake interactive replay, and it does not pretend
to be. If the digest does not fit the budget, sections are dropped in reverse
priority order and the block **says how many were dropped**.

---

## Put it on the pull request

Most reviewers never go looking for a CLI. The action puts the digest where they
already are.

```yaml
# .github/workflows/agent-audit.yml
name: agent audit
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: kevindurant735rocket-creator/midflight-replay@v0.1.0
        with:
          session: auto              # newest .jsonl under .agent-sessions/
          # session: logs/last-run.jsonl
```

It picks a committed session log, builds the paste-safe digest, and leaves **one**
comment on the PR — updated in place, never stacked, so a 40-commit PR does not
accumulate 40 identical digests. The full interactive replay is still yours to
attach by hand; the action posts the readable half.

**What it cannot do:** a CI runner has never run Codex or Claude Code, so there is
no session for it to read unless one is committed. Point `session:` at a file in the
repo, or set `dir:` to wherever yours live.

**What it costs:** one `npm ci` and one `tsc` on a zero-dependency project. This
machine's real 109 MiB (114,325,714 bytes) / 30,736-line / 14,905-step Codex session parses in **under
500 ms** and produces a 9,381-byte digest.

This repo runs the action on its own pull requests — see
[`.github/workflows/self-replay.yml`](.github/workflows/self-replay.yml).

## Honest coverage

The single most important design decision here.

A session log does not always contain enough to reconstruct what happened on disk.
Codex writes `cmd` and `path` arguments — **zero** `old_string` / `patch` fields across
3,689 tool calls in the session measured below (`grep -c old_string` → `0` over all
30,736 lines). Claude Code writes `old_string` +
`new_string` for `Edit`, and full `content` for `Write`. So the honest answer differs
per agent, and midflight prints it instead of quietly showing an empty diff:

| Verdict | Meaning |
|---|---|
| `full` | every edit step has a before-image; the replay is reconstructable |
| `partial` | some edits have before-images, some don't — the bar shows the ratio |
| `diff-only` | the log records *that* a file was written, never its prior content |
| `no-edits` | the session made no file edits at all |

Measured, not assumed:

| Session | Size | Parse | Output | Steps | Coverage |
|---|---|---|---|---|---|
| Codex rollout | 109 MiB | ~0.4 s | 3.38 MiB | 4,016 / 14,905 | `diff-only` — 1,720 shell-carried mutations, 0 before-images |
| Claude Code | 31 MiB | ~0.13 s | 2.19 MiB | 3,000 / 3,111 | `partial` — 244 edits, 127 with before-image |

A second honesty rule: steps the adapter cannot classify are labelled, counted and
**rendered** — never silently dropped. Claude Code writes session-metadata records
(`file-history-snapshot`, `ai-title`, `permission-mode`, …) that carry no agent action,
so midflight now **recognises** them instead of parking them in a bucket: `ai-title` and
`agent-name` become the session title, `file-history-delta` is named chrome, and
`compact_boundary` becomes a first-class compaction event. That last one used to be a
silent lie — the 31 MiB session above contains **10** of them, and an earlier build
claimed "no compaction observed" because it swallowed them as chrome.

The result on that session is `unknownCount: 0` across all 3,111 steps:
1,040 tool calls, 1,040 tool outputs, 424 assistant, 415 reasoning, 121 user, 61 notes,
10 compactions. What is *still* deliberately not read is written down in
[`docs/KNOWN-GAPS.md`](docs/KNOWN-GAPS.md) — including why `~/.claude/file-history`
is not decoded, with the command that proves it. What gets built next, and what
deliberately does not, is ranked in [`docs/BACKLOG.md`](docs/BACKLOG.md).

Reproduce both rows yourself:

```bash
npx midflight-replay doctor <session.jsonl> --json   # steps, byKind, parseErrors, unknownSteps
/usr/bin/time -l npx midflight-replay replay <session.jsonl> --out /tmp/r.html --json  # RSS
```

The 109 MiB file peaked at **273 MB** RSS (`286,736,384` bytes) — it is streamed
line-by-line and never held in memory whole.

---

## Privacy

**midflight never writes to your workspace, never reads your git history, and never
makes a network request.** Not once, at any code path. The browser acceptance test
asserts zero outbound requests on the generated report.

Redaction is **on by default** and runs before anything reaches the report:

- OpenAI / Anthropic keys, GitHub PATs, Slack tokens, AWS keys, Google API keys
- PEM private-key blocks, `Bearer` headers, JWTs
- `api_key` / `secret` / `password` / `token = ...` assignments
- email addresses
- your home directory → `/HOME`, `/Users/<you>` → `/Users/USER`

Disable with `--no-redact` if you are deliberately debugging a secret. Nothing is
uploaded, so "uploaded" is not a failure mode. The report shows which rules fired
and how many substitutions happened — as counts, never as values.

---

## Commands

```
midflight replay <session.jsonl> [options]   build a self-contained replay
midflight doctor <session.jsonl> [--json]    parse and report health; exit 1 on bad input
midflight stats  <session.jsonl> [--json]    parse and print step counts
midflight postmortem <session.jsonl> [--json] count loops, repeated edits, context pressure
midflight revert  <report.html> --step <n>    print the patch that undoes step n
midflight revert  <report.html> --list       show which steps are reversible
midflight redact                            run the redactor over stdin
midflight --version                          print the installed version
```

| Option | Default | Meaning |
|---|---|---|
| `--out <file>` | stdout | write HTML here |
| `--paste` | off | emit the GitHub-safe digest instead |
| `--max-steps <n>` | 3000 | tool calls and compaction events are **never** dropped |
| `--per-step-chars <n>` | 1200 | payload cap per step |
| `--no-redact` | off | disable redaction |
| `--json` | off | machine-readable summary on stderr |

`doctor` is the one to run in CI or on a suspect file. It reports the first bad
record **by line number** and exits non-zero.

### `postmortem` — what the session did to itself

Counts, over the steps the host logged: the same call repeated with byte-identical
arguments, files edited more than twice, and context pressure. It exits 0 even when
it finds something — a loop in your session is a fact, not a parse error.

```
$ midflight postmortem ~/.codex/sessions/2026/09/23/rollout-....jsonl
postmortem 01a0b440-b440-72a0-95c1-68f4812084c2

[loop] the same call ran 9 times in a row with identical arguments
  - steps 10338-10370: exec_command {"cmd":"echo poll; ps aux | grep ego-server-name | grep -v grep | head -5","yield_time_ms":15000.0}
  - 9 consecutive calls, 0 arguments changed between the first and the last

[near-full-context] context hit 322,441 tokens against a 243,200-token window
  - the host reported input ABOVE its own reported window; treat the ratio as a floor, not a measurement
  - 245 of 4917 usage records at or above 85.0%
  - 3 records where input tokens exceeded the reported window
  - 22 first-hand compaction events

14 findings. Counts over logged steps only.
```

That is a real 110 MiB session from this machine, not a fixture: 14 findings, the
worst being a poll that ran nine times with the arguments unchanged while the agent
kept talking. Thresholds are named constants in [`src/postmortem.ts`](src/postmortem.ts)
(3 identical calls, 3 edits to one file, 85% of the window) so a reader can argue with
the bar instead of trusting it. What it does not claim is in
[KNOWN-GAPS §7](docs/KNOWN-GAPS.md).

The same panel is in the report itself, under the coverage bar: every finding is a
row, and clicking it jumps the timeline to the step that started it. A reviewer's
first question about an agent's work is "what went wrong", and until this shipped
the answer was a timeline you had to read by hand.

### `revert` — the report's inverse

A report proves what an agent did. `revert` turns one step back into a patch:

```
midflight revert replay.html --list                    # which steps can be undone
midflight revert replay.html --step 42 --out p.diff   # write the patch
git apply --check -R p.diff                           # verify
git apply -R p.diff                                   # then, if you agree
```

It **never writes to your working tree** — the only command that does is `git apply`,
yours, after you have read the patch. `--list` works on a report alone, so a colleague
can see what is reversible without having your checkout.

When a step has no recoverable before-image, `revert` **refuses with a non-zero exit**
instead of emitting an empty patch. A tool that quietly produces a no-op it calls a
revert is worse than one that says no.

---

## FAQ

**Does it touch my repository?** No. It reads one JSONL file you name and writes one
HTML file you name. It never reads your git history, never runs git, never writes
inside a project directory.

**Does my session leave my machine?** No. There is no network call at any code path —
a browser assertion checks for outbound requests during interaction and comes back
zero. There is no server, no telemetry, no database, no crash reporting.

**Could it leak my API keys?** Redaction runs before anything reaches the report and
covers OpenAI/Anthropic keys, GitHub PATs, Slack tokens, AWS and Google keys, PEM
private-key blocks, bearer headers, JWTs, `secret = ...` assignments, emails, and
your home directory. The report says which rules fired and how many times, never the
value. `--no-redact` turns it off.

**Why does the coverage bar say `diff-only` on my Codex session?** Because that is
the truth about the log. Codex records `cmd` and `path` arguments; across the 3,689
tool calls in the session I measured, `old_string` and `patch` never appear — not once
in 30,736 lines. The
file *was* changed, but the previous content was never written down, so a diff
cannot be reconstructed. Claude Code's `Edit` steps do record `old_string`, which is
why those sessions land on `full` or `partial`.

**Do I have to instrument my agent first?** No. midflight is forensic, not invasive.
It reads the log the agent already writes. There is no hook, no wrapper, no config
change — which also means it can only report what the log contains, and never claims
more than that.

**Why are there two outputs?** GitHub strips `<script>` and `<style>` from pasted HTML.
An interactive report cannot survive that, so `--paste` emits a digest built only from
whitelisted tags, verified by test to contain no script, no style, no `on*=` handler,
and no external reference.

**Why is the package `midflight-replay` when the command is `midflight`?**
Because the plain name was legal but useless, and the mismatch is worth one line of
explanation rather than an ugly binary. Measured, not assumed:

| name | npm | github | verdict |
|---|---|---|---|
| `midflight` | **404 — free** | free | free on both, and a bare adjective: `gh search midflight` is a wall of ad/telemetry repos, and the name alone tells a browser nothing |
| `agent-replay` | **taken** — v0.1.1, *"DevTools for replaying AI agent sessions"* | 25+ repos share the name | a direct competitor owns the npm name; `npm publish` fails with EPUBLISHCONFLICT |
| `midflight-replay` | **404 — free** | free under `kevindurant735rocket-creator` | **chosen** — free on both, and the name states what the thing is |

`docs/RELEASE.md` keeps the probe so you can re-check before anyone squats it.

**Does it work on a session that is still running?** You can, but you get a snapshot
of the file as it is when you read it. midflight is built for sessions that already
ended — a PR that is already open.

**What if it doesn't recognise my agent's format?** `midflight doctor` prints the
first bad record by line number and exits non-zero. If the format is new, open an
issue with a redacted 20-line sample and a step-kind histogram — adapters get added
from measured data.

## Why this and not the other eight tools

There are eight existing projects doing "agent session replay" (measured: 388★,
372★, 268★, 110★, 76★, 14★, 13★, 3★). Three conclusions from looking at all of them:

1. **Session replay is a feature, not a category.** Sentry and PostHog both ship it
   inside a bigger product. `rrweb` — the primitive everyone depends on — has 20k★.
   A standalone viewer is competing for the leftovers.
2. **"Local-first flight recorder" is already taken.** One project's own description
   matches that phrasing almost word for word. It has 76★, a 31,000-character README in
   four languages, MIT, and its last commit was two months before this was written.
   Zero open issues. That is not a product failure; that is a distribution failure.
3. **All eight are tools you use alone.** Nobody's output is meant to leave the
   machine.

midflight is built around the third point. The artifact is a file you send to someone
who was not there. The scenario is reviewing an AI-generated PR, which is happening
right now to a lot of people, and which has a built-in distribution channel that
none of the eight have: the PR comment.

Full measurements, repo-by-repo, with the commands to re-run them:
[docs/COMPETITIVE.md](docs/COMPETITIVE.md).

---

## If you searched npm for "agent replay"

You found two packages. Both are measured live, right now, with the commands in
[docs/COMPETITIVE.md](docs/COMPETITIVE.md):

| | `agent-replay` | `flightrec` | **midflight-replay** |
|---|---|---|---|
| npm version | 0.1.1 | 0.9.0 | **0.1.0** |
| last publish | 2026-02-16 | 2026-07-15 | today |
| downloads / month | 9 | 16 | — |
| GitHub repo | **404, deleted or private** | **0★**, created and last pushed the same day | public, CI green |
| what it is | "DevTools for replaying AI agent sessions" | "A flight recorder for Codex sessions" | a **file you attach to a PR** |
| source | not published | not published | **full source, MIT** |

The distinction that matters is not features. It is that neither of those is
installable-and-verifiable: one has no reachable repository, the other has a
repository that has never had a second commit. You cannot read either one, you
cannot file an issue against it, and you cannot check whether it still runs.

So the test here is deliberately the cheapest one that cannot be faked: **install
it and make something.**

```bash
npx midflight-replay replay "$HOME"/.claude/projects/*/*.jsonl --out replay.html
```

If that produces a file you can email to the person who asked you the question,
the comparison is over. 110 MiB of JSONL becomes a 3.4 MiB single HTML in 0.46 s
on the machine quoted above, and the command never touches the network.

---

## Roadmap

Deliberately small. Nine things shipped; there is no eleventh item queued up to
look busy.

- [x] Codex + Claude Code adapters, auto-detected
- [x] dual-axis timeline with clickable context composition
- [x] unified diffs on edit steps, with line numbers
- [x] dual output: interactive HTML + GitHub-safe digest
- [x] honest coverage verdict on every report
- [x] default-on redaction, zero network
- [x] `doctor` with line-accurate failure reporting
- [x] `revert` — undo a step from the report, `git apply -R`-able
- [x] `postmortem` — loops, repeated edits, context pressure, counted from the log
- [ ] more adapters, as they show up in real logs — none are queued speculatively

Not planned, on purpose: a server, an account, a database, a hosted dashboard, a
re-run/fork feature. Each one needs a network call, and the network call is the
thing this project exists to not do.

---

## Development

```bash
npm install          # devDeps only: typescript, vitest, playwright
npm run build        # tsc -> dist/
npm test             # 127 unit tests
node scripts/browser-check.mjs out.html out2.html   # 62 browser assertions on the two fixtures; the count follows the input
```

The browser check is a separate command on purpose: it needs a Chromium download, and
CI should not pay for that on every commit.

Format internals for both agent formats are documented in
[docs/FORMATS.md](docs/FORMATS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The short version: the zero-dependency and
zero-network constraints are the product, not a preference — a PR that adds a runtime
dependency will not merge.

## License

MIT
