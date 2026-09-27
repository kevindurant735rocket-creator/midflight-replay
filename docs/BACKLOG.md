# Backlog — the post-launch board

This file is the *input side* of "从 star 反馈反推迭代". It exists so that, the day
the repo goes public, star/issue signals land in a place that already knows how to
rank them instead of a place that starts arguing from scratch.

The P0 and P2 rows below are already written up as filing-ready issues in
[`docs/ISSUES/`](ISSUES/); `scripts/release.sh` prints the `gh issue create` line
for each one on launch day. They are filed by hand on purpose — a tracker that
fills itself before anyone has used the tool reads as vapourware.

Two rules, both inherited from [KNOWN-GAPS.md](KNOWN-GAPS.md):

1. **A row is either measured or it is not on the board.** No "should be easy".
   Every P0/P1 below already has a measured reason attached.
2. **A row leaves this file in the same commit that closes it.** Deleting a row is
   the completion signal; the CHANGELOG entry is the receipt.

## Ranking key

`impact = (# of users who hit it) × (how loud they are) ÷ (days of work)`

Stars are a *distribution* signal, not a *requirements* signal. A row only moves
when it is backed by an issue, a reproduction, or a measured gap. Star count alone
never promotes a row — that is how projects end up building for the loudest 3
people instead of the median 300.

## P0 — blocking, already known, not yet done

| # | Row | Why it is P0 (measured) | Source |
|---|---|---|---|
| P0-1 | ~~Read Claude Code `~/.claude/file-history` before-images~~ | **DONE 2026-09-27.** `src/filehistory.ts` joins `delta.messageId`→`assistant.uuid`→`tool_use.file_path`. 274/274 messageIds resolve across 40 sessions; 25/25 paths match. Rescue proven by stripping `old_string` from session 671a21ed: `backups=113 joined=55 recovered=55` (that session had 0 reversible edits before). 55 edits now render real del/add, badged as backup-sourced. | closed |
| P0-2 | `midflight revert` | **Unblocked by P0-1.** The before-image source is now real and, for backup-joined edits, whole-file. The report is still read-only by design, which is correct; the inverse is the next capability. Note the ceiling: a revert is only as good as the before-image, so backup-only edits (no inline `old_string`) are the ones worth gating hardest. | KNOWN-GAPS §5 |

## P1 — the two facts the competitive scan says decide this project's ceiling

| # | Row | Why P1 | Source |
|---|---|---|---|
| P1-1 | Keep a canonical HTML sample per host in `docs/` | The 8 competitors with stars all ship a screenshot or a recording above the fold. Ours now leads with the 109 MiB Codex replay + a real `demo.webm`; the copy in the README must keep matching `docs/demo/*` or it rots. | COMPETITIVE §3.5 |
| P1-2 | Land every user-visible fix in the CHANGELOG **and** in the README's numbers | `Agent-Blackbox` (76★, 31k-char README, 4 languages) has not pushed in 2 months. Being visibly alive is a differentiator in a category where the leaders are stalled. | COMPETITIVE §3.5 |

## P2 — queued, not started, deliberately

| # | Row | Trigger to promote it |
|---|---|---|
| P2-1 | Third host adapter (opencode / grok / antigravity) | `cc-sessions-viewer` already covers 7 hosts, so adapter count is **not** a differentiator. Promote only if a user files an issue naming a host we cannot open at all. | COMPETITIVE §3.2 |
| P2-2 | Live tail / SSE | `codex-trace` (110★) has it. Promote only on demand; it turns a single-file artefact into a server, which contradicts the zero-network claim. | COMPETITIVE §1 |
| P2-3 | Time-travel / fork | `OrcaReplay` (268★), `rewind` (13★), `clay-good/agent-replay` (14★) already occupy it. Necessary, never sufficient — do not put it in the README headline. | COMPETITIVE §3.3 |
| P2-4 | Token attribution instead of character mass | Blocked on the hosts actually logging tokens per source. Today they do not; the report says so on every page. | KNOWN-GAPS §3 |

## The star-feedback loop (to be filled the day the repo is public)

Columns to maintain in the GitHub issue tracker, not here — this file only records
the *ranking rule*, so the rule cannot drift with the volume.

| Signal | Where it lands | Moves a row when |
|---|---|---|
| 👍 on an issue | issue reactions | ≥ 5 distinct users on the same ask |
| A named host we cannot open | bug report | P2-1 fires immediately |
| "It opened but X is wrong" | bug report | anything touching the coverage bar (§2, §4) |
| Download-vs-star ratio | npm weekly + repo stars | < 1:3 means the README is not converting; fix the README, not the roadmap |

## What is deliberately *not* on this board

Anything that cannot be measured on a real session log, and anything that would put
a network call, a server, or a runtime dependency between a user and the artefact.
Those three are the product ([README](../README.md#the-two-outputs)), not preferences.
