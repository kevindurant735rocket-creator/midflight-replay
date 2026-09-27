# Known gaps — measured, not guessed

Every row was checked against a real session on this machine. If a row stops being
true, the row gets deleted in the same commit that fixes it. Numbers are reproducible
with the command in the "how it was measured" column.

Reference sessions:

| id | host | file | size |
|---|---|---|---|
| **C** | claude-code | `~/.claude/projects/-Users-zhangfengrui/88095c95-….jsonl` | 32 MB, 3,632 steps |
| **X** | codex | `~/.codex/sessions/2026/09/23/rollout-2026-09-23T16-24-08-01a0b440-….jsonl` | 110 MB, 14,905 steps |

## 1. Not recovered: `~/.claude/file-history` before-images

**What exists.** Claude Code writes a before-image backup for every file it edits, under
`~/.claude/file-history/<sessionId>/<hash>@v<n>`, and points at it from a
`file-history-delta` record in the transcript. On session **C** that is 71 backup files
(1.7 MB), and `delta.messageId` matched an `assistant` record's `uuid` **13 / 13** — the
join is exact, not heuristic.

**Why midflight does not read it.** The 12 distinct `trackingPath` values in those deltas
are *all* already covered by an `Edit`/`Write` tool_use whose arguments already carry
`old_string`. Reading the backup would therefore add **0** reversible diffs that the
transcript does not already support. The records are classified as chrome, not as steps.

**How it was measured.**

```sh
node -e 'const fs=require("fs");const f=process.argv[1];let d=0;const s=new Set();
for(const l of fs.readFileSync(f,"utf8").split("\n")){try{const o=JSON.parse(l);
if(o.type==="file-history-delta"){d++;s.add(o.trackingPath)}}catch{}}
console.log("deltas",d,"paths",s.size)' \
  ~/.claude/projects/-Users-zhangfengrui/88095c95-7e96-4d89-9acf-c000e4d4c86a.jsonl
ls ~/.claude/file-history/88095c95-7e96-4d89-9acf-c000e4d4c86a | wc -l   # → 71
```

**When it would matter.** A Claude session whose transcript was rotated or truncated
while the backups survived, or a host that edits without logging `old_string`. That is a
real scenario, and it is a planned feature, not a permanent "no".

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
