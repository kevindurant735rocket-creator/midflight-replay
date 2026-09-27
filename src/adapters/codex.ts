import type { ParseError, ReplayStep, Session, SessionMeta } from '../types.js';
import { redact, type RedactOptions } from '../redact.js';

/** Per-agent parse tuning. */
export interface CodexParseOptions extends RedactOptions {
  /** hard cap on a single tool output kept in memory (chars) */
  maxOutputChars?: number;
  /** hard cap on a single tool call argument string kept in memory (chars) */
  maxArgsChars?: number;
}

const DEFAULTS = { maxOutputChars: 20_000, maxArgsChars: 20_000 };

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}

function parseArgs(raw: string): { args: unknown; ok: boolean } {
  if (!raw) return { args: {}, ok: false };
  try {
    return { args: JSON.parse(raw), ok: true };
  } catch {
    return { args: raw, ok: false };
  }
}

/**
 * Codex rollout JSONL. Contract: docs/FORMATS.md
 * Every line is `{timestamp, ordinal, type, payload}`. Unknown events are kept, never dropped.
 */
export async function parseCodex(
  lines: AsyncIterable<string>,
  sourceFile?: string,
  opts: CodexParseOptions = {},
): Promise<Session> {
  const o = { ...DEFAULTS, ...opts };
  const steps: ReplayStep[] = [];
  const parseErrors: ParseError[] = [];
  const warnings: string[] = [];
  const meta: SessionMeta = { sessionId: 'unknown', agent: 'codex', ...(sourceFile ? { sourceFile } : {}) };

  const redactOn = (s: string): string => (opts.enabled === false ? s : redact(s, opts).text);
  const cap = (s: string, n: number): { text: string; truncated: boolean } =>
    s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false };

  let lineNo = 0;
  let lastTs = 0;
  let sawMeta = false;
  let prevUsage: { input: number; cached: number; output: number; reasoning: number; total: number } | null = null;
  /** last observed per-request context size (input tokens), used to label compaction events */
  let lastInputTokens = 0;
  const callNames = new Map<string, string>();

  /**
   * Newer rollouts carry BOTH `event_msg/token_count` and `token_usage_record` for the same
   * API response. Emit once: identical (input,output,total) within 2s is the same sample seen
   * on two streams, not two samples.
   */
  let lastEmit: { ts: number; input: number; output: number; total: number } | null = null;
  const pushUsage = (
    ts: number,
    cur: { input: number; cached: number; output: number; reasoning: number; total: number },
    extra?: { turnId?: string; threadTotal?: number; contextWindow?: number },
  ): void => {
    lastInputTokens = cur.input;
    if (
      lastEmit &&
      cur.input === lastEmit.input &&
      cur.output === lastEmit.output &&
      cur.total === lastEmit.total &&
      ts - lastEmit.ts < 2000
    ) {
      prevUsage = cur;
      return;
    }
    lastEmit = { ts, input: cur.input, output: cur.output, total: cur.total };
    lastInputTokens = cur.input;
    steps.push({
      kind: 'usage',
      ts,
      input: cur.input,
      cachedInput: cur.cached,
      output: cur.output,
      reasoning: cur.reasoning,
      total: cur.total,
      ...(extra?.turnId ? { turnId: extra.turnId } : {}),
      ...(extra?.threadTotal != null ? { threadTotal: extra.threadTotal } : {}),
      ...(extra?.contextWindow ? { contextWindow: extra.contextWindow } : {}),
    });
    prevUsage = cur;
  };
  const readUsage = (u: any) => ({
    input: num(u?.input_tokens) ?? 0,
    cached: num(u?.cached_input_tokens) ?? 0,
    output: num(u?.output_tokens) ?? 0,
    reasoning: num(u?.reasoning_output_tokens) ?? 0,
    total: num(u?.total_tokens) ?? 0,
  });

  const toTs = (raw: unknown): number => {
    const ms = typeof raw === 'string' ? Date.parse(raw) : num(raw);
    if (ms != null && Number.isFinite(ms)) {
      lastTs = ms;
      return ms;
    }
    warnings.push(`line ${lineNo}: missing/invalid timestamp, reused previous`);
    return lastTs;
  };

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
    const ts = toTs(obj.timestamp);
    const type = String(obj.type ?? '');
    const p: any = obj.payload ?? {};
    const sub = String(p.type ?? '');

    try {
      switch (type) {
        case 'session_meta': {
          sawMeta = true;
          meta.sessionId = str(p.session_id || p.id) || 'unknown';
          meta.cliVersion = str(p.cli_version) || undefined;
          meta.cwd = str(p.cwd) || undefined;
          meta.provider = str(p.model_provider) || undefined;
          meta.startedAt = typeof p.timestamp === 'string' ? Date.parse(p.timestamp) || undefined : undefined;
          const git = p.git;
          if (git && typeof git === 'object') meta.gitBranch = str(git.branch) || undefined;
          const cw = num(p.context_window) ?? num(p.model_context_window);
          if (cw) meta.contextWindow = cw;
          break;
        }
        case 'turn_context': {
          meta.model = str(p.model) || meta.model;
          meta.effort = str(p.effort) || undefined;
          if (!meta.cwd) meta.cwd = str(p.cwd) || undefined;
          steps.push({
            kind: 'turn_start',
            ts,
            turnId: str(p.turn_id) || `t${lineNo}`,
            ...(str(p.model) ? { model: str(p.model) } : {}),
            ...(str(p.effort) ? { effort: str(p.effort) } : {}),
            ...(num(p.model_context_window) ? { contextWindow: num(p.model_context_window)! } : {}),
          });
          break;
        }
        case 'world_state': {
          const state = p.state && typeof p.state === 'object' ? p.state : {};
          steps.push({
            kind: 'note',
            ts,
            level: 'info',
            text: `world_state snapshot${p.full === true ? ' (full)' : ''}: keys=[${Object.keys(state).slice(0, 20).join(', ')}]`,
          });
          break;
        }
        case 'response_item': {
          if (sub === 'message') {
            const parts: string[] = [];
            const content = p.content;
            if (typeof content === 'string') parts.push(content);
            else if (Array.isArray(content)) {
              for (const c of content) {
                if (c && typeof c === 'object' && typeof (c as any).text === 'string') parts.push((c as any).text);
              }
            }
            const text = redactOn(parts.join('\n').trim());
            const role = str(p.role) || 'assistant';
            if (text) steps.push({ kind: role === 'user' ? 'user' : 'assistant', ts, text });
          } else if (sub === 'reasoning') {
            const summary = Array.isArray(p.summary)
              ? p.summary.map((s: any) => (typeof s === 'string' ? s : str(s?.text))).filter(Boolean).join(' ')
              : '';
            const body = typeof p.content === 'string' ? p.content : '';
            const text = redactOn((summary || body).trim());
            if (text) steps.push({ kind: 'reasoning', ts, summary: text });
          } else if (sub === 'function_call') {
            const rawArgs = str(p.arguments);
            const capped = cap(rawArgs, o.maxArgsChars);
            const { args } = parseArgs(capped.text);
            const callId = str(p.call_id) || str(p.id) || `line${lineNo}`;
            const name = str(p.name) || 'unknown_tool';
            callNames.set(callId, name);
            steps.push({ kind: 'tool_call', ts, callId, name, args: redactOn(JSON.stringify(args)), rawArgs: redactOn(capped.text) });
          } else if (sub === 'web_search_call') {
            const callId = str(p.id) || `line${lineNo}`;
            const action = p.action ?? {};
            steps.push({
              kind: 'tool_call',
              ts,
              callId,
              name: 'web_search',
              args: redactOn(JSON.stringify(action)),
              rawArgs: redactOn(str(action.query ?? action.queries ?? action)),
            });
          } else if (sub === 'function_call_output') {
            const callId = str(p.call_id) || str(p.id) || `line${lineNo}`;
            const capped = cap(str(p.output), o.maxOutputChars);
            const name = callNames.get(callId);
            steps.push({
              kind: 'tool_output',
              ts,
              callId,
              output: redactOn(capped.text),
              truncated: capped.truncated || capped.text.length < str(p.output).length,
            });
            void name;
          } else {
            steps.push({ kind: 'unknown', ts, raw: `${type}/${sub}`, sourceLine: lineNo });
          }
          break;
        }
        case 'event_msg': {
          if (sub === 'token_count') {
            const info = p.info ?? {};
            const last = info.last_token_usage ?? {};
            const total = info.total_token_usage ?? {};
            const cur = readUsage(Object.keys(last).length ? last : total);
            const cw = num(info.model_context_window);
            pushUsage(ts, cur, { ...(cw ? { contextWindow: cw } : {}) });
            if (cw) meta.contextWindow = cw;
          } else if (sub === 'task_started') {
            steps.push({
              kind: 'turn_start',
              ts,
              turnId: str(p.turn_id) || `t${lineNo}`,
              ...(num(p.model_context_window) ? { contextWindow: num(p.model_context_window)! } : {}),
            });
          } else if (sub === 'turn_aborted') {
            steps.push({
              kind: 'note',
              ts,
              level: 'warn',
              text: `turn aborted: ${str(p.reason) || 'unknown'}${num(p.duration_ms) ? ` after ${Math.round(num(p.duration_ms)! / 1000)}s` : ''}`,
            });
          } else if (sub === 'thread_settings_applied') {
            // 82 occurrences, mostly noise; only speak up when the model/effort actually moves.
            const s2 = p.thread_settings ?? {};
            const m = str(s2.model), e = str(s2.reasoning_effort);
            if ((m && m !== meta.model) || (e && e !== meta.effort)) {
              steps.push({ kind: 'note', ts, level: 'info', text: `settings changed: model=${m || meta.model || '?'} effort=${e || '?'}` });
            }
            if (m) meta.model = m;
            if (e) meta.effort = e;
            if (!meta.cwd && str(s2.cwd)) meta.cwd = str(s2.cwd);
          } else if (sub === 'task_complete') {
            steps.push({
              kind: 'turn_end',
              ts,
              turnId: str(p.turn_id) || `t${lineNo}`,
              ...(num(p.duration_ms) ? { durationMs: num(p.duration_ms)! } : {}),
              ...(num(p.time_to_first_token_ms) ? { ttftMs: num(p.time_to_first_token_ms)! } : {}),
            });
          }
          // item_completed duplicates the response_item; intentionally folded away.
          break;
        }
        case 'token_usage_record': {
          const cur = readUsage(p.usage);
          const threadTotal = num(p.thread_token_usage?.total_tokens);
          pushUsage(ts, cur, {
            ...(str(p.turn_id) ? { turnId: str(p.turn_id) } : {}),
            ...(threadTotal != null ? { threadTotal } : {}),
            ...(meta.contextWindow ? { contextWindow: meta.contextWindow } : {}),
          });
          break;
        }
        case 'compacted': {
          const msg = typeof p.message === 'string' ? p.message : str(p.message);
          steps.push({
            kind: 'compaction',
            ts,
            summary: redactOn(msg).slice(0, 4000),
            ...(str(p.turn_id) ? { turnId: str(p.turn_id) } : {}),
            ...(lastInputTokens ? { contextBefore: lastInputTokens } : {}),
          });
          break;
        }
        default:
          steps.push({ kind: 'unknown', ts, raw: type, sourceLine: lineNo });
      }
    } catch (e) {
      parseErrors.push({ line: lineNo, error: `handler failed: ${(e as Error).message}`, raw: rawLine.slice(0, 500) });
    }
  }

  if (!sawMeta) warnings.push('no session_meta line found; session header is inferred');
  if (parseErrors.length) warnings.push(`${parseErrors.length} line(s) failed to parse`);

  steps.sort((a, b) => a.ts - b.ts);
  const unknownCount = steps.filter((s) => s.kind === 'unknown').length;
  return { meta, steps, parseErrors, warnings, unknownCount, truncated: parseErrors.length > 0 };
}
