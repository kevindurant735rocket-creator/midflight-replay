# Add a host adapter for a session format we cannot open (P2-1)

Currently supported: `claude-code`, `codex`. If your agent writes a log we cannot
parse, this is the issue to file.

**Please include**, because it decides whether it is a real gap or a bug:

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
