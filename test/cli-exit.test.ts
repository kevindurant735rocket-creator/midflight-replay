import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * `midflight replay` returned 0 for any file that existed. Point it at a
 * corrupt log — the one thing a first-time user does when they grab the wrong
 * path — and it printed a success line ("已写入 replay.html  0/0 步") and exited 0. An empty
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
    expect(`${r.stdout}${r.stderr}`).not.toContain('已写入');
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
    // Success is announced in the reader's language, and the coverage verdict
    // uses the same Chinese words the report panel uses.
    expect(r.stderr).toContain('已写入');
    expect(r.stderr).toMatch(/撤回：(可撤回|部分可撤回|仅 diff|无编辑)/);
    expect(r.stderr).not.toMatch(/coverage=|steps \d/);
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
    expect(r.stderr).toContain('已写入');
    expect(r.stderr).not.toMatch(/source=/);
  });
});

/**
 * `doctor` is the screen a user lands on when their log will not read — the one
 * place where a second language costs the most. It printed `FAIL`, then
 * `adapter=unknown agent=codex lines=2 steps=0`, then V8's own sentence
 * ("invalid JSON: Unexpected token 'g'"), then `2 bad line(s)`, and it printed
 * `steps by kind:` with nothing after it when there were no steps. Every one of
 * those is the tool speaking past the reader. `--json` keeps its English keys on
 * purpose — that is a machine contract, not a sentence.
 */
describe('doctor speaks the reader\'s language when a log will not read', () => {
  let dir: string;
  const run = (file: string) => spawnSync(process.execPath, ['dist/cli.js', 'doctor', file], { encoding: 'utf8' });

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mf-doctor-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('names the failure in Chinese and keeps V8 only as the reason', () => {
    const bad = join(dir, 'broken.jsonl');
    writeFileSync(bad, 'garbage{\n{"truncated":\n', 'utf8');
    const r = run(bad);
    expect(r.status).toBe(1);
    const out = r.stdout;
    expect(out).toContain('读不了');
    expect(out).toContain('有 2 行读不懂');
    expect(out).toContain('第 1 行');
    expect(out).toContain('第 2 行');
    expect(out).toContain('没写完就被截断');
    // No raw enum dump, no dangling label, no bare English diagnosis.
    expect(out).not.toMatch(/adapter=|agent=|lines=\d/);
    expect(out).not.toContain('steps by kind:');
    expect(out).not.toMatch(/^\s*(line \d+:|warn:|\d+ bad line)/m);
    expect(out).not.toMatch(/invalid JSON: Unexpected (token|end)/);
  });

  it('counts kinds in words, not protocol names', () => {
    // A real fixture, not a hand-rolled log: the point is what the screen says
    // once a parser has actually recognised the format.
    const r = spawnSync(process.execPath, ['dist/cli.js', 'doctor', 'fixtures/script-escape.jsonl'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const out = r.stdout;
    expect(out).toContain('每类步数：');
    expect(out).toMatch(/(用户消息|工具调用) \d/);
    expect(out).not.toMatch(/user \d|tool_call \d/);
  });
});
