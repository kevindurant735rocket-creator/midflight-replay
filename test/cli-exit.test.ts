import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `midflight replay` returned 0 for any file that existed. Point it at a
 * corrupt log — the one thing a first-time user does when they grab the wrong
 * path — and it printed "wrote replay.html  steps 0/0" and exited 0. An empty
 * report and a successful one were the same exit code and nearly the same
 * sentence, so nothing told the reader their log was unreadable. `doctor`
 * already refused that case; these lock the two together.
 */
describe('replay exit code tells success from an unreadable file', () => {
  let dir: string;
  const run = (file: string, out: string) =>
    spawnSync(process.execPath, ['dist/cli.js', 'replay', file, '--out', out], { encoding: 'utf8' });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mf-cli-exit-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails, and says why in the reader\'s language, when no line parses', () => {
    const bad = join(dir, 'broken.jsonl');
    writeFileSync(bad, 'not json at all\n{"broken":\n', 'utf8');
    const r = run(bad, join(dir, 'bad.html'));
    expect(r.status).toBe(1);
    // The reason, the first offending line, and the command that explains more.
    expect(r.stderr).toContain('每一行都读不懂');
    expect(r.stderr).toContain('第 1 行');
    expect(r.stderr).toContain('midflight doctor');
    // And it must not claim success on the way out.
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/wrote /);
  });

  it('still fails for a file that is not valid JSON from top to bottom', () => {
    const bad = join(dir, 'all-bad.jsonl');
    writeFileSync(bad, '{"a":\n{oops}\n[1,\n', 'utf8');
    expect(run(bad, join(dir, 'all-bad.html')).status).toBe(1);
  });

  it('an empty file is not an error — it is an empty session', () => {
    const empty = join(dir, 'empty.jsonl');
    writeFileSync(empty, '', 'utf8');
    const r = run(empty, join(dir, 'empty.html'));
    // Zero lines is not "every line failed". Confusing the two would make the
    // tool refuse a legitimately empty log.
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/wrote /);
  });

  it('a real session still succeeds and warns when only some lines are bad', () => {
    const mixed = join(dir, 'mixed.jsonl');
    writeFileSync(
      mixed,
      ['{"type":"message","role":"user","content":[{"type":"text","text":"hi"}]}', 'garbage{', ''].join('\n'),
      'utf8',
    );
    const r = run(mixed, join(dir, 'mixed.html'));
    expect(r.status).toBe(0);
    // Partial damage is reported, not silently absorbed.
    expect(r.stderr).toMatch(/行读不懂/);
  });
});
