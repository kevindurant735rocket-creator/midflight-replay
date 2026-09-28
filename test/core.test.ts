import { describe, it, expect } from 'vitest';
import { redact, REDACT_RULE_NAMES } from '../src/redact.js';
import { thin, thinBanner, isProtected, capStep, NEVER_DROP } from '../src/compact.js';
import { isEditTool, diffFromArgs } from '../src/diff.js';
import { computeCoverage, isShellTool, looksLikeMutation, VERDICT_LABEL } from '../src/coverage.js';
import { assertPasteSafe, buildPaste, PASTE_ALLOWED_TAGS } from '../src/paste.js';
import { buildContextTrack, projectContextTrack } from '../src/context.js';
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
  it('still samples prose when protected rows alone exceed the budget (G4-3)', () => {
    // The measured case: 109 MiB Codex session, 3,689 tool calls + 22 compactions
    // protected vs a 3,000 default. The old budget floored at 0 and dropped every
    // user/assistant/reasoning step in the file.
    // 11,000 prose steps against a 300-slot reserve, so the drop path is exercised too.
    const steps: ReplayStep[] = [
      ...Array.from({ length: 6000 }, (_, i) => ({ kind: 'user' as const, ts: i * 2, text: `ask ${i}` })),
      ...Array.from({ length: 5000 }, (_, i) => ({ kind: 'assistant' as const, ts: i * 2 + 1, text: `answer ${i}` })),
      ...Array.from({ length: 3711 }, (_, i) => tc('exec_command', `{"cmd":"run ${i}"}`)),
    ];
    const r = thin(steps, { maxSteps: 3000 });
    expect(r.truncated).toBe(true);
    expect(r.steps.filter((s) => s.kind === 'tool_call')).toHaveLength(3711);
    expect(r.steps.some((s) => s.kind === 'user' || s.kind === 'assistant')).toBe(true);
    // ...and the banner names the survivors' siblings by kind, not just the count.
    expect(r.droppedByKind.user).toBeGreaterThan(5000);
    expect(r.droppedByKind.assistant).toBeGreaterThan(4000);
    expect(r.kept).toBe(3711 + r.steps.filter((s) => s.kind !== 'tool_call').length);
    expect(r.droppedByKind.tool_call).toBeUndefined();
    const b = thinBanner(r.kept, r.total, r.droppedByKind);
    expect(b).toContain('user');
    expect(b).toContain('assistant');
    expect(b).toContain('--max-steps');
    expect(b).not.toContain('tool_call');
  });
  it('drops nothing and reports no breakdown when the session fits', () => {
    const steps: ReplayStep[] = Array.from({ length: 5 }, (_, i) => ({ kind: 'user', ts: i, text: `m${i}` }));
    expect(thin(steps, { maxSteps: 10 }).droppedByKind).toEqual({});
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
  it('prints the three coverage counts the verdict was computed from', () => {
    // The README quotes these numbers. If the report does not print them, the quote
    // is unfalsifiable — which is the exact failure the honesty bar exists to stop.
    const html = buildReport(sess([
      tc('apply_patch', '{"old_string":"a","new_string":"b"}'),
      tc('apply_patch', '{"input":"c"}'),
      tc('exec_command', '{"cmd":"sed -i s/a/b/ f.ts"}'),
      tc('exec_command', '{"cmd":"cat f.ts"}'),
    ])).html;
    // The DOM is built at runtime, so the report ships the block as a JS template.
    // Assert the three counts are wired to the coverage object, in order.
    expect(html).toContain('class="kv cov-nums"');
    expect(html).toContain(
      'class="kv cov-nums" data-edits="\'+c.edits+\'" data-shell="\'+c.shellMutations+\'" data-before="\'+c.withBefore+\'"',
    );
  });
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

describe('context track survives thinning (G4-4)', () => {
  // 40 assistant steps of 100 chars + 4 tool_calls, kept at 8 — the kept list holds
  // 8 tool_calls and ~0 prose, so building the curve from the kept steps loses all mass.
  const mk = (): ReplayStep[] => [
    ...Array.from({ length: 40 }, (_, i): ReplayStep => ({
      kind: 'assistant', t: i, text: 'x'.repeat(100),
    })),
    ...Array.from({ length: 4 }, (_, i): ReplayStep => ({
      kind: 'tool_call', t: 40 + i, tool: 'shell', args: 'ls', rawArgs: 'ls',
    })),
  ];

  it('thin() reports the original index of every kept step', () => {
    const t = thin(mk(), { maxSteps: 8 });
    expect(t.keptIdx.length).toBe(t.kept);
    for (const i of t.keptIdx) expect(i).toBeGreaterThanOrEqual(0);
    // strictly increasing: the projection assumes timeline order
    for (let k = 1; k < t.keptIdx.length; k++) expect(t.keptIdx[k]).toBeGreaterThan(t.keptIdx[k - 1]);
  });

  it('identity projection returns the track unchanged', () => {
    const steps = mk();
    const full = buildContextTrack(steps);
    const id = steps.map((_, i) => i);
    expect(projectContextTrack(full, id)).toBe(full);
  });

  it('the projected curve keeps the true mass of the thinned-away steps', () => {
    const steps = mk();
    const full = buildContextTrack(steps);
    const t = thin(steps, { maxSteps: 8 });
    const thinnedBuilt = buildContextTrack(t.steps);
    const projected = projectContextTrack(full, t.keptIdx);
    const total = (c: number[]): number => c.reduce((a, b) => a + b, 0);
    // every displayed point must equal the true cumulative mass at its original position
    t.keptIdx.forEach((orig, j) => {
      expect(projected.cumulative[j]).toEqual(full.cumulative[orig]);
    });
    // and the curve must not have lost the thinned prose
    expect(total(projected.cumulative[projected.cumulative.length - 1]))
      .toBeGreaterThan(total(thinnedBuilt.cumulative[thinnedBuilt.cumulative.length - 1]));
  });

  it('firstStep is re-expressed as a kept position, and -1 stays -1', () => {
    const steps: ReplayStep[] = [
      ...Array.from({ length: 20 }, (_, i): ReplayStep => ({ kind: 'assistant', t: i, text: 'a' })),
      ...Array.from({ length: 4 }, (_, i): ReplayStep => ({ kind: 'reasoning', t: 20 + i, summary: 'r' })),
    ];
    const full = buildContextTrack(steps);
    const t = thin(steps, { maxSteps: 6 }); // reasoning rows are the protected ones here
    const projected = projectContextTrack(full, t.keptIdx);
    const origOf = t.keptIdx[projected.firstStep[1]];
    expect(origOf).toBeGreaterThanOrEqual(full.firstStep[1]);
    expect(projected.firstStep[2]).toBe(-1); // tool_output never appeared
  });
});

describe('Claude Code compaction is a first-hand event, not chrome (G4-5)', () => {
  it('turns compact_boundary into a compaction step and leaves other system records alone', async () => {
    const s = await parseSession('fixtures/claude-compact.jsonl');
    expect(s.unknownCount).toBe(0);
    const comps = s.steps.filter((x) => x.kind === 'compaction') as Extract<ReplayStep, { kind: 'compaction' }>[];
    expect(comps.length).toBe(1);
    expect(comps[0].contextBefore).toBe(79656);
    expect(comps[0].summary).toContain('manual');
    expect(comps[0].summary).toContain('79,656');
    expect(comps[0].summary).toContain('19,748');
    expect(comps[0].summary).toContain('32.8s');
  });

  it('the report then reports a first-hand compaction instead of claiming there was none', () => {
    const s = sess([
      { kind: 'user', ts: 0, text: 'a'.repeat(500) },
      { kind: 'compaction', ts: 1000, summary: '宿主压缩（auto 触发）', contextBefore: 79656 },
      { kind: 'user', ts: 2000, text: 'b'.repeat(100) },
    ]);
    const r = buildReport(s);
    expect(r.html).toContain('"hasFirstHandCompaction":true');
    // tokens must never be labelled as characters
    expect(r.html).toContain('宿主上报压缩前');
    expect(r.html).not.toMatch(/压缩前上下文 <b>[\d,]*<\/b> 字符/);
  });
});

describe('session chrome is not noise, and the title is worth keeping (G4-6)', () => {
  it('reads ai-title into meta and emits no step for the chrome records', async () => {
    const s = await parseSession('fixtures/claude-compact.jsonl');
    expect(s.unknownCount).toBe(0);
    expect(s.steps.some((x) => x.kind === 'unknown')).toBe(false);
  });
  it('a title shows up in the report header', () => {
    const s = sess([tc('shell', '{"command":"ls"}')]);
    s.meta.title = '任务监控系统改进';
    const r = buildReport(s);
    expect(r.html).toContain('"title":"任务监控系统改进"');
    expect(r.html).toMatch(/\["标题",m\.title\]/);
  });
});

describe('AC-13 the installed CLI can be asked what it is', () => {
  it('reads the version from the package.json the tarball ships', async () => {
    const { readVersion } = await import('../src/version.js');
    const pkg = JSON.parse(
      await import('node:fs').then((fs) =>
        fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')),
    ) as { version: string };
    expect(readVersion()).toBe(pkg.version);
    expect(readVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
  it('degrades to "unknown" instead of throwing when the package is gone', async () => {
    const { readVersion } = await import('../src/version.js');
    expect(readVersion(new URL('file:///nonexistent/package.json'))).toBe('unknown');
    expect(readVersion(new URL('file:///etc/hosts'))).toBe('unknown'); // not JSON
  });
});


// A host with no structured editor has edits=0, so the old `ratio` was 1.0 by
// definition and the report printed a full bar labelled "100%" on a session where
// nothing at all was reversible. The bar now divides by every change.
describe('coverage: the displayed ratio is the reversible one', () => {
  const shellOnly = (): ReplayStep[] => [
    { kind: 'tool_call', ts: 1, name: 'exec_command', rawArgs: JSON.stringify({ cmd: 'echo a > a.txt' }) },
    { kind: 'tool_call', ts: 2, name: 'exec_command', rawArgs: JSON.stringify({ cmd: 'echo b > b.txt' }) },
  ] as ReplayStep[];

  it('reads 0%, not 100%, when every change came from the shell', () => {
    const c = computeCoverage(shellOnly(), 'codex');
    expect(c.ratio).toBe(1);            // unchanged: 0 structured edits
    expect(c.shellMutations).toBeGreaterThan(0);
    expect(c.reversibleRatio).toBe(0);
    expect(c.totalChanges).toBe(c.edits + c.shellMutations);
  });

  it('reads 100% when a real before-image exists', () => {
    const steps = [{
      kind: 'tool_call', ts: 1, name: 'edit_file',
      rawArgs: JSON.stringify({ old_string: 'a', new_string: 'b' }),
    }] as ReplayStep[];
    const c = computeCoverage(steps, 'claude-code');
    expect(c.reversibleRatio).toBe(1);
  });

  it('is 1 when the session changed nothing at all', () => {
    const c = computeCoverage([] as ReplayStep[], 'codex');
    expect(c.totalChanges).toBe(0);
    expect(c.reversibleRatio).toBe(1);
  });
});

describe('the report a user opens is not a blank page (AC-19)', () => {
  // A misplaced quote inside one innerHTML string shipped a report whose inlined
  // script failed to parse: the page opened completely empty. Nothing asserted on
  // the extracted script, so the whole suite stayed green. Two cheap gates close it.
  const scriptOf = (html: string): string => {
    const m = /<script[^>]*>([\s\S]*?)<\/script>/.exec(html);
    expect(m, 'report must inline exactly one script block').toBeTruthy();
    return m![1];
  };

  it('inlines a script block that actually parses', () => {
    const src = scriptOf(buildReport(sess([tc('shell', '{"command":"ls"}')])).html);
    // `new Function` is a parser, not an executor: a syntax error throws at
    // construction time, so this proves validity without running any report code.
    expect(() => new Function(src)).not.toThrow();
  });
});
