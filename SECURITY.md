# Security Policy

## What this tool does with your data: nothing

`midflight` reads session logs that already sit on your machine and writes one
HTML file next to them. That is the whole data flow.

| | |
|---|---|
| Network calls | none, at runtime or at install time |
| Telemetry | none — there is no code path that opens a socket |
| Database | none |
| Runtime dependencies | none (`package.json` has no `dependencies`) |
| Redaction | **on by default** — home paths, tokens, emails and long hex strings are replaced before anything is written; `--no-redact` turns it off |

The one thing that leaves your machine is whatever you do next: attaching a
report to a pull request, or running it through the optional GitHub Action.
The report is the output, so treat it exactly as you would treat a screenshot
of your own terminal.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/kevindurant735rocket-creator/midflight-replay/security/advisories/new)
rather than a public issue. Include the input that triggers it and the output
you got. You will get an acknowledgement within 7 days.

## Supported versions

Only the latest published version is supported. Fixes land in `main` first and
ship in the next release.

## The GitHub Action

`.github/workflows/` and `action.yml` are part of this repo. If you use the
Action, the report artifact is uploaded to *your* repository's Actions storage
under *your* retention policy — this project's maintainers never see it.
