# Contributing to midflight

Thanks for looking. Read this first — it is short and the constraints are real.

## The two constraints that are the product

midflight ships **zero runtime dependencies** and makes **zero network requests**.
These are not preferences. They are the reason the tool can be forwarded, archived,
run air-gapped, and trusted with a session log full of secrets.

- A PR that adds a runtime dependency to `package.json` `dependencies` will not merge.
  devDependencies for building and testing are fine.
- Any code path that opens a socket will not merge. If you need data from somewhere,
  the user passes it in as a file path.

If a change seems to require breaking one of these, open an issue first and argue it
there, in the open, with measurements.

## Getting set up

```bash
npm install
npm run build
npm test                              # unit tests, ~seconds
node scripts/browser-check.mjs a.html b.html   # browser assertions, needs Chromium
```

Node 20+. The repo is not a git-tracked sandbox in every environment, so if
`npm run build` behaves oddly, `rm -rf dist && npm run build` (or `find dist -delete`)
is a safe reset.

## What we care about in review

1. **Honesty over impressiveness.** The coverage verdict exists so midflight never
   overstates what a session log can reconstruct. If your change makes a report look
   better without making it more true, it is wrong.
2. **A claim needs a command.** "Fixed", "handles", "supports" — attach the command
   and its exit code. `rg` and `head` over `cat` when reading large files.
3. **The paste output is contractual.** It is asserted in tests: only whitelisted
   tags, no `on*=`, no `href`/`src`, ≤60KB. Do not relax these to make a feature fit.
4. **Big sessions must not blow up.** Parsing is line-streamed. If your change loads
   a whole file into memory, it will fail the 109MB case.
5. **New adapter?** Open an issue with a redacted snippet of the first 20 lines of the
   format and a real session's step-kind histogram. We add adapters based on measured
   data, not on "it should be easy".

## Commit and PR style

- Conventional-ish prefixes are welcome (`feat:`, `fix:`, `test:`, `docs:`) but not required.
- One concern per PR.
- If it touches parsing, diffs, coverage, or the paste whitelist, say so in the
  description and say which test asserts it.

## Reporting bugs

Open an issue with: agent (codex / claude-code), session size, `midflight doctor
<session.jsonl>` output, and the exact command you ran. Please do not paste a real
session log — a 10-line redacted repro is worth more and leaks nothing.

## Security

If you find a case where the generated HTML makes a network request, or where
redaction leaks a secret, that is a priority fix. Please report it privately to the
maintainers rather than opening a public issue with an exploit.

MIT licensed — see [LICENSE](LICENSE).
