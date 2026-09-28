#!/usr/bin/env node
/**
 * AC1: prove the tool reads a real agent log and writes a real report.
 *
 * Deliberately a file instead of an inline `node -e`: shell-quoting a JSON parser into a
 * one-liner is how a green check turns into a syntax error nobody reads. This picks the
 * newest real Codex rollout, runs the two commands a user would run, and prints one line.
 * No real session on this machine -> rc=1 with the reason, never a silent pass.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(homedir(), '.codex', 'sessions');
function newest() {
  // ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl — walk it instead of assuming the depth,
  // because the depth is a Codex implementation detail and this file only needs the newest.
  const files = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.endsWith('.jsonl')) files.push({ p, m: statSync(p).mtimeMs });
    }
  };
  if (!existsSync(root)) return null;
  walk(root, 0);
  files.sort((a, b) => b.m - a.m);
  return files[0]?.p ?? null;
}

const file = newest();
if (!file) {
  console.error('no real Codex session under ~/.codex/sessions');
  process.exit(1);
}

// fileURLToPath, not `new URL(...).pathname`: the repo can live at a path with non-ASCII
// characters (this one is ~/Desktop/项目/agent-replay) and .pathname percent-encodes them
// into %E9%A1%B9%E7%9B%AE, which node then cannot resolve. Cost one confusing MODULE_NOT_FOUND.
const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));
const run = (args) => execFileSync(process.execPath, [cli, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });

const doc = JSON.parse(run(['doctor', file, '--json']));
if (doc.ok !== true || !(doc.steps > 0) || !(doc.bytes > 0)) {
  console.error(`doctor rejected a real file: ok=${doc.ok} steps=${doc.steps} bytes=${doc.bytes}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'midflight-acc-'));
const out = join(dir, 'replay.html');
run(['replay', file, '--out', out]);
const size = statSync(out).size;
if (size <= 0) {
  console.error(`replay wrote an empty report for ${file}`);
  process.exit(1);
}
rmSync(dir, { recursive: true, force: true });
console.log(`adapter=${doc.adapter} steps=${doc.steps} log=${(doc.bytes / 1048576).toFixed(1)}MiB report=${(size / 1048576).toFixed(2)}MiB`);
