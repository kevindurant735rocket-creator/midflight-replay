import { describe, it, expect } from 'vitest';
import { redact, REDACT_RULE_NAMES } from '../src/redact.js';
import { thin, isProtected, capStep, NEVER_DROP } from '../src/compact.js';
import { isEditTool, diffFromArgs } from '../src/diff.js';
import { computeCoverage, isShellTool, looksLikeMutation, VERDICT_LABEL } from '../src/coverage.js';
import { assertPasteSafe, buildPaste, PASTE_ALLOWED_TAGS } from '../src/paste.js';
import { buildReport } from '../src/report.js';
import { parseSession, detectAdapter } from '../src/adapters/index.js';
import type { ReplayStep, Session } from '../src/types.js';

const tc = (name: string, rawArgs: string): ReplayStep =>
  ({ kind: 'tool_call', ts: 1, callId: 'c1', name, args: {}, rawArgs });
const sess = (steps: ReplayStep[]): Session => ({
  meta: { sessionId: 's1', agent: 'codex' }, steps, parseErrors: [], warnings: [], unknownCount: 0, truncated: false,
});

describe('AC-7 redact (default-on secrets)', () => {
  it('masks an OpenAI key', () => {
    const r = redact('key is sk-proj-abcdefghijklmnopqrstuvwxyz here');
    expect(r.text).not.toContain('abcdefghijklmnop');
    expect(r.text).toContain('[REDACTED:openai-key]');
    expect(r.count).toBeGreaterThan(0);
  });
  it('masks a GitHub PAT in both legacy and fine-grained forms', () => {
    expect(redact(`ghp_${'A'.repeat(30)}`).text).toContain('[REDACTED:github-pat]');
    expect(redact(`github_pat_${'B'.repeat(30)}`).text).toContain('[REDACTED:github-pat]');
  });
  it('masks AWS, Slack, Google and JWT credentials', () => {
    expect(redact(`AKIA${'Q'.repeat(16)}`).text).toContain('[REDACTED:aws-key]');
    expect(redact('xoxb-1234567890-abcdef').text).toContain('[REDACTED:slack-token]');
    expect(redact(`AIza${'C'.repeat(35)}`).text).toContain('[REDACTED:google-key]');
    expect(redact(`eyJ${'a'.repeat(9)}.${'b'.repeat(9)}.${'c'.repeat(9)}`).text).toContain('[REDACTED:jwt]');
  });
  it('masks a private key block whole', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nsecretbody\n-----END RSA PRIVATE KEY-----';
    const r = redact(pem);
    expect(r.text).not.toContain('secretbody');
    expect(r.count).toBe(1);
  });
  it('masks key=value secrets without eating the key name', () => {
    const r = redact('api_key = "s3cr3tvalue123"');
    expect(r.text).toContain('api_key');
    expect(r.text).toContain('[REDACTED:kv]');
    expect(r.text).not.toContain('s3cr3tvalue123');
  });
  it('masks emails', () => {
    expect(redact('ping alice@example.com now').text).toContain('[REDACTED:email]');
  });
  it('collapses the home dir to /HOME but not arbitrary paths', () => {
    const r = redact('/Users/alice/work/app.ts and /opt/keep/me.ts', { homeDir: '/Users/alice' });
    expect(r.text).toContain('/HOME/work/app.ts');
    expect(r.text).toContain('/opt/keep/me.ts');
    expect(r.rules).toContain('home-dir');
  });
  it('masks /Users/<name> even without an explicit homeDir', () => {
    expect(redact('/Users/bob/x.ts', { maskUserPaths: true }).text).not.toContain('/Users/bob');
  });
  it('is a no-op when disabled', () => {
    const r = redact('sk-proj-abcdefghijklmnopqrstuvwxyz', { enabled: false });
    expect(r.text).toContain('sk-proj-');
    expect(r.count).toBe(0);
  });
  it('reports only rule names, never matched values', () => {
    const r = redact(`ghp_${'Z'.repeat(30)}`);
    expect(r.rules.every((x) => REDACT_RULE_NAMES.includes(x))).toBe(true);
    expect(JSON.stringify(r.rules)).not.toContain('ZZZZ');
  });
});

