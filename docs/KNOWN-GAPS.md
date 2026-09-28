# Known gaps — measured, not guessed

Every row was checked against a real session on this machine. If a row stops being
true, the row gets deleted in the same commit that fixes it. Numbers are reproducible
with the command in the "how it was measured" column.

Reference sessions:

| id | host | file | size |
|---|---|---|---|
| **C** | claude-code | `~/.claude/projects/-Users-zhangfengrui/88095c95-….jsonl` | 31 MiB, 3,111 steps |
| **X** | codex | `~/.codex/sessions/2026/09/23/rollout-2026-09-23T16-24-08-01a0b440-….jsonl` | 109 MiB, 14,905 steps |

## 1. Recovered: `~/.claude/file-history` before-images

**What exists.** Claude Code writes a before-image backup for every file it edits, under
`~/.claude/file-history/<sessionId>/<hash>@v<n>`, and points at it from a
`file-history-delta` record in the transcript that names the message the edit fired on.

**What midflight now does.** `src/filehistory.ts` reads that store and pairs each delta
with the edit it belongs to. The join is the transcript itself, not a heuristic:
`delta.messageId` → the `assistant` record's `uuid` → the `tool_use` in that message whose
`file_path` equals `backup.realParentDir + basename(delta.trackingPath)`. Two rules, in
order: paths agree → use the match; the message held exactly one edit and one delta →
use it and say so (`via: 'sole'`); anything else is left unpaired, because a wrong
before-image is worse than a missing one.

**Measured across every local session that has a backup directory** (40 sessions,
290 deltas): `messageId` → assistant `uuid` resolved 274/274; the derived path matched
25/25; the named backup file existed on disk 274/274. The 16 deltas that name no backup
are all under `/tmp` and are reported as `untracked`, never guessed.

**The rescue path is proven, not assumed.** `old_string` was stripped from all 211
`tool_use` blocks of session `671a21ed` and the stripped transcript re-parsed:

```
backups=113  joined=55  agree=0  disagree=0  recovered=55
```

That session had **zero** reversible edits before this feature. Now 55 of them render a
real diff (1,332 `del` lines, 569 `add` lines), each badged
`before-image 来自 file-history 备份 · 可逆放（非日志内联）`.

**Two things are still not done, on purpose.** The per-file read ceiling is 4 MiB — a
larger backup is counted and reported, never silently dropped. And a backup that vanished
from disk between the session and the replay is counted as `missing`, not reconstructed.

**How to re-run the measurement.**

```sh
node dist/cli.js doctor ~/.claude/projects/-Users-zhangfengrui/671a21ed-b847-4612-8268-21be1f89b0b5.jsonl --json
# fileHistory: {"backups":113,"joins":55,"agree":0,"disagree":0,"recovered":55,...}
```

## 2. Not reversible: edits carried by shell commands

On session **X**, all 1,720 file changes arrive as `exec_command` argument strings. The
report says so and refuses to draw a `del` line it cannot justify — see
[diff.ts](../src/diff.ts), whose module comment states the rule. The coverage bar reads
"部分可逆放" rather than inventing a reverse.

## 3. Character mass, not token attribution

The secondary axis measures accumulated **characters** per category. The host logs do
not attribute tokens to sources, and the report header says so on every page. The one
exception is a compaction event, where both hosts do report a real pre-compaction
**token** count; that number is labelled `token` and is never mixed into the character
curve.

## 4. `parseErrors` are counted, not fatal

Session **X** yields 30 unparseable lines out of 14,905 (0.2%). They are listed in the
report footer with their line numbers. `midflight doctor` exits non-zero on them.

## 5. Undo exists, but it is a patch, not a button

The report is a read-only artefact and it stays that way: `midflight revert` prints a
patch, and `git apply` — yours, after you have read it — is the only thing that writes.
The report itself never touches a working tree, and neither does any other command.

What that costs, stated plainly:

- **A revert is only as good as its before-image.** A step whose before-image came from
  the log's inline `old_string` is reconstructed from a fragment; the tool substitutes it
  back into the file as it stands and refuses if the text is gone or ambiguous. That is
  a guard, not a guarantee.
- **A create cannot be reverted.** There is no before-image of a file that did not exist,
  so `revert` refuses. Deleting it is a `git rm`, and the tool will not do that for you.
- **`--check` still has to pass.** `git apply --check -R` is the last gate, and it is
  yours to run. A patch that applies to a dirty tree is a patch that applies to whatever
  is in the tree, not to what the report saw.
- **No multi-step revert.** One step in, one patch out. A range would be a different
  command with a different blast radius, and the ceiling above is what makes that
  decision easy: it should refuse more than this one does.

## 6. There is no CI badge, because there is no CI running

The two workflow files exist on disk (`.github/workflows/ci.yml`,
`.github/workflows/self-replay.yml`) and are parked in `.git/info/exclude`, not in
the tree. The token this machine holds has scopes `gist, read:org, repo`; GitHub
refuses workflow-file writes without the `workflow` scope, so `gh api --method PUT
.../contents/.github/workflows/ci.yml` returns HTTP 404. Measured, not assumed.

So the README carried two badges pointing at workflows the remote does not have
(`gh api repos/.../actions/workflows --jq .total_count` → `0`). Every visitor saw a
broken image in the first screen. They are removed rather than left as decoration.

