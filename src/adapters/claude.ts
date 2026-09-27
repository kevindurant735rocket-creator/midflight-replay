import type { ParseError, ReplayStep, Session, SessionMeta } from '../types.js';
import { redact, type RedactOptions } from '../redact.js';

export interface ClaudeParseOptions extends RedactOptions {
  maxOutputChars?: number;
  maxArgsChars?: number;
}

const DEFAULTS = { maxOutputChars: 20_000, maxArgsChars: 20_000 };

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function cap(s: string, n: number): { text: string; truncated: boolean } {
  return s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false };
}
function blocksOf(msg: any): any[] {
  if (!msg || typeof msg !== 'object') return [];
  const c = msg.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c.filter((x: any) => x && typeof x === 'object') : [];
}

/**
 * Claude Code JSONL. Contract: docs/FORMATS.md
 * Line shape differs from Codex: the line IS the record, there is no {type,payload} envelope.
 */
export async function parseClaude(
  lines: AsyncIterable<string>,
  sourceFile?: string,
  opts: ClaudeParseOptions = {},
): Promise<Session> {
  const o = { ...DEFAULTS, ...opts };
  const steps: ReplayStep[] = [];
  const parseErrors: ParseError[] = [];
  const warnings: string[] = [];
  const meta: SessionMeta = { sessionId: 'unknown', agent: 'claude-code', ...(sourceFile ? { sourceFile } : {}) };
  const redactOn = (s: string): string => (opts.enabled === false ? s : redact(s, opts).text);

  let lineNo = 0;
  let lastTs = 0;
  let sawSession = false;

  for await (const rawLine of lines) {
    lineNo += 1;
    if (!rawLine.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(rawLine);
    } catch (e) {
      parseErrors.push({ line: lineNo, error: `invalid JSON: ${(e as Error).message}`, raw: rawLine.slice(0, 500) });
      continue;
    }
    if (obj === null || typeof obj !== 'object') {
      parseErrors.push({ line: lineNo, error: 'line is not an object', raw: String(rawLine).slice(0, 500) });
      continue;
    }
    // Measured: some Claude Code records carry no top-level timestamp; the message object does.
    const tsRaw = obj.timestamp ?? obj.message?.timestamp ?? obj.message?.usage?.timestamp;
    const parsed = typeof tsRaw === 'string' ? Date.parse(tsRaw) : num(tsRaw);
    let ts: number;
    let tsStolen = false;
    if (parsed != null && Number.isFinite(parsed)) {
      ts = parsed;
      lastTs = ts;
    } else {
      ts = lastTs;
      // Chrome records (atis-latch / last-prompt) legitimately carry no timestamp and emit no
      // step, so only warn when a replayable step is actually emitted with a borrowed clock.
      tsStolen = true;
    }
    const before = steps.length;
    if (obj.sessionId && !sawSession) {
      sawSession = true;
      meta.sessionId = str(obj.sessionId);
    }
    if (!meta.cwd && typeof obj.cwd === 'string') meta.cwd = obj.cwd;
    if (!meta.cliVersion && typeof obj.version === 'string') meta.cliVersion = obj.version;

    const type = String(obj.type ?? '');
    try {
      switch (type) {
        case 'assistant':
        case 'user': {
          for (const b of blocksOf(obj.message)) {
            const bt = String(b.type ?? '');
            if (bt === 'text') {
              const text = redactOn(str(b.text).trim());
              if (text) steps.push({ kind: type === 'user' ? 'user' : 'assistant', ts, text });
            } else if (bt === 'thinking' || bt === 'redacted_thinking') {
              const text = redactOn(str(b.thinking ?? b.text ?? '').trim());
              steps.push({
                kind: 'reasoning',
                ts,
                summary: text || `[${bt}]`,
              });
            } else if (bt === 'tool_use') {
              const rawArgs = str(b.input);
              const c = cap(rawArgs, o.maxArgsChars);
              steps.push({
                kind: 'tool_call',
                ts,
                callId: str(b.id) || `line${lineNo}`,
                name: str(b.name) || 'unknown_tool',
                args: redactOn(c.text),
                rawArgs: redactOn(c.text),
              });
            } else if (bt === 'tool_result') {
              let body: string;
              if (typeof b.content === 'string') body = b.content;
              else if (Array.isArray(b.content))
                body = b.content
                  .map((x: any) => (typeof x === 'string' ? x : str(x?.text ?? x)))
                  .join('\n');
              else body = str(b.content);
              const c = cap(body, o.maxOutputChars);
              steps.push({
                kind: 'tool_output',
                ts,
                callId: str(b.tool_use_id) || `line${lineNo}`,
                output: redactOn(c.text),
                truncated: c.truncated,
              });
            } else {
              steps.push({ kind: 'unknown', ts, raw: `content-block/${bt}`, sourceLine: lineNo });
            }
          }
          break;
        }
        case 'file-history-snapshot': {
          const keys = Object.keys(obj).filter((k) => k !== 'type' && k !== 'timestamp');
          steps.push({
            kind: 'note',
            ts,
            level: 'info',
            text: `file-history-snapshot: ${keys.slice(0, 12).join(', ')}`,
          });
          break;
        }
        case 'cost-state': {
          const tokens = obj.tokens ?? obj.usage ?? null;
          if (tokens && typeof tokens === 'object') {
            steps.push({
              kind: 'usage',
              ts,
              input: num((tokens as any).input) ?? 0,
              cachedInput: num((tokens as any).cache_read) ?? 0,
              output: num((tokens as any).output) ?? 0,
              reasoning: 0,
              total: num((tokens as any).total) ?? 0,
            });
          } else {
            const scalars = Object.entries(obj)
              .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
              .slice(0, 8)
              .map(([k, v]) => `${k}=${String(v).slice(0, 24)}`);
            steps.push({ kind: 'note', ts, level: 'info', text: `cost-state: ${scalars.join(' ')}` });
          }
          break;
        }
        case 'system': {
          // Claude Code writes compaction as a first-hand host event:
          //   {type:"system", subtype:"compact_boundary", compactMetadata:{trigger,preTokens,
          //    postTokens,cumulativeDroppedTokens,durationMs,...}, content:"Conversation compacted"}
          // Measured on a real 32MB session: 10 such records. Before this case existed the
          // adapter swallowed them as generic chrome and the report honestly-but-wrongly
          // printed "未观测到压缩事件" for a session that compressed ten times.
          if (String(obj.subtype ?? '') !== 'compact_boundary') break;
          const cm = (obj.compactMetadata ?? {}) as Record<string, unknown>;
          const n = (k: string): number | undefined => num(cm[k]);
          const pre = n('preTokens');
          const post = n('postTokens');
          const parts: string[] = [];
          const trig = typeof cm.trigger === 'string' ? cm.trigger : null;
          parts.push(trig ? `宿主压缩（${trig} 触发）` : '宿主压缩');
          if (pre != null) parts.push(`压缩前 ${pre.toLocaleString('en-US')} token`);
          if (post != null) parts.push(`压缩后 ${post.toLocaleString('en-US')} token`);
          if (pre != null && post != null) {
            parts.push(`本次丢弃 ${Math.max(0, pre - post).toLocaleString('en-US')} token`);
          }
          const cum = n('cumulativeDroppedTokens');
          if (cum != null) parts.push(`累计丢弃 ${cum.toLocaleString('en-US')} token`);
          const dur = n('durationMs');
          if (dur != null) parts.push(`耗时 ${(dur / 1000).toFixed(1)}s`);
          steps.push({
            kind: 'compaction',
            ts,
            summary: redactOn(parts.join(' · ')),
            ...(pre != null ? { contextBefore: pre } : {}),
          });
          break;
        }
        // Session chrome, measured on a real 32MB file: ai-title 254 + agent-name 254 +
        // file-history-delta 13 records. None is a replayable step — but ai-title/agent-name
        // carry the conversation title, which the report header can show, so they are read
        // for metadata instead of being rendered as "unknown". Before this, 404 of 3,000
        // displayed steps (13%) were this chrome mislabelled as unclassified.
        case 'ai-title':
        case 'agent-name': {
          const t = obj.aiTitle ?? obj.agentName;
          if (!meta.title && typeof t === 'string' && t.trim()) meta.title = t.trim();
          break;
        }
        // file-history-delta points at a before-image backup under
        // ~/.claude/file-history/<session>/. Verified on this session: all 12 distinct
        // trackingPaths are already covered by an Edit/Write tool_use whose args carry
        // old_string, so reading the backup would add no reversible diff that is not
        // already there. It is therefore chrome, not a step. (See docs/KNOWN-GAPS.md.)
        case 'file-history-delta':
        case 'mode':
        case 'permission-mode':
        case 'last-prompt':
        case 'atis-latch':
        case 'queue-operation':
        case 'attachment':
          break; // known chrome, carries no replayable step
        default:
          steps.push({ kind: 'unknown', ts, raw: type, sourceLine: lineNo });
      }
    } catch (e) {
      parseErrors.push({ line: lineNo, error: `handler failed: ${(e as Error).message}`, raw: rawLine.slice(0, 500) });
    }
    if (tsStolen && steps.length > before) {
      warnings.push(`line ${lineNo}: no timestamp on a replayable record, reused the previous one`);
    }
  }

  if (!sawSession) warnings.push('no sessionId seen; session header is inferred');
  if (parseErrors.length) warnings.push(`${parseErrors.length} line(s) failed to parse`);
  steps.sort((a, b) => a.ts - b.ts);
  const unknownCount = steps.filter((s) => s.kind === 'unknown').length;
  return { meta, steps, parseErrors, warnings, unknownCount, truncated: parseErrors.length > 0 };
}
