import type { ParseError, ReplayStep, Session, SessionMeta } from '../types.js';
import { redact, type RedactOptions } from '../redact.js';
import {
  indexFileHistory,
  planJoins,
  attachBackups,
  deltaFromRecord,
  isLoggedEdit,
  filePathOf,
  type DeltaRecord,
  type LoggedEdit,
  type FileHistoryStats,
} from '../filehistory.js';

export interface ClaudeParseOptions extends RedactOptions {
  maxOutputChars?: number;
  maxArgsChars?: number;
}

const DEFAULTS = { maxOutputChars: 20_000, maxArgsChars: 20_000 };

type ToolCallStep = Extract<ReplayStep, { kind: 'tool_call' }>;

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v);
}
function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
function cap(s: string, n: number): { text: string; truncated: boolean } {
  return s.length > n ? { text: s.slice(0, n), truncated: true } : { text: s, truncated: false };
}
/** The text an edit applied, read off the unredacted input and redacted by the caller. */
function appliedTextOf(input: unknown): string | undefined {
  const a = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!a) return undefined;
  for (const k of ['new_string', 'newText', 'content']) {
    if (typeof a[k] === 'string' && a[k] !== '') return a[k] as string;
  }
  return undefined;
}

/** The log's own before-image, if it wrote one. Read off the UNREDACTED tool input and used
 *  only for the agreement cross-check; it is never attached to a step. */
