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

## 5. No undo button, by design

The report is a read-only artefact. It proves what happened; it does not write to the
working tree. A future `midflight revert` is out of scope until the before-image story
above is settled.
