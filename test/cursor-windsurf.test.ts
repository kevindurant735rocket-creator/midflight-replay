import { describe, it, expect } from 'vitest';
import { parseSession, detectAdapter, parseCursor, parseWindsurfCascade, probeCascade } from '../src/adapters/index.js';
import { readLines } from '../src/adapters/index.js';
import { parseClaude } from '../src/adapters/claude.js';
import { scanAgents } from '../src/agents.js';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * AC-10. The Cursor fixture is a fixed sample built from the published on-disk layout
 * (`~/.cursor/projects/<encoded-path>/agent-transcripts/*.jsonl`: a `role` plus a
 * `message.content` block array, ended by `{"type":"turn_ended"}`), not a captured
 * session — no real Cursor log was available on the build machine, and the fixture is
 * labelled unverified everywhere it surfaces. The Windsurf samples are synthetic too.
 */
describe('AC-10 cursor adapter', () => {
  it('detects the cursor adapter from the record shape, not the file name', async () => {
    expect(await detectAdapter('fixtures/cursor-mini.jsonl')).toBe('cursor');
  });

  it('reads role-keyed message records into steps', async () => {
    const s = await parseSession('fixtures/cursor-mini.jsonl');
    expect(s.meta.agent).toBe('cursor');
    expect(s.parseErrors).toEqual([]);
    expect(s.unknownCount).toBe(0);
    const kinds = s.steps.map((x) => x.kind);
    expect(kinds).toEqual([
      'user', 'reasoning', 'tool_call', 'tool_output', 'assistant', 'tool_call', 'tool_output',
      'user', 'tool_call', 'tool_output',
    ]);
  });

  it('the regression this adapter exists for: a cursor transcript read as claude classifies nothing', async () => {
    // `type` is absent on a cursor message, so the claude switch never matches one and every
    // record lands in `unknown`. If a future refactor makes the claude adapter read cursor
    // records, the two hosts stop being distinct and this assertion is what says so.
    const asClaude = await parseClaude(readLines('fixtures/cursor-mini.jsonl'), 'fixtures/cursor-mini.jsonl');
    expect(asClaude.steps.every((s) => s.kind === 'unknown')).toBe(true);
    expect(asClaude.steps.filter((s) => s.kind !== 'unknown')).toEqual([]);
  });

  it('turn_ended is a boundary marker, not a step and not a warning', async () => {
    const s = await parseCursor(readLines('fixtures/cursor-mini.jsonl'), 'fixtures/cursor-mini.jsonl');
    expect(s.steps.some((x) => x.kind === 'unknown' || x.kind === 'note')).toBe(false);
    expect(s.warnings.filter((w) => w.includes('borrowed'))).toEqual([]);
  });

  it('keeps the edited text on the tool_call step so the report can draw a diff', async () => {
    const s = await parseSession('fixtures/cursor-mini.jsonl');
    const edits = s.steps.filter((x) => x.kind === 'tool_call' && x.name === 'Edit');
    expect(edits.length).toBe(2);
    expect(edits[0].newText).toContain('hello');
  });

  it('does not read another tool’s file-history store for a cursor session', async () => {
    // Same sessionId, wrong host: joining ~/.claude backups here would attach before-images
    // from a different tool's session. The host profile has to switch that block off.
    const s = await parseSession('fixtures/cursor-mini.jsonl');
    expect(s.fileHistory).toBeUndefined();
  });

  it('states the gap it cannot close: no sessionId in the sample', async () => {
    const s = await parseSession('fixtures/cursor-mini.jsonl');
    expect(s.warnings.join(' ')).toMatch(/no sessionId/);
  });
});

describe('AC-10 windsurf adapter — an encrypted store, reported as one', () => {
  it('measures a ciphertext sample as encrypted', async () => {
    const p = await probeCascade('fixtures/windsurf-cascade-mini.pb');
    expect(p.entropy).toBeGreaterThan(7.5);
    expect(p.longestPrintableRun).toBeLessThan(64);
    expect(p.looksEncrypted).toBe(true);
  });

  it('does not call a plain-text file encrypted', async () => {
    const p = await probeCascade('fixtures/windsurf-cascade-plaintext.pb');
    expect(p.looksEncrypted).toBe(false);
    expect(await detectAdapter('fixtures/windsurf-cascade-plaintext.pb')).not.toBe('windsurf');
  });

  it('routes a .pb ciphertext to the windsurf adapter by content', async () => {
    expect(await detectAdapter('fixtures/windsurf-cascade-mini.pb')).toBe('windsurf');
  });

  it('refuses to invent a timeline and says why, in the report language', async () => {
    const s = await parseWindsurfCascade('fixtures/windsurf-cascade-mini.pb');
    expect(s.meta.agent).toBe('windsurf');
    expect(s.meta.sessionId).toBe('windsurf-cascade-mini');
    // One note, no invented user/assistant/tool steps.
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0].kind).toBe('note');
    expect(s.steps[0].level).toBe('warn');
    expect(s.steps[0].text).toMatch(/加密/);
    expect(s.steps[0].text).toMatch(/读不出来/);
    expect(s.warnings.join(' ')).toMatch(/熵 7\.9\d/);
  });

  it('an empty cascade file is not reported as an encrypted one', async () => {
    const s = await parseWindsurfCascade('fixtures/windsurf-cascade-empty.pb');
    expect(s.steps).toEqual([]);
    expect(s.warnings.join(' ')).toMatch(/空的/);
  });

  it('probe is bounded: a 4 MiB cap, not the whole store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mf-ws-'));
    const big = join(dir, 'big.pb');
    const chunk = Buffer.alloc(1024 * 1024, 0x41);
    writeFileSync(big, Buffer.concat([chunk, chunk, chunk, chunk, chunk]));
    const p = await probeCascade(big);
    expect(p.bytes).toBe(4 * 1024 * 1024);
  });
});

describe('AC-10 a host is not "readable" until a real log proves the parser', () => {
  it('counts an unverified adapter as installed-but-not-readable', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mf-home-'));
    const t = join(home, '.cursor/projects/demo/agent-transcripts');
    mkdirSync(t, { recursive: true });
    writeFileSync(join(t, 'a.jsonl'), '{"role":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n');
    const rep = (await scanAgents({ homeDir: home })).find((r) => r.id === 'cursor')!;
    expect(rep.status).toBe('unverified');
    expect(rep.files).toBe(1);
  });

  it('does not count our own rule files as cursor sessions', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mf-home-'));
    mkdirSync(join(home, '.cursor/rules/midflight-replay'), { recursive: true });
    writeFileSync(join(home, '.cursor/rules/midflight-replay/x.mdc'), 'rule');
    const rep = (await scanAgents({ homeDir: home })).find((r) => r.id === 'cursor')!;
    expect(rep.files).toBe(0);
    expect(rep.status).toBe('empty');
  });

  it('finds cascade stores under the cascade dir only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mf-home-'));
    mkdirSync(join(home, '.codeium/windsurf/cascade'), { recursive: true });
    mkdirSync(join(home, '.codeium/windsurf/rules/midflight-replay'), { recursive: true });
    writeFileSync(join(home, '.codeium/windsurf/cascade/s1.pb'), Buffer.alloc(2048, 7));
    writeFileSync(join(home, '.codeium/windsurf/rules/midflight-replay/x.md'), 'rule');
    const rep = (await scanAgents({ homeDir: home })).find((r) => r.id === 'windsurf')!;
    expect(rep.files).toBe(1);
    expect(rep.status).toBe('unverified');
  });
});
