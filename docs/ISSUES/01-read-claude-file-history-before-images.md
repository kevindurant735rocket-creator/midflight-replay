# Read Claude Code `~/.claude/file-history` before-images (P0-1)

`midflight replay` on a Claude Code session currently reports edits without
showing what changed. The before-image is recoverable, and we have already proven
the join works — it is just not wired up.

**The measurement that says this is P0** (run locally, not estimated):

- session C has **71** backup files under `~/.claude/file-history`
- joining `delta.messageId` ↔ `assistant.uuid` matched **13 / 13**
- today that adds **0** diffs *for that specific session*, because Claude Code
  still writes `old_string` inline on that log

**Why that is still P0 rather than P1:** the inline `old_string` is a courtesy of
one host version. Any of these makes the before-image permanently unrecoverable,
and the report silently degrades to a list of file names with no error:

1. the transcript is rotated or truncated by a host update
2. a future CLI version stops writing `old_string`
3. any other host that reports an edit without the old text

A report that quietly loses its most useful column is worse than one that
refuses to open, so the honest fix is to read the backups — and to say in the
report when neither source produced a before-image, instead of rendering an
empty diff that looks like "no change".

**Acceptance** — verifiable, not vibes:

```
midflight doctor <session> --json   # add a fileHistoryBackups / fileHistoryJoins field
```

on a session where the backups exist, the joined count is non-zero and every
joined backup renders a real before/after pair in the HTML. On a session with no
backups, the report says so in the coverage bar.

Rejected alternative: infer the diff from the `Write`/`Edit` tool arguments alone.
That is the thing that is already unreliable, so it is not a fix.

Source: `docs/BACKLOG.md` P0-1, `docs/KNOWN-GAPS.md` §1.
