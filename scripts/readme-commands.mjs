#!/usr/bin/env node
/**
 * README-commands gate.
 *
 * A README command that does not run is the cheapest way to lose a visitor:
 * the first 60 seconds of this project's pitch is a copy-paste. So every
 * `midflight` / `npx midflight-replay` line in README.md is executed here
 * against the real binary and must exit 0.
 *
 * Rules:
 *   - `npx midflight-replay` and `midflight` are rewritten to the built CLI, so
 *     the check exercises dist/, not a globally installed copy.
 *   - `midflight install ...` gains `--dry-run`: the README must be verified
 *     without writing into the operator's real agent config.
 *   - `$(ls -t <glob> | head -1)` and bare globs are expanded for real, so the
 *     glob shape in the README is what gets tested.
 *   - `<session>`-style placeholders resolve to a fixture or a real log.
 *   - Output paths are redirected into a throwaway temp dir.
 *
 * The scan covers the WHOLE document, not just ```bash fences: a command a
 * reader can copy lives in whatever fence the author felt like, and a gate that
 * only looks in one place is green because it never saw the rot. Every
 * `midflight` token in the file is counted, and the count must reconcile with
 * what the gate actually ran, so a new command shape cannot slip in unexecuted.
 *
 * A token is a COMMAND when it starts a line, after stripping markdown list /
 * quote markers, a leading `$ ` shell prompt, a leading backtick, and a
 * `/usr/bin/time` wrapper. Everything else is a prose mention -- the README
 * legitimately writes "midflight is forensic" in sentences. Prose mentions are
 * counted, not run, with one exception: a prose code span carrying a command
 * FLAG (`midflight --nope` buried in a sentence) is copy-paste bait, so it
 * fails instead of hiding.
 *
 * Exit 0 only when every extracted command runs clean and the token ledger
 * balances.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const FIXTURE = join(ROOT, 'fixtures', 'codex-mini.jsonl');
// A 3-step log whose one Edit writes demo-workspace/index.html by a RELATIVE
// path, so `revert` can be reproduced anywhere: the gate writes the file the
// session wrote and undoes it for real. Without this, every revert line in the
// README depends on a file that happened to still exist on the author's disk.
const REVERT_FIXTURE = join(ROOT, 'fixtures', 'revert-demo.jsonl');
const REVERT_TARGET = 'demo-workspace/index.html';
// Mirrors fixtures/revert-demo.jsonl's new_string.
const REVERT_AFTER = '<title>midflight demo</title>\n<script>const f = () => { return 1; };</script>\n';
const REVERT_STEP = 2;
const CODEX_SESSIONS = join(homedir(), '.codex', 'sessions');
const CLAUDE_PROJECTS = join(homedir(), '.claude', 'projects');

if (!existsSync(CLI)) {
  console.error('README-CMDS-FAIL dist/cli.js missing — run `npm run build` first');
  process.exit(1);
}
if (!existsSync(FIXTURE)) {
  console.error(`README-CMDS-FAIL fixture missing: ${FIXTURE}`);
  process.exit(1);
}

/** First *.jsonl under `dir`, searched a few levels deep. Returns null if none. */
function firstSessionUnder(dir) {
  if (!existsSync(dir)) return null;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      const hit = firstSessionUnder(full);
      if (hit) return hit;
      continue;
    }
    if (entry.endsWith('.jsonl') && st.size > 0) return full;
  }
  return null;
}

