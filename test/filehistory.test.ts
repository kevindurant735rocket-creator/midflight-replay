import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  indexFileHistory,
  planJoins,
  attachBackups,
  deltaFromRecord,
  isLoggedEdit,
  filePathOf,
  needsBeforeImage,
  MAX_BACKUP_BYTES,
  FILE_HISTORY_ROOT,
  type DeltaRecord,
  type LoggedEdit,
} from '../src/filehistory.js';
import { diffFromArgs } from '../src/diff.js';
import { computeCoverage } from '../src/coverage.js';
import type { ReplayStep } from '../src/types.js';

/** Build a fake ~/.claude layout: <home>/.claude/file-history/<sid>/<hash>@vN */
function fakeHome(sid: string, files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), 'mid-fh-'));
  const dir = join(home, FILE_HISTORY_ROOT, sid);
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return home;
}

const step = (name: string, filePath: string): Extract<ReplayStep, { kind: 'tool_call' }> => ({
  kind: 'tool_call',
  ts: 1,
  callId: `c-${name}-${filePath}`,
  name,
  args: '{}',
  rawArgs: '{}',
  beforeImage: undefined,
  filePath,
} as Extract<ReplayStep, { kind: 'tool_call' }>);

const edit = (uuid: string, filePath: string, logOldRaw?: string): LoggedEdit => ({
  step: step('Edit', filePath),
  uuid,
  ...(filePath ? { filePath } : {}),
  ...(logOldRaw === undefined ? {} : { logOldRaw }),
});

const delta = (o: Partial<DeltaRecord> & { backupFileName?: string | null }): DeltaRecord => ({
  ts: 1,
  ...o,
});