**They come back when someone runs `gh auth refresh -h github.com -s workflow` and the
files are un-excluded and pushed.** That is a two-command job, and until it happens
this project has no claim to a green build. The local substitute is the three gates
in `scripts/release.sh`, which do run on every push and are what the release gate
actually reads.

## 7. What `postmortem` does not know

It counts. It does not explain, and it has no model in the loop.

- **A loop is a fingerprint, not a diagnosis.** Three identical calls in a row is
  what a stuck agent looks like *and* what a deliberate retry looks like. The tool
  reports the count and the exact arguments and leaves the judgement to whoever
  was there. It will never say "the agent was confused".
- **"Consecutive" means consecutive among tool calls.** Assistant prose, reasoning
  and results between the calls do not break the run, because a stuck agent keeps
  narrating while it retries. A reader who wants the stricter reading has the step
  numbers in the evidence line.
- **Args are compared as logged, up to 400 characters.** Two calls that differ only
  past that point are reported as one loop. The bar is on purpose: a false split is
  a finding the reader has to disprove, and that is the expensive direction.
- **Repeated edits count edits, not content.** Editing a file three times in a row
  can be careful incremental work. The number is the fact; the verdict is yours.
- **Context pressure is measured against the host's own numbers, which do not always
  reconcile.** A real Codex session reports input above the window it just declared
  (322,441 tokens against a 243,200-token window). When that happens the tool
  prints the tokens and says the ratio is a floor, instead of printing a
  percentage above 100% as though it were a measurement.

### The report's panel is analysed on the thinned timeline

`midflight replay` drops steps under `--max-steps` before anything else touches them,
and the postmortem panel in the report is computed on **what is left** — not on the
whole file. That is deliberate: a finding has to point at a row the reader can click,
and a step that was thinned away is not a row in that report. So a big session can
report fewer loops in the report than `midflight postmortem` does on the same file,
and the report says how many of the original steps survived underneath the panel.
The CLI is the one to trust for the full count; the panel is the one to trust for
jumping to a step.

## 4. Hosts with a store but no adapter (measured 2026-09-28)

`midflight agents` walks 11 host stores on the machine it runs on. On the machine that
built this, it reports:

```
2 of 7 installed agents readable; 4 not installed on this machine.
  ✓ Codex CLI: newest log: 4090 steps, 0 parse errors
  ✓ Claude Code: newest log: 140 steps, 0 parse errors
  - Cursor: Cursor 装在这台机器上，但还没找到 CLI 的对话记录（它们在 ~/.cursor/projects/*/agent-transcripts）
  - Windsurf: Windsurf 装在这台机器上，但 ~/.codeium/windsurf/cascade 下没有会话文件
```

| host | store probed | on this machine | adapter |
|---|---|---|---|
| Codex CLI | `~/.codex/sessions`, `~/.codex/archived_sessions` | 849 rollouts, 678.5 MB | yes — `verified` |
| Claude Code | `~/.claude/projects` | 173 transcripts, 226.9 MB | yes — `verified` |
| Cursor | `~/.cursor/projects/*/agent-transcripts` | no session file yet | ships — `unverified` (0.1.2) |
| Windsurf | `~/.codeium/windsurf/cascade/*.pb` | no session file yet | ships — `unverified`, and provably encrypted (0.1.2) |
| Gemini CLI | `~/.gemini/tmp` | empty | no |
| opencode | `~/.local/share/opencode/storage`, `~/.config/opencode` | empty | no |
| GitHub Copilot CLI | `~/.config/github-copilot` | empty | no |
| Aider | `~/.aider.chat.history.md` | absent | no |
| Continue | `~/.continue` | absent | no |
| Cline | `~/.cline` | absent | no |
| Factory Droid | `~/.factory/sessions` | absent | no |

Four of these are absent because the tool is not installed here, not because midflight
cannot read them. That distinction is the whole point of the table: the counts come from
`statSync` over the real store on every run, so the row is a measurement, not a claim.
The counts drift upward every time the agent writes a session — the numbers above are a
snapshot from 2026-09-28, not invariants. Re-measure with `midflight agents --probe`,
which additionally parses the newest log of every readable host.

**`unverified` is a state, not a shrug.** 0.1.2 added Cursor and Windsurf adapters and
gave both `unverified`, which means: the parser exists and is tested, but it has never run
against a real log of that host, so it is *not* counted as readable. The promotion rule is
mechanical, not a judgement call — the first time one real Cursor `agent-transcripts` file
or one real Windsurf cascade file is parsed on a user's machine, the CI gate
`npm run smoke:real` (`test/smoke-real.test.ts`) has to be extended to cover that host, and
only then does the row read `verified`.

**Windsurf will not become verified by effort.** Its cascade store is encrypted at rest
(measured 7.95 bits/byte on real-shaped bytes; see `docs/FORMATS.md` §4 for sources). The
adapter's job is to *prove* that on your own bytes and refuse politely, which is why the
row can never read "readable". If a future Windsurf version ships a plaintext export,
that is the day the row changes.

**What is not done.** The other seven hosts still have no adapter at all.
`docs/ISSUES/03-third-host-adapter.md` is the intake for one, and the promotion rule in
`docs/BACKLOG.md` (a user who cannot open their own log) is unchanged by this row.