// Expand a shell-ish glob (segments containing `*`) to a real file, so the
// glob shape printed in the README is the shape that gets executed.
function expandGlob(pattern) {
  const segs = pattern.split('/').filter(Boolean);
  let frontier = ['/'];
  for (const seg of segs) {
    const next = [];
    for (const base of frontier) {
      if (!existsSync(base)) continue;
      if (seg.includes('*')) {
        const re = new RegExp('^' + seg.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        for (const e of readdirSync(base)) if (re.test(e)) next.push(join(base, e));
      } else {
        const q = join(base, seg);
        if (existsSync(q)) next.push(q);
      }
    }
    frontier = next;
  }
  for (const p of frontier) {
    try {
      if (p.endsWith('.jsonl') && statSync(p).isFile() && statSync(p).size > 0) return p;
    } catch { /* vanished between readdir and stat */ }
  }
  return null;
}

const HOST_STORES = ['.codex', '.claude', '.config/opencode', '.gemini', '.cursor', '.codeium', '.github'];
const ANY_HOST_STORE = HOST_STORES.some((d) => existsSync(join(homedir(), d)));
const SKIP = '\u0000no-agent-logs\u0000'; // sentinel: string-safe, survives later replaces
const CODEX_REAL = firstSessionUnder(CODEX_SESSIONS);
const CLAUDE_REAL = firstSessionUnder(CLAUDE_PROJECTS);

// Any mention of the tool, anywhere: prose, fences, alt text, tables.
const CMD_TOKEN = /\b(?:npx\s+(?:midflight-replay|github:[\w.-]+\/[\w.-]+)|midflight)(?=[\s`])/g;
// Same pattern without /g: .test() on a global regex is stateful, which is a
// class of bug that only shows up on the machine where it is least wanted.
const MENTIONS_TOOL = /\b(?:npx\s+(?:midflight-replay|github:[\w.-]+\/[\w.-]+)|midflight)(?=[\s`])/;
const CMD_START = /^(?:npx\s+midflight-replay|npx\s+github:[\w.-]+\/[\w.-]+|midflight)\s/;

/**
 * Strip the decoration an author puts in front of a command without changing
 * the command itself: list bullets, blockquote bars, a shell prompt, a stray
 * opening backtick, and a timing wrapper (the RSS line is `/usr/bin/time -l
 * npx midflight-replay ...`; the gate must run the command, not `time`).
 */
function normalizeLine(raw) {
  return raw
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)+/, "")
    .replace(/^`+/, "")
    .replace(/^\$\s+/, "")
    .replace(/^(?:\/usr\/bin\/)?time\s+(?:-[A-Za-z]+\s+)*/, "")
    .trim();
}

/**
 * @returns {{commands: string[], tokens: number, prose: string[]}}
 *   commands: one entry per command line (whole document, any fence)
 *   tokens:    every command mention in the file, for the completeness ledger
 *   prose:     mentions that are not commands (sentences, alt text, tables)
 */
/**
 * A usage table pads the command out to a column and then describes it:
 * `midflight stats  <session.jsonl> [--json]    print step counts`. Only the
 * left part is a command. The prefix is GREEDY, so the last column gap wins and
 * an internal double space (`revert  <report.html>`) stays inside the command.
 */
function cutDescription(line) {
  const m = line.match(/^(.*\S)[ \t]{2,}\S/);
  return m ? m[1].trimEnd() : line.trimEnd();
}

function extractCommands(md) {
  const commands = [];
  const prose = [];
  let tokens = 0;
  let inFence = false;
  md.split("\n").forEach((raw, i) => {
    tokens += (raw.match(CMD_TOKEN) || []).length;
    if (/^\s*(?:```|~~~)/.test(raw)) { inFence = !inFence; return; }
    const line = normalizeLine(raw);
    if (CMD_START.test(line)) {
      // Inside a fence the author is writing code, so the line is a command.
      // Outside one, the same shape is usually a sentence -- "midflight reads the
      // log the agent already writes" -- so outside a fence a command has to look
      // like an argument list: a backtick means the author is quoting the tool,
      // and a long tail is a clause. Everything else is run, so rot in a shape
      // this rule has never seen still goes red.
      const tailWords = line.replace(CMD_START, '').trim().split(/\s+/).filter(Boolean).length;
      if (inFence || !(raw.includes('`') || tailWords > 6)) {
        commands.push(cutDescription(line));
        return;
      }
      prose.push(`${i + 1}: ${raw.trim()}`);
      return;
    }
    // A prose mention that carries a command flag is a command someone will
    // paste. Refuse to pretend it does not exist.
    for (const span of raw.matchAll(/`([^`\n]+)`/g)) {
      if (MENTIONS_TOOL.test(span[1]) && /(^|\s)-{1,2}[A-Za-z][\w-]*/.test(span[1])) {
        throw new Error(
          `README line ${i + 1} hides a command in a sentence, where the gate would ` +
          `never run it: \`${span[1].trim()}\` -- move it to a code block`
        );
      }
    }
    if (MENTIONS_TOOL.test(raw)) prose.push(`${i + 1}: ${raw.trim()}`);
  });
  return { commands, tokens, prose };
}

