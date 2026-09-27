import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planRevert, listRevertable, isReversible, readReportPayload, type RevertOk } from '../src/revert.js';
import type { ReplayStep } from '../src/types.js';

const ROOT = '/repo';

function step(o: Partial<Extract<ReplayStep, { kind: 'tool_call' }>> & { name: string }): ReplayStep {
  return { kind: 'tool_call', ts: 0, callId: 'c1', ...o } as ReplayStep;
}

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

/** A real git repo holding one file, with the user's commit history. */
function repoWith(file: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'mid-revert-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 't');
  for (const [p, body] of Object.entries(file)) writeFileSync(join(dir, p), body, 'utf8');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}

describe('revert — the patch git can actually place', () => {
  const before = ['line one', 'line two', 'line three', 'line four', 'line five', 'line six', 'line seven'].join('\n') + '\n';
  const after = before.replace('line four', 'LINE FOUR');

  it('file-history beforeImage → `git apply --check -R` exits 0 (case A)', () => {
    const dir = repoWith({ 'a.txt': after });
    const s = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt') }), beforeImage: before });
    const r = planRevert([s], 0, dir);
    expect(r.ok).toBe(true);
    const ok = r as RevertOk;
    expect(ok.source).toBe('file-history');
    expect(ok.added).toBe(1);
    expect(ok.removed).toBe(1);
    expect(ok.patch).toMatch(/^--- a\/a\.txt\n\+\+\+ b\/a\.txt\n@@ -\d+,\d+ \+\d+,\d+ @@/);
    // 7 lines of context on both sides of a one-line change, so git can locate it anywhere.
    expect(ok.patch.split('\n').filter((l) => l.startsWith(' ')).length).toBe(6);

    const pf = join(dir, 'p.diff');
    writeFileSync(pf, ok.patch, 'utf8');
    expect(() => git(dir, 'apply', '--check', '-R', 'p.diff')).not.toThrow();
  });

  it('actually reverts the file, byte for byte, when applied', () => {
    const dir = repoWith({ 'a.txt': after });
    const s = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt') }), beforeImage: before });
    const r = planRevert([s], 0, dir) as RevertOk;
    writeFileSync(join(dir, 'p.diff'), r.patch, 'utf8');
    git(dir, 'apply', '-R', 'p.diff');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(before);
  });

  it('log fragment only → whole-file diff, still appliable (case B)', () => {
    const dir = repoWith({ 'a.txt': after });
    const s = step({
      name: 'Edit',
      rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt'), old_string: 'line four', new_string: 'LINE FOUR' }),
      newText: 'LINE FOUR',
    });
    const r = planRevert([s], 0, dir) as RevertOk;
    expect(r.source).toBe('log');
    // The `-` side is the line put back, surrounded by real file context.
    expect(r.patch).toContain('-line four');
    expect(r.patch).toContain(' line three');
    writeFileSync(join(dir, 'p.diff'), r.patch, 'utf8');
    expect(() => git(dir, 'apply', '--check', '-R', 'p.diff')).not.toThrow();
    git(dir, 'apply', '-R', 'p.diff');
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(before);
  });

  it('a fragment-only hunk would NOT have been appliable — the reason we diff whole files', () => {
    // Guards the bug this design exists to prevent: `@@ -1,1 @@` with no context.
    const dir = repoWith({ 'a.txt': after });
    const naive = '--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-line four\n+LINE FOUR\n';
    writeFileSync(join(dir, 'n.diff'), naive, 'utf8');
    expect(() => git(dir, 'apply', '--check', '-R', 'n.diff')).toThrow();
  });

  it('refuses when the tree moved on (diverged)', () => {
    const dir = repoWith({ 'a.txt': after.replace('LINE FOUR', 'TOTALLY DIFFERENT') });
    const s = step({
      name: 'Edit',
      rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt'), old_string: 'line four', new_string: 'LINE FOUR' }),
      newText: 'LINE FOUR',
    });
    const r = planRevert([s], 0, dir);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.code).toBe('TREE_DIVERGED');
  });

  it('refuses when the written text is ambiguous (appears twice)', () => {
    const body = 'dup\npad\ndup\n';
    const dir = repoWith({ 'a.txt': body });
    const s = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt'), old_string: 'x', new_string: 'dup' }), newText: 'dup' });
    const r = planRevert([s], 0, dir);
    expect(r.ok === false && r.code).toBe('TREE_DIVERGED');
  });

  it('refuses a create (no before-image) rather than emitting a no-op', () => {
    const dir = repoWith({ 'a.txt': 'brand new\n' });
    const s = step({ name: 'Write', rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt'), content: 'brand new\n' }), newText: 'brand new\n' });
    const r = planRevert([s], 0, dir);
    expect(r.ok === false && r.code).toBe('NO_BEFORE_IMAGE');
  });

  it('refuses when the file is gone from the tree', () => {
    const dir = repoWith({ 'a.txt': after });
    const s = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt') }), beforeImage: before });
    const r = planRevert([s], 0, dir, () => undefined);
    expect(r.ok === false && r.code).toBe('TREE_UNREADABLE');
  });

  it('refuses a no-op step (before == after)', () => {
    const dir = repoWith({ 'a.txt': before });
    const s = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt') }), beforeImage: before });
    const r = planRevert([s], 0, dir);
    expect(r.ok === false && r.code).toBe('EMPTY_DIFF');
  });

  it('refuses out of range, non-edits, and unreadable args', () => {
    const dir = repoWith({ 'a.txt': after });
    const oob = planRevert([step({ name: 'Edit', rawArgs: '{}' })], 9, dir);
    expect(oob.ok === false && oob.code).toBe('STEP_OUT_OF_RANGE');
    const notEdit = planRevert([{ kind: 'user', ts: 0, text: 'hi' } as ReplayStep], 0, dir);
    expect(notEdit.ok === false && notEdit.code).toBe('NOT_A_FILE_EDIT');
    const readOnly = planRevert([step({ name: 'Bash', rawArgs: '{"command":"ls"}' })], 0, dir);
    expect(readOnly.ok === false && readOnly.code).toBe('NOT_A_FILE_EDIT');
    const clipped = planRevert([step({ name: 'Edit', rawArgs: '{"file_path":' })], 0, dir);
    expect(clipped.ok === false && clipped.code).toBe('NO_FILE_PATH');
  });

  it('never writes to the working tree', () => {
    const dir = repoWith({ 'a.txt': after });
    const s = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: join(dir, 'a.txt') }), beforeImage: before });
    planRevert([s], 0, dir);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe(after);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('patches a path outside the session cwd as absolute — git apply will then refuse, which is honest', () => {
    const dir = repoWith({ 'a.txt': after });
    const s = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: '/elsewhere/b.txt' }), beforeImage: before });
    const r = planRevert([s], 0, dir, () => after) as RevertOk;
    expect(r.patch).toMatch(/^--- a\/elsewhere\/b\.txt/);
  });
});

