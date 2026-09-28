# Add a host adapter for a session format we cannot open (P2-1)

Currently supported: `claude-code`, `codex`. If your agent writes a log we cannot
parse, this is the issue to file.

**Please include**, because it decides whether it is a real gap or a bug:

- the output of `midflight agents` from your machine (it names the store and the
  newest log path, so you do not have to hunt for it)
- the absolute path to one real log file, or its first 3 lines with secrets
  redacted
- the tool/CLI name and version that wrote it
- `midflight doctor <file> --json` output, if it runs at all

`cc-sessions-viewer` already advertises 7 hosts, so adapter count is deliberately
**not** our differentiator — see `docs/COMPETITIVE.md` §3.2. We add a host when a
real user cannot open their own log, not to win a count.

Note the promotion rule in `docs/BACKLOG.md`: a named host we cannot open at all
promotes this row immediately, ahead of anything scheduled behind it.

Source: `docs/BACKLOG.md` P2-1, `docs/FORMATS.md`.

**Status 2026-09-28.** The gap is now measurable per machine rather than per guess:
`midflight agents` probes 11 host stores and prints, with real counts, which ones exist
here and which have no adapter — on the build machine it reports `2 of 3 installed
agents readable`, with Cursor counted and named as `no adapter (1 file found)`. The
registry rows also carry the reason a host is unsupported, so a filer can see whether
the blocker is "not supported yet" or "your agent writes no log at all"
(`docs/KNOWN-GAPS.md` §4). Still not a third adapter: no user has filed one, and the
promotion rule above is unchanged.
