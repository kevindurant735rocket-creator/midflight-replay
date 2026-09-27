import { createReadStream, openSync, readSync, closeSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { ParseStats, Session } from '../types.js';
import { parseCodex, type CodexParseOptions } from './codex.js';
import { parseClaude, type ClaudeParseOptions } from './claude.js';

export type AdapterName = 'codex' | 'claude-code';
export type ParseOptions = CodexParseOptions & ClaudeParseOptions;

/** Read a JSONL file as a line stream so 100MB+ sessions never land in memory at once. */
export async function* readLines(path: string): AsyncGenerator<string> {
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
  }
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
