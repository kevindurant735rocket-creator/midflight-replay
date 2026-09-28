/**
 * The install surface: one self-contained skill file, written wherever an agent
 * looks for skills.
 *
 * Why a skill and not a wrapper/hook: midflight reads the log the agent already
 * writes, so there is nothing to intercept and no process to break. The only
 * thing missing for "works inside my agent" is a set of instructions the agent
 * can read — that is exactly what a skill is. No network, no daemon, no config
 * mutation, no hook, and it is one file the user can read before installing.
 */

import { mkdirSync, writeFileSync, existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

export const SKILL_NAME = 'midflight-replay';

export interface InstallTarget {
  id: string;
  label: string;
  /** home-relative directory the skill goes into */
  dir: string;
  /** what this host actually calls the file, verified per host */
  filename: string;
  /** the file must carry this frontmatter for the host to load it */
  needsFrontmatter: 'name+description' | 'description-only' | 'none';
}

export const TARGETS: InstallTarget[] = [
  {
    id: 'codex',
    label: 'Codex CLI',
    dir: '.codex/skills',
    filename: 'SKILL.md',
    needsFrontmatter: 'name+description',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    dir: '.claude/skills',
    filename: 'SKILL.md',
    needsFrontmatter: 'name+description',
  },
  {
    id: 'opencode',
    label: 'opencode',
    dir: '.config/opencode/skill',
    filename: 'SKILL.md',
    needsFrontmatter: 'name+description',
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    dir: '.gemini/skills',
    filename: 'SKILL.md',
    needsFrontmatter: 'name+description',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    dir: '.cursor/rules',
    filename: 'midflight-replay.mdc',
    needsFrontmatter: 'description-only',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    dir: '.codeium/windsurf/rules',
    filename: 'midflight-replay.md',
    needsFrontmatter: 'description-only',
  },
  {
    id: 'copilot',
    label: 'GitHub Copilot',
    dir: '.github/prompts',
    filename: 'midflight-replay.prompt.md',
    needsFrontmatter: 'none',
  },
];

function frontmatter(name: string, description: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n`;
}

function cursorFrontmatter(description: string): string {
  return `---\ndescription: ${description}\nalwaysApply: false\n---\n\n`;
}

export function buildSkill(target: InstallTarget, version: string): string {
  const description =
    'Audit a finished AI coding-agent session as a single scrubbable HTML file. ' +
    'Use when the user asks what an agent actually did, wants a session postmortem, ' +
    'needs a PR review comment from a session log, or asks to revert/undo an agent edit.';
  const body = `# midflight — forensic replay for AI coding-agent sessions

Version baked in: ${version}. Binary: \`midflight\` (npm package \`midflight-replay\`).

## When to use this

The user is asking what an agent **actually did**, not what it said it did. Typical
phrases: "把这个会话复盘一下", "review what the agent changed", "why did it loop",
"post a summary on the PR", "undo that edit". If they only want a code review of the
current diff, this skill is the wrong tool — read the diff.

## 1. Find the session log — do not guess the path

\`\`\`bash
midflight agents            # what this machine has, and which agents are readable
midflight agents --json     # same, machine-readable
\`\`\`

That command walks the real stores on this machine and prints counts. Take the
\`newest\` path it prints for the agent in question. Never hardcode a date path; a
session written today is not under last year's folder.

## 2. Prove the log parses before you promise anything

\`\`\`bash
midflight doctor <session.jsonl> --json
\`\`\`

\`ok:true\` means zero parse errors and at least one step. If \`ok:false\`, report the
\`parseErrors\` count and stop — do not hand the user a report built from a broken parse.
Coverage is per-agent and printed as \`full\` / \`partial\` / \`diff-only\` / \`no-edits\`;
quote it to the user instead of implying every edit is reversible.

## 3. Build the replay

\`\`\`bash
midflight replay <session.jsonl> --out replay.html     # scrubbable, one file, no assets
midflight replay <session.jsonl> --paste > digest.html # GitHub-safe, for a PR comment
midflight postmortem <session.jsonl> --json             # loops, repeat edits, context pressure
\`\`\`

Redaction is ON by default: home paths collapse and token-shaped strings are replaced
before anything reaches the file. The summary is printed on stderr as JSON with
\`--json\` — report \`kept\`, \`total\` and \`coverage\` verbatim.

## 4. Undo an edit, safely

\`\`\`bash
midflight revert <replay.html> --list                 # what is reversible, and why not
midflight revert <replay.html> --step <n> --out p.diff
\`\`\`

\`revert\` **never writes the working tree**. It prints a unified patch. The user
applies it. If \`--list\` refuses a step, say which of the 7 refusal codes applied
(\`NO_BEFORE_IMAGE\`, \`TREE_DIVERGED\`, \`TREE_UNREADABLE\`, \`EMPTY_DIFF\`,
\`NO_FILE_PATH\`, \`NOT_A_FILE_EDIT\`, \`STEP_OUT_OF_RANGE\`) — do not retry a refusal
with a hand-rolled diff.

## Rules

- Everything runs locally. No network, no telemetry, no database, no runtime dependencies.
- A number the user sees must come from a command in this session, not from memory.
- Coverage is not \`full\` unless the command said \`full\`. \`diff-only\` means the log
  never carried before-images; say so instead of showing an empty diff and calling it clean.
`;
  switch (target.needsFrontmatter) {
    case 'name+description':
      return frontmatter(SKILL_NAME, description) + body;
    case 'description-only':
      return cursorFrontmatter(description) + body;
    default:
      return body;
  }
}

export interface InstallResult {
  target: InstallTarget;
  path: string;
  bytes: number;
  /** false when an identical file was already there */
  written: boolean;
  /** set when a different file was there and --force was not given */
  conflict?: string;
}

export interface InstallOptions {
  homeDir: string;
  version: string;
  /** overwrite a different existing file */
  force?: boolean;
}

export function installSkill(target: InstallTarget, opts: InstallOptions): InstallResult {
  const dir = join(opts.homeDir, target.dir, SKILL_NAME);
  const path = join(dir, target.filename);
  const content = buildSkill(target, opts.version);
  // One unit for `bytes` on every path: UTF-8 octets. `readFileSync(...).length` counts
  // UTF-16 code units, so the same field meant two different numbers depending on whether
  // the file already existed — a test caught that, not a human reading the table.
  const contentBytes = Buffer.byteLength(content, 'utf8');
  const exists = existsSync(path);
  if (exists) {
    const prev = readFileSync(path, 'utf8');
    const prevBytes = Buffer.byteLength(prev, 'utf8');
    if (prev === content) return { target, path, bytes: prevBytes, written: false };
    if (!opts.force) {
      return {
        target,
        path,
        bytes: prevBytes,
        written: false,
        conflict: 'a different file is already there; re-run with --force to replace it',
      };
    }
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, 'utf8');
  return { target, path, bytes: contentBytes, written: true };
}

/** All targets whose parent host directory exists, i.e. hosts plausibly installed here. */
export function presentTargets(homeDir: string): InstallTarget[] {
  return TARGETS.filter((t) => {
    const parent = join(homeDir, dirname(t.dir));
    try {
      return statSync(parent).isDirectory();
    } catch {
      return false;
    }
  });
}
