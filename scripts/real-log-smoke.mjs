#!/usr/bin/env node
// Parse every real agent session log on this machine and fail if any one of them is
// mis-parsed. This exists because the unit suite could not catch the bug it guards:
// 135 tests over hand-made fixtures stayed green while `node:readline` was quietly
// corrupting real Codex rollouts that carried a U+2028 inside a tool output. Fixtures
// prove the parser handles the cases someone thought to write down; only real logs
// prove it handles the ones nobody did.
//
//   node scripts/real-log-smoke.mjs               # every session found
//   node scripts/real-log-smoke.mjs --limit 40    # the 40 largest, for a fast CI run
//   MIDFLIGHT_SMOKE_ROOTS=a:b node scripts/real-log-smoke.mjs
//
// Exits 0 with REAL-LOG-OK when clean, 1 on any failure, and prints REAL-LOG-SKIP
// (exit 0) when the machine simply has no agent logs — a green machine is not a red gate.
import { parseSession } from '../dist/adapters/index.js';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const argv = process.argv.slice(2);
const limitIdx = argv.indexOf('--limit');
const limit = limitIdx === -1 ? Infinity : Number(argv[limitIdx + 1]);

const roots = (process.env.MIDFLIGHT_SMOKE_ROOTS || [join(homedir(), '.claude/projects'), join(homedir(), '.codex/sessions')].join(':')).split(':').filter(Boolean);

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && p.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// The limit is applied after the merge and the sort, never during the walk: a per-root
// cap silently starves whichever root is listed second, which is how a `--limit 40` run
// ended up auditing 40 Claude sessions and no Codex ones at all.
// Biggest first: the large multi-hundred-MB rollouts are where chunking and encoding bugs
// surface, and they are the ones nobody writes a fixture for.
const files = roots
  .flatMap((r) => walk(r))
  .sort((a, b) => { try { return statSync(b).size - statSync(a).size; } catch { return 0; } })
  .slice(0, limit);

if (files.length === 0) {
  console.log('REAL-LOG-SKIP: no agent session logs found under ' + roots.join(', '));
  process.exit(0);
}

let steps = 0, bytes = 0;
const failed = [];
const byAgent = {};
for (const f of files) {
  try { bytes += statSync(f).size; } catch { /* raced with a rotation; skip the size only */ }
  let r;
  try { r = await parseSession(f); }
  catch (e) { failed.push({ f, why: 'threw: ' + e.message }); continue; }
  steps += r.steps.length;
  const a = r.meta.agent || 'unknown';
  byAgent[a] = (byAgent[a] || 0) + 1;
  if (r.parseErrors.length > 0 || r.steps.length === 0) {
    failed.push({ f, why: `${r.parseErrors.length} parse error(s), ${r.steps.length} steps` });
  }
}

const summary = Object.entries(byAgent).map(([k, v]) => `${k}=${v}`).join(' ');
if (failed.length > 0) {
  console.error(`REAL-LOG-FAIL: ${failed.length} of ${files.length} real session(s) mis-parsed`);
  for (const x of failed.slice(0, 20)) console.error('  ' + x.why + ' :: ' + x.f);
  if (failed.length > 20) console.error(`  ... and ${failed.length - 20} more`);
  process.exit(1);
}
console.log(`REAL-LOG-OK n=${files.length} ${summary} steps=${steps} bytes=${(bytes / 1e9).toFixed(2)}GB`);