describe('W3 thinning policy (never silently drop)', () => {
  it('treats tool_call and compaction as never-drop', () => {
    expect(NEVER_DROP.has('tool_call')).toBe(true);
    expect(NEVER_DROP.has('compaction')).toBe(true);
    expect(isProtected(tc('exec_command', '{}'))).toBe(true);
    expect(isProtected({ kind: 'compaction', ts: 1, summary: 'x' })).toBe(true);
  });
  it('protects warn/error notes but not info notes', () => {
    expect(isProtected({ kind: 'note', ts: 1, level: 'warn', text: 'x' })).toBe(true);
    expect(isProtected({ kind: 'note', ts: 1, level: 'error', text: 'x' })).toBe(true);
    expect(isProtected({ kind: 'note', ts: 1, level: 'info', text: 'x' })).toBe(false);
  });
  it('leaves a small session untouched and reports no truncation', () => {
    const steps: ReplayStep[] = Array.from({ length: 5 }, (_, i) => ({ kind: 'user', ts: i, text: `m${i}` }));
    const r = thin(steps, { maxSteps: 10 });
    expect(r.truncated).toBe(false);
    expect(r.kept).toBe(5);
    expect(r.steps).toHaveLength(5);
  });
  it('keeps every protected step even under pressure, and says so', () => {
    const steps: ReplayStep[] = [
      ...Array.from({ length: 100 }, (_, i) => ({ kind: 'user' as const, ts: i, text: `m${i}` })),
      tc('exec_command', '{"cmd":"ls"}'),
      { kind: 'note', ts: 999, level: 'warn', text: 'dirty line' },
    ];
    const r = thin(steps, { maxSteps: 20 });
    expect(r.truncated).toBe(true);
    expect(r.total).toBe(102);
    expect(r.steps.some((s) => s.kind === 'tool_call')).toBe(true);
    expect(r.steps.some((s) => s.kind === 'note' && s.level === 'warn')).toBe(true);
  });
  it('caps long payloads but never throws', () => {
    const big = 'x'.repeat(5000);
    const c = capStep({ kind: 'tool_output', ts: 1, callId: 'c', output: big, truncated: false }, 100);
    expect((c as any).output).toHaveLength(100);
  });
});

describe('AC-3c edit-step unified diff', () => {
  it('recognises edit tools and rejects read-only ones', () => {
    expect(isEditTool('apply_patch')).toBe(true);
    expect(isEditTool('MultiEdit')).toBe(true);
    expect(isEditTool('write')).toBe(true);
    expect(isEditTool('exec_command')).toBe(false);
    expect(isEditTool('read_file')).toBe(false);
  });
  it('diffs old_string -> new_string and counts add/remove', () => {
    const d = diffFromArgs(JSON.stringify({ old_string: 'a\nb\nc', new_string: 'a\nB\nc' }));
    expect(d).not.toBeNull();
    expect(d!.added).toBe(1);
    expect(d!.removed).toBe(1);
    expect(d!.reconstructable).toBe(true);
  });
  it('renders a Claude Write as added lines and never claims reversibility', () => {
    const d = diffFromArgs(JSON.stringify({ file_path: '/x/a.ts', content: 'one\ntwo' }));
    expect(d).not.toBeNull();
    expect(d!.reconstructable).toBe(false);
    expect(d!.added).toBe(2);
    expect(d!.removed).toBe(0);
    expect(d!.lines.every((l) => l.kind === 'add')).toBe(true);
  });
  it('prefers old_string when a Write-like payload also carries one', () => {
    const d = diffFromArgs(JSON.stringify({ old_string: 'a', content: 'a\nb' }));
    expect(d!.reconstructable).toBe(true);
  });
  it('returns null for a non-edit payload', () => {
    expect(diffFromArgs(JSON.stringify({ cmd: 'ls -la' }))).toBeNull();
  });
});

describe('AC-12a honest coverage bar', () => {
  it('detects shell mutation carriers and ignores reads', () => {
    expect(isShellTool('exec_command')).toBe(true);
    expect(isShellTool('Bash')).toBe(true);
    expect(looksLikeMutation('{"cmd":"sed -i s/a/b/ f.ts"}')).toBe(true);
    expect(looksLikeMutation('{"cmd":"cat f.ts"}')).toBe(false);
  });
  it('verdict full when every edit has a before-image', () => {
    const c = computeCoverage([tc('apply_patch', '{"old_string":"a","new_string":"b"}')], 'codex');
    expect(c.verdict).toBe('full');
    expect(c.ratio).toBe(1);
  });
  it('verdict partial when only some edits have a before-image', () => {
    const c = computeCoverage([
      tc('apply_patch', '{"old_string":"a","new_string":"b"}'),
      tc('write', '{"content":"z"}'),
    ], 'codex');
    expect(c.verdict).toBe('partial');
    expect(c.withBefore).toBe(1);
  });
  it('verdict diff-only for shell-only mutation, and it never claims reversibility', () => {
    const c = computeCoverage([tc('exec_command', '{"cmd":"sed -i s/a/b/ f.ts"}')], 'codex');
    expect(c.verdict).toBe('diff-only');
    expect(c.shellMutations).toBeGreaterThan(0);
    expect(c.reason).toContain('shell');
  });
  it('verdict no-edict for a read-only session', () => {
    const c = computeCoverage([tc('read_file', '{"path":"f.ts"}')], 'codex');
    expect(c.verdict).toBe('no-edits');
    expect(c.shellMutations).toBe(0);
  });
  it('has a label for every verdict so the UI never renders a raw key', () => {
    for (const v of ['full', 'partial', 'diff-only', 'no-edits'] as const) {
      expect(VERDICT_LABEL[v]).toBeTruthy();
    }
  });
});