function inlineOldOf(input: unknown): string | undefined {
  const a = input && typeof input === 'object' ? (input as Record<string, unknown>) : null;
  if (!a) return undefined;
  if (typeof a.old_string === 'string') return a.old_string;
  if (typeof a.oldText === 'string') return a.oldText;
  return undefined;
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
/**
 * Cursor CLI writes the same Anthropic-shaped records as Claude Code, with one
 * difference that matters: the message role sits in `role`, not in `type`, and a
 * turn boundary arrives as `{"type":"turn_ended"}`. A parser keyed on `type` reads
 * a real Cursor transcript as zero steps, which is how a host with plenty of
 * content ends up reported as empty. The shape is shared; the discriminator is
 * this profile, not a second copy of the walk.
 */
export interface AnthropicHostProfile {
  agent: string;
  /** Which top-level record this is, as a switch case. `''` means "no idea" -> unknown record. */
  kindOf(obj: unknown): string;
  /** Recover before-images from the host's own backup store. Claude's is keyed by sessionId. */
  fileHistory: boolean;
  /**
   * Record names that mark a boundary and carry no step. They are skipped before the
   * switch: a Cursor `turn_ended` arriving as an `unknown` step puts a row in the report
   * for something that is not an event, and inflates the unclassified count that the
   * coverage bar is computed from.
   */
  silentTypes?: ReadonlySet<string>;
}

const CLAUDE_HOST: AnthropicHostProfile = {
  agent: 'claude-code',
  kindOf: (o) => String((o as any)?.type ?? ''),
  fileHistory: true,
};

export const CURSOR_HOST: AnthropicHostProfile = {
  agent: 'cursor',
  // `type` still wins when present: `turn_ended` and any future typed record are
  // matched by name, and only a record with no `type` is read as a message.
  kindOf: (o) => {
    const r = o as any;
    if (r?.type != null) return String(r.type);
    return typeof r?.role === 'string' ? r.role : '';
  },
  fileHistory: false,
  silentTypes: new Set(['turn_ended']),
};

export async function parseAnthropicShaped(
  lines: AsyncIterable<string>,
  sourceFile: string | undefined,
  opts: ClaudeParseOptions,
  host: AnthropicHostProfile,
): Promise<Session> {
  const o = { ...DEFAULTS, ...opts };
  const steps: ReplayStep[] = [];
  const parseErrors: ParseError[] = [];
  const warnings: string[] = [];
  const meta: SessionMeta = { sessionId: 'unknown', agent: host.agent, ...(sourceFile ? { sourceFile } : {}) };
  const redactOn = (s: string): string => (opts.enabled === false ? s : redact(s, opts).text);

  let lineNo = 0;
  let lastTs = 0;
  let sawSession = false;
  const edits: LoggedEdit[] = [];
  const deltas: DeltaRecord[] = [];

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

    const type = host.kindOf(obj);
    if (host.silentTypes?.has(type)) continue;
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
              const step: ToolCallStep = {
                kind: 'tool_call',
                ts,
                callId: str(b.id) || `line${lineNo}`,
                name: str(b.name) || 'unknown_tool',
                args: redactOn(c.text),
                rawArgs: redactOn(c.text),
              };
              steps.push(step);
              // The host's file-history delta names the message it fired on, so every edit is
              // kept with that identity. filePath comes from the UNREDACTED args: it is only
              // ever compared, never rendered, and redaction rewrites /Users/<name> paths.
              const nt = appliedTextOf(b.input);
              if (nt != null) step.newText = redactOn(nt);
              if (isLoggedEdit(step.name, b.input)) {
                const fp = filePathOf(b.input);
                const lo = inlineOldOf(b.input);
                edits.push({
                  step,
                  ...(typeof obj.uuid === 'string' ? { uuid: obj.uuid } : {}),
                  ...(fp ? { filePath: fp } : {}),
                  ...(lo == null ? {} : { logOldRaw: lo }),
                });
              }
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
        // NOT chrome. Measured over every session on this machine with a backup directory
        // (40 sessions, 290 records): 274/274 deltas that named a backup resolved to an
        // assistant uuid on this machine, and every named backup existed on disk. This record
        // is the index that turns the backup store into a real before-image (P0-1).
        case 'file-history-delta': {
          const d = deltaFromRecord(obj, ts);
          if (d) deltas.push(d);
          break;
        }
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

  // P0-1: recover before-images from the host's own backup store. Runs after the stream
  // closes because the store is keyed by sessionId, which is only known once the log is read.
  // A host with no such store (Cursor) skips it: reading ~/.claude/file-history for a
  // Cursor session would join a backup from a DIFFERENT tool's session with the same id.
  const fhIndex = host.fileHistory ? indexFileHistory(meta.sessionId, o.homeDir) : { backups: 0 } as ReturnType<typeof indexFileHistory>;
  const { joins, untracked, unresolved } = planJoins(deltas, edits);
  const { stats, attached } = attachBackups(joins, fhIndex, { redact: redactOn, redactEnabled: opts.enabled !== false });
  // attachBackups already redacted the recovered bytes; redacting twice is safe but is one
  // more place for the two paths to drift apart.
  for (const [step, hit] of attached) {
    step.beforeImage = hit.before;
    step.beforeImageFrom = hit.source;
  }
  // Every shortfall is stated. A delta that resolved to nothing is as much a gap as one the
  // host declined to track, and the reader is the one who has to decide which matters.
  stats.untracked = untracked;
  const gaps: string[] = [];
  if (untracked > 0) gaps.push(`${untracked} 处宿主未纳入备份范围`);
  if (unresolved > 0) gaps.push(`${unresolved} 处备份在日志里找不到对应编辑`);
  if (gaps.length) stats.reason = `${stats.reason || ''}${gaps.join('，')}。`.trim();
  if (stats.joins > 0) {
    warnings.push(
      `${stats.joins} 处编辑已匹配 ~/.claude/file-history 备份（${stats.agree} 处与日志内联的 old_string 一致` +
        `${stats.recovered ? `，${stats.recovered} 处日志未写 old_string、只能由备份还原` : ''}` +
        `${stats.disagree ? `，${stats.disagree} 处两者矛盾` : ''}${gaps.length ? `；${gaps.join('，')}` : ''}）`,
    );
  } else if (deltas.length > 0) {
    warnings.push(`file-history: ${deltas.length} 条 delta 未匹配到任何编辑（${gaps.join('，') || '无备份名'}）`);
  }

  if (!sawSession) warnings.push('no sessionId seen; session header is inferred');
  if (parseErrors.length) warnings.push(`${parseErrors.length} line(s) failed to parse`);
  steps.sort((a, b) => a.ts - b.ts);
  const unknownCount = steps.filter((s) => s.kind === 'unknown').length;
  const fileHistory: FileHistoryStats | undefined = deltas.length > 0 || fhIndex.backups > 0 ? stats : undefined;
  return { meta, steps, parseErrors, warnings, unknownCount, truncated: parseErrors.length > 0, ...(fileHistory ? { fileHistory } : {}) };
}

export function parseClaude(
  lines: AsyncIterable<string>,
  sourceFile?: string,
  opts: ClaudeParseOptions = {},
): Promise<Session> {
  return parseAnthropicShaped(lines, sourceFile, opts, CLAUDE_HOST);
}