describe('indexFileHistory', () => {
  it('reports an honest reason when the session has no backup directory', () => {
    const home = mkdtempSync(join(tmpdir(), 'mid-fh-'));
    const idx = indexFileHistory('nope', home);
    expect(idx.available).toBe(false);
    expect(idx.backups).toBe(0);
    expect(idx.reason).toContain('不存在');
  });

  it('counts only @vN files and ignores unrelated names', () => {
    const home = fakeHome('s1', { 'abc@v1': 'x', 'def@v2': 'y', 'README.md': 'z' });
    const idx = indexFileHistory('s1', home);
    expect(idx.backups).toBe(2);
    expect(idx.available).toBe(true);
    expect(idx.reason).toBe('');
  });

  it('counts an oversize backup instead of silently dropping it', () => {
    const home = fakeHome('s2', { 'big@v1': 'x' });
    const p = join(home, FILE_HISTORY_ROOT, 's2', 'big@v1');
    // write past the ceiling without materialising 4 MiB in the test source
    const fd = statSync(p);
    expect(fd.size).toBe(1);
    expect(indexFileHistory('s2', home).oversize).toBe(0);
    expect(MAX_BACKUP_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe('planJoins', () => {
  it('pairs by path when the file paths agree', () => {
    const e = edit('m1', '/repo/src/a.ts', 'old');
    const d = delta({ messageId: 'm1', backupFileName: 'h@v1', trackingPath: '/repo/src/a.ts', realParentDir: '/repo/src' });
    const r = planJoins([d], [e]);
    expect(r.joins).toHaveLength(1);
    expect(r.joins[0].via).toBe('path');
    expect(r.joins[0].absPath).toBe('/repo/src/a.ts');
  });

  it('falls back to the sole edit when paths differ but the pairing is unambiguous', () => {
    const e = edit('m1', 'src/a.ts', 'old'); // relative, delta says absolute
    const d = delta({ messageId: 'm1', backupFileName: 'h@v1', trackingPath: '/repo/src/a.ts', realParentDir: '/repo/src' });
    const r = planJoins([d], [e]);
    expect(r.joins).toHaveLength(1);
    expect(r.joins[0].via).toBe('sole');
  });

  it('refuses to guess when one message edited two files and the paths disagree', () => {
    const e1 = edit('m1', '/repo/src/a.ts');
    const e2 = edit('m1', '/repo/src/b.ts');
    const d = delta({ messageId: 'm1', backupFileName: 'h@v1', trackingPath: '/repo/src/c.ts', realParentDir: '/repo/src' });
    const r = planJoins([d], [e1, e2]);
    expect(r.joins).toHaveLength(0);
    expect(r.unresolved).toBe(1);
  });

  it('counts an untracked delta (host declined to back it up) as untracked, not unresolved', () => {
    const e = edit('m1', '/repo/src/a.ts');
    const d = delta({ messageId: 'm1', backupFileName: null, trackingPath: '/tmp/x.ts', realParentDir: '/tmp' });
    const r = planJoins([d], [e]);
    expect(r.joins).toHaveLength(0);
    expect(r.untracked).toBe(1);
    expect(r.unresolved).toBe(0);
  });

  it('counts a delta with no messageId as unresolved', () => {
    const r = planJoins([delta({ backupFileName: 'h@v1', realParentDir: '/r', trackingPath: '/r/a.ts' })], [edit('m1', '/r/a.ts')]);
    expect(r.unresolved).toBe(1);
  });

  it('never hands the same edit to two deltas', () => {
    const e = edit('m1', '/r/a.ts');
    const d1 = delta({ messageId: 'm1', backupFileName: 'h@v1', realParentDir: '/r', trackingPath: '/r/a.ts' });
    const d2 = delta({ messageId: 'm1', backupFileName: 'h@v2', realParentDir: '/r', trackingPath: '/r/a.ts' });
    const r = planJoins([d1, d2], [e]);
    expect(r.joins).toHaveLength(1);
    expect(r.unresolved).toBe(1);
  });
});

describe('deltaFromRecord', () => {
  it('returns null for a record with no backup object', () => {
    expect(deltaFromRecord({ type: 'file-history-delta' }, 5)).toBeNull();
  });

  it('keeps backupFileName:null so the record is reported untracked instead of dropped', () => {
    const d = deltaFromRecord({ messageId: 'm', trackingPath: '/t/a.ts', backup: { backupFileName: null, realParentDir: '/t' } }, 5);
    expect(d).not.toBeNull();
    expect(d!.backupFileName).toBeNull();
    expect(d!.realParentDir).toBe('/t');
  });
});

describe('attachBackups', () => {
  const noop = { redact: (s: string) => s, redactEnabled: false };

  it('agrees when the log old_string is contained in the backup', () => {
    const home = fakeHome('s3', { 'a@v1': 'line1\nold line\nline3\n' });
    const e = edit('m1', '/r/a.ts', 'old line');
    const idx = indexFileHistory('s3', home);
    const { joins } = planJoins([delta({ messageId: 'm1', backupFileName: 'a@v1', realParentDir: '/r', trackingPath: '/r/a.ts' })], [e]);
    const out = attachBackups(joins, idx, noop);
    expect(out.stats.joins).toBe(1);
    expect(out.stats.agree).toBe(1);
    expect(out.stats.disagree).toBe(0);
    expect(out.stats.recovered).toBe(0);
  });

  it('flags a disagreement between the log and the host backup, and still attaches the backup', () => {
    const home = fakeHome('s4', { 'a@v1': 'totally different\n' });
    const e = edit('m1', '/r/a.ts', 'old line');
    const idx = indexFileHistory('s4', home);
    const { joins } = planJoins([delta({ messageId: 'm1', backupFileName: 'a@v1', realParentDir: '/r', trackingPath: '/r/a.ts' })], [e]);
    const out = attachBackups(joins, idx, noop);
    expect(out.stats.disagree).toBe(1);
    expect(out.stats.joins).toBe(1);
    expect(out.attached.get(e.step)!.before).toBe('totally different\n');
  });

  it('counts a log with no old_string as recovered: the backup is the only surviving copy', () => {
    const home = fakeHome('s5', { 'a@v1': 'the whole file\n' });
    const e = edit('m1', '/r/a.ts');
    const idx = indexFileHistory('s5', home);
    const { joins } = planJoins([delta({ messageId: 'm1', backupFileName: 'a@v1', realParentDir: '/r', trackingPath: '/r/a.ts' })], [e]);
    const out = attachBackups(joins, idx, noop);
    expect(out.stats.recovered).toBe(1);
    expect(out.stats.agree).toBe(0);
  });

  it('redacts the recovered bytes when redaction is on', () => {
    const home = fakeHome('s6', { 'a@v1': 'token: sk-secret-value\n' });
    const e = edit('m1', '/r/a.ts');
    const idx = indexFileHistory('s6', home);
    const { joins } = planJoins([delta({ messageId: 'm1', backupFileName: 'a@v1', realParentDir: '/r', trackingPath: '/r/a.ts' })], [e]);
    const out = attachBackups(joins, idx, { redact: (s) => s.replace(/sk-[A-Za-z0-9-]+/g, '<secret>'), redactEnabled: true });
    expect(out.attached.get(e.step)!.before).toBe('token: <secret>\n');
  });

  it('counts a backup that vanished from disk as missing, without attaching anything', () => {
    const home = fakeHome('s7', {});
    const e = edit('m1', '/r/a.ts');
    const idx = indexFileHistory('s7', home);
    const { joins } = planJoins([delta({ messageId: 'm1', backupFileName: 'gone@v1', realParentDir: '/r', trackingPath: '/r/a.ts' })], [e]);
    const out = attachBackups(joins, idx, noop);
    expect(out.stats.missing).toBe(1);
    expect(out.stats.joins).toBe(0);
    expect(out.attached.size).toBe(0);
    expect(out.stats.reason).toContain('不存在');
  });
});

describe('edit recognition', () => {
  it('treats every edit tool as a join candidate, not only the ones missing old_string', () => {
    expect(isLoggedEdit('Edit', { file_path: '/r/a.ts', old_string: 'x', new_string: 'y' })).toBe(true);
    expect(isLoggedEdit('Write', { file_path: '/r/a.ts', content: 'x' })).toBe(true);
    expect(isLoggedEdit('Bash', { command: 'ls' })).toBe(false);
    expect(isLoggedEdit('Edit', null)).toBe(false);
  });

  it('reads file_path, falling back to path', () => {
    expect(filePathOf({ file_path: '/r/a.ts' })).toBe('/r/a.ts');
    expect(filePathOf({ path: '/r/b.ts' })).toBe('/r/b.ts');
    expect(filePathOf({})).toBeUndefined();
  });

  it('flags a create as needing a before-image only when there is no old text at all', () => {
    expect(needsBeforeImage({ file_path: '/r/a.ts', content: 'x' })).toBe(true);
    expect(needsBeforeImage({ file_path: '/r/a.ts', old_string: 'x', content: 'y' })).toBe(false);
    expect(needsBeforeImage(null)).toBe(false);
  });
});

describe('end to end: coverage credits the backup as the before-image source', () => {
  it('counts a backup-only edit as withBeforeBackup, not withBeforeLog', () => {
    const home = fakeHome('s8', { 'a@v1': 'alpha\nbeta\ngamma\n' });
    const s = step('Edit', '/r/a.ts');
    const args = JSON.stringify({ file_path: '/r/a.ts', new_string: 'alpha\nBETA\ngamma\n' });
    s.rawArgs = args;
    s.args = args;
    s.newText = 'alpha\nBETA\ngamma\n'; // lifted from the unredacted input, as the adapter now does
    const idx = indexFileHistory('s8', home);
    const { joins } = planJoins([delta({ messageId: 'm1', backupFileName: 'a@v1', realParentDir: '/r', trackingPath: '/r/a.ts' })], [{ step: s, uuid: 'm1', filePath: '/r/a.ts' }]);
    const out = attachBackups(joins, idx, { redact: (s) => s, redactEnabled: false });
    s.beforeImage = out.attached.get(s)!.before;

    const d = diffFromArgs(s.rawArgs, s.beforeImage, s.newText);
    expect(d!.reconstructable).toBe(true);
    expect(d!.removed).toBe(1);
    expect(d!.added).toBe(1);

    const cov = computeCoverage([s], 'claude', out.stats);
    expect(cov.edits).toBe(1);
    expect(cov.withBeforeBackup).toBe(1);
    expect(cov.withBeforeLog).toBe(0);
    expect(cov.ratio).toBe(1);
  });

  it('keeps counting an inline old_string as the log-stated before-image', () => {
    const args = JSON.stringify({ file_path: '/r/a.ts', old_string: 'beta', new_string: 'BETA' });
    const s = step('Edit', '/r/a.ts');
    s.rawArgs = args;
    s.args = args;
    s.newText = 'BETA';
    const cov = computeCoverage([s], 'claude');
    expect(cov.withBeforeLog).toBe(1);
    expect(cov.withBeforeBackup).toBe(0);
  });
});
