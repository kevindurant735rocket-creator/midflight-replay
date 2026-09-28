#!/usr/bin/env node
/**
 * AC-3: the browser gate over REAL logs from EVERY host this machine has, not just the
 * two bundled fixtures.
 *
 * The fixture gate answers "does the report work on a session we chose". It cannot answer
 * "does it work on a 90MB Codex rollout and a 12MB Claude transcript at the same time" —
 * which is where a report that renders fine on a small file starts throwing on a real one.
 * A parser bug and a render bug are found in different places, so the gate walks the hosts.
 *
 *   node scripts/browser-real-hosts.mjs            # every host with a real log
 *   node scripts/browser-real-hosts.mjs --per-host # one browser context per host, not one for all
 *
 * Exits 0 with BROWSER-REAL-OK after every produced report passes the real browser, and
 * 0 with BROWSER-REAL-SKIP when this machine has fewer than two readable hosts (CI, a fresh
 * laptop). A machine with no logs is not a red gate; a machine with logs that do not render is.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { scanAgents } from '../dist/agents.js';
import { parseSession } from '../dist/adapters/index.js';

const perHost = process.argv.includes('--per-host');
const outDir = mkdtempSync(join(tmpdir(), 'mf-real-'));

// `status === 'supported'` is the only state that means "an adapter that has run against a
// real log of this host". An `unverified` host is skipped on purpose: its newest file is
// either absent or not the format the parser claims, and rendering it would prove nothing.
const reports = (await scanAgents({ homeDir: process.env.HOME, probe: true })).filter(
  (r) => r.status === 'supported' && r.newest,
);

if (reports.length < 2) {
  const have = reports.map((r) => r.label).join(', ') || 'none';
  console.log(`BROWSER-REAL-SKIP: ${reports.length} readable host(s) with a real log (${have}); need 2 to be a gate`);
  process.exit(0);
}

const made = [];
for (const r of reports) {
  const out = join(outDir, `${r.id}.html`);
  const run = spawnSync(
    process.execPath,
    ['dist/cli.js', 'replay', r.newest, '--out', out],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    console.error(`BROWSER-REAL-FAIL: replay failed for ${r.label}: ${(run.stderr || '').slice(-400)}`);
    process.exit(1);
  }
  const session = await parseSession(r.newest);
  const size = statSync(out).size;
  made.push({ id: r.id, out, label: r.label, steps: session.steps.length, size, errors: session.parseErrors.length });
  console.log(
    `  ${r.label.padEnd(12)} ${basename(r.newest).slice(0, 42).padEnd(44)} ` +
      `${session.steps.length} steps, ${(size / 1024).toFixed(0)} KB html`,
  );
  if (perHost) {
    const one = spawnSync(process.execPath, ['scripts/browser-check.mjs', out], { stdio: 'inherit' });
    if (one.status !== 0) {
      console.error(`BROWSER-REAL-FAIL: ${r.label} report failed the browser gate`);
      process.exit(1);
    }
  }
}

if (!perHost) {
  const all = spawnSync(process.execPath, ['scripts/browser-check.mjs', ...made.map((m) => m.out)], { stdio: 'inherit' });
  if (all.status !== 0) {
    console.error(`BROWSER-REAL-FAIL: ${made.length} real-host report(s) failed the browser gate`);
    process.exit(1);
  }
}

for (const m of made) unlinkSync(m.out);
const badParse = made.filter((m) => m.errors > 0);
if (badParse.length) {
  console.error(`BROWSER-REAL-FAIL: parse errors in ${badParse.map((m) => m.label).join(', ')}`);
  process.exit(1);
}
console.log(`BROWSER-REAL-OK hosts=${made.map((m) => m.id).join('+')} reports=${made.length}`);