describe('revert — listing works without a checkout', () => {
  const s1 = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: `${ROOT}/a.ts` }), beforeImage: 'x\n' });
  const s2 = step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: `${ROOT}/b.ts`, old_string: 'o', new_string: 'n' }), newText: 'n' });
  const s3 = step({ name: 'Bash', rawArgs: '{"command":"ls"}' });
  const s4 = { kind: 'user', ts: 0, text: 'hello' } as ReplayStep;

  it('marks both recoverable sources', () => {
    const rows = listRevertable([s1, s3, s2, s4]);
    expect(rows.map((r) => r.step)).toEqual([0, 2]);
    expect(rows[0].source).toBe('file-history');
    expect(rows[1].source).toBe('log');
    expect(rows[1].path).toBe(`${ROOT}/b.ts`);
  });

  it('needs no readable file at all', () => {
    expect(() => listRevertable([s1, s2])).not.toThrow();
    expect(isReversible(s1)).toBe(true);
    expect(isReversible(s3)).toBe(false);
  });
});

describe('revert — report payload', () => {
  it('reads steps and the session cwd', () => {
    const html = `<html><script>const D = ${JSON.stringify({ meta: { cwd: '/repo' }, steps: [s1Fixture()] })};</script></html>`;
    const { steps, cwd } = readReportPayload(html);
    expect(cwd).toBe('/repo');
    expect(steps).toHaveLength(1);
  });

  it('refuses a file that is not a report', () => {
    expect(() => readReportPayload('<html>nope</html>')).toThrow(/找不到内嵌数据/);
  });

  it('refuses a report whose payload has no steps', () => {
    expect(() => readReportPayload('<script>const D = {"meta":{}};</script>')).toThrow(/没有 steps/);
  });
});

function s1Fixture(): ReplayStep {
  return step({ name: 'Edit', rawArgs: JSON.stringify({ file_path: '/repo/a.ts' }), beforeImage: 'x\n' });
}