/** Strip a trailing `# ...` shell comment so it never runs. */
function stripComment(line) {
  return line.replace(/\s+#.*$/, '').trim();
}

function rewrite(line, tmp) {
  let cmd = stripComment(line);
  cmd = cmd
    .replace(/^npx\s+midflight-replay\s+/, `${CLI} `)
    .replace(/^npx\s+github:[\w.-]+\/[\w.-]+\s+/, `${CLI} `)
    .replace(/^midflight\s+/, `${CLI} `);

  // never write into the operator's real agent config from a README check
  if (/\binstall\b/.test(cmd)) {
    // `midflight install` with no target resolves against the hosts present on
    // this machine, so on a box with no agent installed it has nothing to do and
    // exits non-zero. That is the machine, not a broken README line.
    if (!ANY_HOST_STORE) return SKIP;
    if (!/\s--dry-run(\s|$)/.test(cmd)) cmd += ' --dry-run';
  }

  // `$(ls -t <glob> | head -1)` — keep the documented shape, feed a real path
  cmd = cmd.replace(/\$\(ls -t\s+(\S+)\s*\|\s*head\s+-?1\)/g, (_, glob) => {
    const hit = expandGlob(glob.replace(/^~(?=\/)/, homedir()));
    if (!hit) {
      // No agent logs on this machine is a skip (CI, a fresh laptop), not a
      // broken README. A glob that matched nothing while the store exists IS
      // rot -- usually a hardcoded date -- so that still fails.
      if (!existsSync(CODEX_SESSIONS) && !existsSync(CLAUDE_PROJECTS)) return SKIP;
      throw new Error(`glob in README matched no real session file: ${glob}`);
    }
    return hit;
  });

  // `~/.../<session>.jsonl` and `~/.../rollout-....jsonl` — documented shapes
  cmd = cmd.replace(/~\/\.claude\/projects\/[^ ]*<session>\.jsonl/g, CLAUDE_REAL ?? FIXTURE);
  cmd = cmd.replace(/~\/\.codex\/sessions\/[^ ]*rollout-[\w.-]*\.jsonl/g, CODEX_REAL ?? FIXTURE);
  // quoted "$HOME"/.claude/projects/*/*.jsonl and friends
  cmd = cmd.replace(/"?\$HOME"?\/(\.claude\/projects|\.codex\/sessions)\/\S*?\*\S*?\.jsonl/g, (m) => {
    const rel = m.replace(/^"?\$HOME"?\//, '').replace(/"/g, '');
    const hit = expandGlob(join(homedir(), rel));
    if (!hit) {
      if (!existsSync(CODEX_SESSIONS) && !existsSync(CLAUDE_PROJECTS)) return SKIP;
      throw new Error(`glob in README matched no real session file: ${rel}`);
    }
    return hit;
  });
  // bare placeholders
  cmd = cmd.replace(/<session\.jsonl>|\bsession\.jsonl\b/g, FIXTURE);
  // The report the revert lines act on, and the step number they name. Both are
  // pinned to REVERT_FIXTURE, so a doc that drifts from the fixture goes red.
  cmd = cmd.replace(/<report\.html>|\breport\.html\b/g, join(tmp, 'report.html'));
  cmd = cmd.replace(/<n>/g, String(REVERT_STEP));

  // redirect every artefact into the throwaway dir
  cmd = cmd.replace(/--out\s+(\S+)/g, (_, f) => `--out ${join(tmp, basename(f))}`);
  cmd = cmd.replace(/>\s*(\S+\.html)/g, (_, f) => `> ${join(tmp, basename(f))}`);

  if (/[<>]/.test(cmd.replace(/[<>]\//g, ''))) {
    // any leftover placeholder means the substitution table missed something
    const leftover = cmd.match(/<[^>\s]+>/);
    if (leftover) throw new Error(`unsubstituted placeholder ${leftover[0]}`);
  }
  return cmd;
}

const readmeArg = process.argv.indexOf('--readme');
const readmePath = readmeArg === -1 ? join(ROOT, 'README.md') : resolve(process.argv[readmeArg + 1] ?? '');
if (!existsSync(readmePath)) {
  console.error(`README-CMDS-FAIL no such README: ${readmePath}`);
  process.exit(2);
}
const md = readFileSync(readmePath, 'utf8');
let extracted;
try {
  extracted = extractCommands(md);
} catch (err) {
  console.error(`README-CMDS-FAIL ${err.message}`);
  process.exit(1);
}
const { commands, tokens, prose } = extracted;
if (commands.length === 0) {
  console.error('README-CMDS-FAIL no midflight commands found in README.md — the gate is broken, not the README');
  process.exit(1);
}
// Completeness ledger. The point of the gate is that NOTHING in the file is
// silently unexecuted, so the two counts come from one tokenizer over one
// document and must add up exactly. If a future extractor change makes them
// disagree, that is the bug this line exists to catch.
const commandTokens = md.split('\n')
  .filter((raw) => CMD_START.test(normalizeLine(raw)))
  .reduce((n, raw) => n + (raw.match(CMD_TOKEN) || []).length, 0);
const proseTokens = tokens - commandTokens;
if (commandTokens + proseTokens !== tokens) {
  console.error(`README-CMDS-FAIL token ledger does not balance: ${commandTokens} + ${proseTokens} != ${tokens}`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'midflight-readme-'));
try {
  mkdirSync(join(tmp, dirname(REVERT_TARGET)), { recursive: true });
  writeFileSync(join(tmp, REVERT_TARGET), REVERT_AFTER);
  execFileSync(CLI, ['replay', REVERT_FIXTURE, '--out', join(tmp, 'report.html')], { stdio: 'pipe' });
} catch (err) {
  rmSync(tmp, { recursive: true, force: true });
  console.error(`README-CMDS-FAIL cannot set up the revert demo: ${err.message}`);
  process.exit(1);
}
const failures = [];
let ran = 0;
let skipped = 0;
try {
  for (const raw of commands) {
    let cmd;
    try {
      cmd = rewrite(raw, tmp);
    } catch (err) {
      failures.push({ raw, why: `rewrite: ${err.message}` });
      continue;
    }
    if (cmd.includes(SKIP)) {
      skipped++;
      continue;
    }
    try {
      execFileSync('/bin/sh', ['-c', cmd], { cwd: tmp, stdio: 'pipe', timeout: 120_000 });
      ran++;
    } catch (err) {
      const why = `${err.status ?? 'signal'} ${(err.stderr || Buffer.alloc(0)).toString().trim().split('\n').slice(-2).join(' | ')}`;
      failures.push({ raw, cmd, why });
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

for (const f of failures) {
  console.error(`FAIL  ${f.raw}`);
  if (f.cmd) console.error(`  as: ${f.cmd}`);
  console.error(`  rc: ${f.why}`);
}
if (skipped) console.log(`  (${skipped} command(s) skipped: no agent logs on this machine)`);
console.log(`  ledger: ${tokens} mention(s) = ${commandTokens} on ${commands.length} command line(s) + ${proseTokens} prose`);
if (failures.length) {
  console.error(`README-CMDS-FAIL ${ran}/${commands.length} README commands run clean`);
  process.exit(1);
}
console.log(`README-CMDS-OK n=${ran} of ${commands.length} command lines (every command in ${basename(readmePath)} exits 0; ${prose.length} prose mention(s) accounted for)`);
