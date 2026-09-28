import { createReadStream, openSync, readSync, closeSync } from 'node:fs';
import type { ParseStats, Session } from '../types.js';
import { parseCodex, type CodexParseOptions } from './codex.js';
import { parseClaude, type ClaudeParseOptions } from './claude.js';

export type AdapterName = 'codex' | 'claude-code';
export type ParseOptions = CodexParseOptions & ClaudeParseOptions;

/**
 * Read a JSONL file as a line stream so 100MB+ sessions never land in memory at once.
 *
 * Splits on byte 0x0A only, and only ever after. `node:readline` is not usable here: it
 * also breaks on U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR, which RFC 8259
 * allows unescaped inside a JSON string. A real 114MB Codex rollout carrying a research
 * plan in a tool output was cut into 3 fragments at one such character, and all three
 * fragments then failed `JSON.parse` — the session was reported as corrupt when the file
 * on disk was not. Measured on that file: 30 phantom parse errors, 0 real ones.
 *
 * Working on Buffers also means a multi-byte character split across a chunk boundary is
 * reassembled by the decoder instead of being truncated.
 */
export async function* readLines(path: string): AsyncGenerator<string> {
  const stream = createReadStream(path);
  let carry: Buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    const buf = carry.length === 0 ? (chunk as Buffer) : Buffer.concat([carry, chunk as Buffer]);
    let start = 0;
    for (let nl = buf.indexOf(0x0a, start); nl !== -1; nl = buf.indexOf(0x0a, start)) {
      yield buf.toString('utf8', start, nl);
      start = nl + 1;
    }
    carry = start === 0 ? buf : Buffer.from(buf.subarray(start));
  }
  if (carry.length > 0) yield carry.toString('utf8');
}

function sniffFirstObject(path: string, sampleBytes: number): any | null {
  // A single Codex session_meta line can exceed 90KB (it embeds the full system prompt),
  // so a fixed byte sample is not enough: grow the window until a full line is readable.
  let buf = '';
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const CHUNK = 256 * 1024;
    for (let read = 0; read < Math.max(sampleBytes, 1); read += CHUNK) {
      const b = Buffer.alloc(Math.min(CHUNK, 8 * 1024 * 1024));
      const n = readSync(fd, b, 0, b.length, read);
      buf += b.subarray(0, n).toString('utf8');
      if (buf.includes('\n')) break;
    }
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
  for (const line of buf.split('\n')) {
    if (!line.trim()) continue;
    try {
      return JSON.parse(line);
    } catch {
      continue; // torn first line: keep looking
    }
  }
  return null;
}

/**
 * Sniff the format from the first intact record only. Both formats are JSON Lines, so the
 * discriminator is structural, never the file name.
 */
export function detectAdapter(path: string, sampleBytes = 8 * 1024 * 1024): AdapterName | 'unknown' {
  const o = sniffFirstObject(path, sampleBytes);
  if (!o || typeof o !== 'object') return 'unknown';
  if ('payload' in o && 'type' in o && 'ordinal' in o) return 'codex';
  if (typeof o.type === 'string' && ('message' in o || 'sessionId' in o || 'uuid' in o)) return 'claude-code';
  return 'unknown';
}

export async function parseSession(path: string, opts: ParseOptions = {}): Promise<Session> {
  const adapter = detectAdapter(path);
  if (adapter === 'codex') return parseCodex(readLines(path), path, opts);
  if (adapter === 'claude-code') return parseClaude(readLines(path), path, opts);
  // Unknown shape: try codex, fall back to claude, keep whichever produced steps.
  const a = await parseCodex(readLines(path), path, opts);
  if (a.steps.length > 0) {
    a.warnings.push('format not detected; parsed with the codex adapter as a best effort');
    return a;
  }
  const b = await parseClaude(readLines(path), path, opts);
  b.warnings.push('format not detected; parsed with the claude adapter as a best effort');
  return b;
}

export function statsOf(session: Session, totalLines: number, durationMs: number): ParseStats {
  const byKind: Record<string, number> = {};
  for (const s of session.steps) byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
  return {
    totalLines,
    parsedLines: totalLines - session.parseErrors.length,
    errorLines: session.parseErrors.length,
    unknownSteps: session.unknownCount,
    byKind,
    durationMs,
  };
}

export { parseCodex, parseClaude };
