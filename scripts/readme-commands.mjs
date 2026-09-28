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
 * Exit 0 only when every extracted command runs clean.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'dist', 'cli.js');
const FIXTURE = join(ROOT, 'fixtures', 'codex-mini.jsonl');
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

function extractCommands(md) {
  const out = [];
  for (const block of md.matchAll(/```bash\n([\s\S]*?)```/g)) {
    for (const raw of block[1].split('\n')) {
      const line = raw.trim();
      // `npx github:<owner>/<repo>` is the pre-publish install path, so the README can
      // carry a command that runs today instead of one that 404s until npm publish.
      if (/^(npx\s+midflight-replay|npx\s+github:[\w.-]+\/[\w.-]+|midflight)\s/.test(line)) out.push(line);
    }
  }
  return out;
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
const commands = extractCommands(md);
if (commands.length === 0) {
  console.error('README-CMDS-FAIL no midflight commands found in README.md — the gate is broken, not the README');
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), 'midflight-readme-'));
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
if (failures.length) {
  console.error(`README-CMDS-FAIL ${ran}/${commands.length} README commands run clean`);
  process.exit(1);
}
console.log(`README-CMDS-OK n=${ran} (every midflight command in ${basename(readmePath)} exits 0)`);