describe('AC-5b GitHub-safe paste block', () => {
  const st = sess([
    { kind: 'user', ts: 1, text: 'hello world' },
    tc('exec_command', '{"cmd":"ls"}'),
    { kind: 'assistant', ts: 2, text: 'done' },
  ]);
  it('emits no tag outside the allowlist', () => {
    const p = buildPaste(st);
    expect(assertPasteSafe(p.html)).toEqual([]);
  });
  it('never emits a script or style tag', () => {
    const p = buildPaste(st);
    expect(/<script/i.test(p.html)).toBe(false);
    expect(/<style/i.test(p.html)).toBe(false);
  });
  it('only uses allowlisted tags', () => {
    const p = buildPaste(st);
    const used = [...p.html.matchAll(/<\/?([a-z0-9]+)/gi)].map((m) => m[1]!.toLowerCase());
    for (const t of used) expect(PASTE_ALLOWED_TAGS).toContain(t);
  });
  it('stays under the 60KB GitHub comment ceiling', () => {
    const fat = sess(Array.from({ length: 4000 }, (_, i) => ({ kind: 'user' as const, ts: i, text: 'y'.repeat(400) })));
    const p = buildPaste(fat);
    expect(Buffer.byteLength(p.html, 'utf8')).toBeLessThan(60 * 1024);
  });
});

describe('AC-1/AC-4 report is one self-contained file', () => {
  const st = sess([
    { kind: 'user', ts: 1, text: 'refactor this' },
    tc('apply_patch', '{"old_string":"a","new_string":"b"}'),
    { kind: 'tool_output', ts: 2, callId: 'c1', output: 'ok', truncated: false },
    { kind: 'assistant', ts: 3, text: 'done' },
  ]);
  it('emits a complete standalone HTML document', () => {
    const r = buildReport(st);
    expect(r.html.startsWith('<!doctype html>') || r.html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(r.html).toContain('</html>');
  });
  it('references zero external URLs', () => {
    const r = buildReport(st);
    // only SVG namespace strings may look like URLs
    const urls = [...r.html.matchAll(/https?:\/\/[^"'\s<>)]+/g)].map((m) => m[0]);
    const real = urls.filter((u) => !u.startsWith('http://www.w3.org/'));
    expect(real).toEqual([]);
  });
  it('carries no external stylesheet or script src', () => {
    const r = buildReport(st);
    expect(/<link[^>]+href=["']http/i.test(r.html)).toBe(false);
    expect(/<script[^>]+src=/i.test(r.html)).toBe(false);
  });
  it('embeds its payload as inline JSON, not a fetch', () => {
    const r = buildReport(st);
    expect(/fetch\s*\(/i.test(r.html)).toBe(false);
    expect(r.html.length).toBeGreaterThan(500);
  });
});

describe('AC-6 doctor on the real fixtures', () => {
  it('detects the codex adapter', async () => {
    expect(await detectAdapter('fixtures/codex-mini.jsonl')).toBe('codex');
  });
  it('detects the claude adapter', async () => {
    expect(await detectAdapter('fixtures/claude-mini.jsonl')).toBe('claude-code');
  });
  it('parses the codex fixture with zero unknown steps', async () => {
    const s = await parseSession('fixtures/codex-mini.jsonl');
    expect(s.unknownCount).toBe(0);
    expect(s.steps.length).toBeGreaterThan(0);
    expect(s.meta.sessionId).toBeTruthy();
  });
  it('parses the claude fixture into normalized kinds', async () => {
    const s = await parseSession('fixtures/claude-mini.jsonl');
    expect(s.unknownCount).toBe(0);
    expect(s.steps.some((x) => x.kind === 'tool_call')).toBe(true);
  });
  it('reports bad lines by number instead of throwing', async () => {
    const s = await parseSession('fixtures/codex-truncated.jsonl');
    expect(Array.isArray(s.parseErrors)).toBe(true);
  });
});

describe('AC-15 unclassified steps are disclosed, not hidden', () => {
  const withUnknown = (n: number): Session => sess([
    ...Array.from({ length: n }, (_, i) => ({ kind: 'unknown' as const, ts: i, raw: 'file-history-snapshot' })),
    tc('shell', '{"command":"ls"}'),
  ]);

  it('counts unknown steps into the report payload', () => {
    const r = buildReport(withUnknown(7));
    expect(r.html).toContain('"unknownCount":7');
  });

  it('drives the header badge from the payload, guarded on a truthy count', () => {
    // The badge is rendered client-side, so assert the wiring, not the markup:
    // the header branch must read D.unknownCount and must be conditional on it.
    const r = buildReport(withUnknown(7));
    expect(r.html).toContain('"unknownCount":7');
    expect(r.html).toMatch(/D\.unknownCount\s*\?[^]*?步为会话元数据 \/ 未分类（已渲染）/);
  });

  it('reports zero when every step was classified', () => {
    const r = buildReport(sess([tc('shell', '{"command":"ls"}')]));
    expect(r.html).toContain('"unknownCount":0');
  });
});
