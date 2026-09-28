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

/**
 * `revert --list` printed its source column as a bracketed internal enum padded
 * to twelve characters: `[log         ]`, `[file-history]`. On a real Claude
 * session the list is the screen the user stares at to decide which edit to undo,
 * and a padded enum plus a bracket pair is exactly the machine smell the rest of
 * the CLI avoids. The two real sources already have decided Chinese names in this
 * codebase (`日志内联`, `备份还原`); the list now uses them, and the success line
 * says `来源：` instead of `source=log`.
 */
describe('revert --list speaks the reader\'s language', () => {
  let dir: string;
  const run = (args: string[]) =>
    spawnSync(process.execPath, ['dist/cli.js', 'revert', ...args], { encoding: 'utf8' });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mf-revert-list-'));
    writeFileSync(join(dir, 'a.ts'), 'n', 'utf8');
    const steps = [
      { kind: 'tool_call', ts: 1, name: 'Edit', rawArgs: JSON.stringify({ file_path: join(dir, 'a.ts'), old_string: 'o', new_string: 'n' }), newText: 'n' },
      { kind: 'tool_call', ts: 2, name: 'Edit', rawArgs: JSON.stringify({ file_path: '/repo/b.ts' }), beforeImage: 'x\n' },
    ];
    writeFileSync(
      join(dir, 'r.html'),
      `<html><script>const D = ${JSON.stringify({ meta: { cwd: dir }, steps })};</script></html>`,
      'utf8',
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names both sources in Chinese and drops the padded bracket', () => {
    const r = run([join(dir, 'r.html'), '--list']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('日志内联');
    expect(r.stdout).toContain('备份还原');
    expect(r.stdout).not.toMatch(/[\[\]]/);
    expect(r.stdout).not.toMatch(/[ \t]+$/m);
    // The internal enum names stay internal.
    expect(`${r.stdout}${r.stderr}`).not.toContain('file-history');
  });

  it('says 来源： on the success line too', () => {
    const r = run([join(dir, 'r.html'), '--step', '0', '--out', join(dir, 'p.patch')]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('来源：日志内联');
    expect(r.stderr).not.toMatch(/source=/);
  });
});
