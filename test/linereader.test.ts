import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLines, parseSession } from '../src/adapters/index.js';

const LS = String.fromCharCode(0x2028); // LINE SEPARATOR
const PS = String.fromCharCode(0x2029); // PARAGRAPH SEPARATOR
const tmp = (body: string): string => {
  const p = join(mkdtempSync(join(tmpdir(), 'midflight-lr-')), 's.jsonl');
  writeFileSync(p, body);
  return p;
};
const collect = async (p: string): Promise<string[]> => {
  const out: string[] = [];
  for await (const l of readLines(p)) out.push(l);
  return out;
};

describe('readLines splits on LF only', () => {
  // Regression: `node:readline` breaks on U+2028/U+2029 as well. RFC 8259 allows both
  // unescaped inside a JSON string, so a valid rollout was cut into fragments and every
  // fragment was reported as a parse error. Measured on a real 114MB session: 30 phantom
  // errors on a file that was not corrupt.
  it('keeps a record whole when its string holds U+2028', async () => {
    const path = tmp(JSON.stringify({ t: `a${LS}b` }) + '\n' + JSON.stringify({ t: 'c' }) + '\n');
    const lines = await collect(path);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).t).toBe(`a${LS}b`);
  });

  it('keeps a record whole when its string holds U+2029', async () => {
    const path = tmp(JSON.stringify({ t: `a${PS}b` }) + '\n');
    const lines = await collect(path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).t).toBe(`a${PS}b`);
  });

  it('still splits on CR and LF', async () => {
    const path = tmp('{"a":1}\r\n{"b":2}\n{"c":3}');
    const lines = await collect(path);
    expect(lines).toHaveLength(3);
    // A CRLF terminator leaves a trailing CR; JSON.parse tolerates it as whitespace.
    expect(JSON.parse(lines[0]!)).toEqual({ a: 1 });
  });

  it('emits a final record that has no trailing newline', async () => {
    const path = tmp('{"a":1}\n{"b":2}');
    const lines = await collect(path);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toEqual({ b: 2 });
  });

  it('reassembles a multi-byte character split across a chunk boundary', async () => {
    // 3-byte CJK, placed so the 64KiB read boundary lands inside it.
    const head = 'x'.repeat(64 * 1024 - 1);
    const path = tmp(JSON.stringify({ t: head + '研究计划' }) + '\n');
    const lines = await collect(path);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).t.endsWith('研究计划')).toBe(true);
  });
});

describe('a session containing U+2028 parses clean', () => {
  it('reports zero parse errors for valid records', async () => {
    const body =
      JSON.stringify({
        timestamp: '2026-09-25T07:33:45.505Z',
        ordinal: 1,
        type: 'response_item',
        payload: { type: 'function_call_output', call_id: 'c1', output: `第一阶段（第 1–2 周）${LS}把文献补齐并建台账。` },
      }) + '\n';
    const s = await parseSession(tmp(body));
    expect(s.parseErrors).toHaveLength(0);
    expect(s.truncated).toBe(false);
    expect(s.meta.agent).toBe('codex');
  });
});
