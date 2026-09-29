import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this checkout sits under a Chinese-named directory.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * The person who stars this has 200 MB of agent logs on their disk and no idea
 * which file is "theirs". `midflight replay` answered that question with
 * `error: not a file: ` — an empty path — and `midflight replay ~/.codex/sessions`
 * with `not a file: <a directory holding 900 sessions>`. The help screen's remedy
 * was a four-level glob, which is the one thing a first-time user cannot type.
 *
 * These lock the other half of that bargain: with no argument, or with a directory,
 * every session command finds the newest log this machine actually has and names
 * it out loud, so the first run produces a report instead of an error.
 */
describe('a missing or directory argument finds a real session instead of failing', () => {
  let home: string;
  let session: string;
  let emptyHome: string;

  const run = (args: string[], h = home) =>
    spawnSync(process.execPath, ['dist/cli.js', ...args], {
      encoding: 'utf8',
      env: { ...process.env, HOME: h },
    });

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'mf-home-'));
    emptyHome = mkdtempSync(join(tmpdir(), 'mf-empty-'));
    const dir = join(home, '.codex/sessions/2026/09/29');
    mkdirSync(dir, { recursive: true });
    session = join(dir, 'rollout-2026-09-29T00-00-00-test.jsonl');
    copyFileSync(join(repoRoot, 'fixtures/codex-mini.jsonl'), session);
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(emptyHome, { recursive: true, force: true });
  });

  it('doctor with no argument reads the newest session on this machine', () => {
    const r = run(['doctor']);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(session);
    expect(r.stdout).toContain('能读');
  });

  it('a directory argument is treated as "look inside", not as a bad path', () => {
    const r = run(['doctor', join(home, '.codex/sessions')]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(session);
  });

  it('replay with no argument writes a report', () => {
    const out = join(home, 'report.html');
    const r = run(['replay', '--out', out]);
    expect(r.status).toBe(0);
    // With --out the file is the deliverable and stdout stays clean for pipes,
    // so the human summary is stderr. The report itself is the contract.
    expect(existsSync(out)).toBe(true);
    expect(r.stderr).toContain('已写入');
  });

  it('an explicit file still wins, and says nothing about discovery', () => {
    const r = run(['doctor', join(repoRoot, 'fixtures/codex-mini.jsonl')]);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('--json stays machine-readable: the note goes to stderr, never stdout', () => {
    const r = run(['doctor', '--json']);
    expect(r.status).toBe(0);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout).ok).toBe(true);
  });

  it('a flag value is never mistaken for the session file', () => {
    // `replay --out x` used to hand `x` to the parser as a session: the old arg
    // split dropped `--out` but kept its value, so the CLI read back the HTML it
    // had just written and died on line 3 of it. The README check caught this one.
    const out = join(home, 'flagvalue.html');
    const r = run(['replay', '--out', out]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('invalid JSON');
    expect(readFileSync(out, 'utf8')).toContain('<html');
  });

  it('a machine with no logs explains itself and exits 2, rather than printing an empty path', () => {
    const r = run(['stats'], emptyHome);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('midflight agents --probe');
    expect(r.stderr).not.toContain('not a file: \n');
  });
});
