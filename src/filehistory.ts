/**
 * Read the host's own before-image backups (P0-1).
 *
 * Claude Code writes a backup of every file it is about to modify into
 * `~/.claude/file-history/<sessionId>/<hash>@vN`, and — this is the part that makes the
 * feature exact rather than a guess — the transcript says so in the open. Every
 * `file-history-delta` record names the backup it just took, the message that triggered it,
 * and the absolute path it covers:
 *
 *   {type:"file-history-delta", messageId:"<assistant uuid>", trackingPath:"src/a.ts",
 *    backup:{backupFileName:"c439adb7c536d749@v1", version:1, realParentDir:"/repo/src"}}
 *
 * So the join needs no inference at all: `messageId` -> the assistant message, and within
 * that message the tool call whose `file_path` resolves to `realParentDir + basename(trackingPath)`.
 *
 * Measured over every session on this machine that has a backup directory (2026-09-27,
 * 40 sessions, 290 delta records):
 *   - `messageId` matched an assistant `uuid`: 274/274 of the deltas that name a backup, 0 misses
 *   - `realParentDir + basename(trackingPath)` equalled the tool call's `file_path`: 25/25 on the
 *     session checked with realpath normalisation
 *   - the named backup file existed on disk: 274/274
 *   - the remaining 16 deltas carry `backupFileName: null` — the host declined to track those
 *     paths (measured: all under /tmp). Those are reported as untracked, never guessed at.
 *
 * Why bother when the log also writes `old_string`: the inline copy is a courtesy of one CLI
 * version. Rotate the transcript, upgrade the host, or read a session from a future build that
 * drops the field, and the backup store is the only surviving copy of "what the file looked
 * like before". It also cross-checks the log — see DISAGREEMENT below.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileHistoryStats, ReplayStep } from './types.js';
import { isEditTool } from './diff.js';

export type ToolCallStep = Extract<ReplayStep, { kind: 'tool_call' }>;

export const FILE_HISTORY_ROOT = '.claude/file-history';

/** Per-file read ceiling. A backup is a whole file, so a repo of large blobs could otherwise
 *  turn "recover the before-image" into an OOM. Files over the ceiling are counted and
 *  reported, never silently dropped. */
export const MAX_BACKUP_BYTES = 4 * 1024 * 1024;

export type { FileHistoryStats };

const norm = (s: string): string => s.replace(/\r\n/g, '\n');

export function indexFileHistory(sessionId: string, homeDir?: string): { root: string; available: boolean; backups: number; oversize: number; unreadable: number; reason: string } {
  const home = homeDir || process.env.HOME || '';
  const root = home ? join(home, FILE_HISTORY_ROOT, sessionId) : '';
  const base = { root, available: false, backups: 0, oversize: 0, unreadable: 0, reason: '' };
  if (!root) return { ...base, reason: 'HOME 未设置，无法定位 file-history 备份目录。' };
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return { ...base, reason: `本机没有该会话的 file-history 备份（${root} 不存在），before-image 只能靠日志内联的 old_string。` };
  }
  let backups = 0;
  let oversize = 0;
  let unreadable = 0;
  for (const n of names) {
    if (!/@v\d+$/i.test(n)) continue;
    try {
      const st = statSync(join(root, n));
      if (!st.isFile()) continue;
      backups += 1;
      if (st.size > MAX_BACKUP_BYTES) oversize += 1;
    } catch {
      unreadable += 1;
    }
  }
  return {
    root,
    available: backups > 0,
    backups,
    oversize,
    unreadable,
    reason: backups ? '' : `该会话的 file-history 目录里没有备份（${root}），before-image 只能靠日志内联的 old_string。`,
  };
}

/** One `file-history-delta` record, reduced to what the join needs. */
export interface DeltaRecord {
  messageId?: string;
  /** null when the host declined to track the path */
  backupFileName?: string | null;
  trackingPath?: string;
  realParentDir?: string;
  ts: number;
}

/** One edit tool call found in the log, with the message identity that links it to a delta. */
export interface LoggedEdit {
  step: ToolCallStep;
  uuid?: string;
  filePath?: string;
  /**
   * The log's own `old_string`, UNREDACTED, kept only for the agreement check. Comparing the
   * redacted copies instead produced false disagreements: redaction is not a homomorphism over
   * a JSON-escape boundary, so `token: <secret>\n` in the log's JSON args and the same text in
   * the raw file redact to different lengths and `includes` fails on an agreeing pair.
   * This value is compared and dropped — it is never attached to a step or rendered.
   */
  logOldRaw?: string;
}

export interface PlannedJoin {
  step: ToolCallStep;
  backupFileName: string;
  absPath: string;
  logOldRaw?: string;
  /** 'path' = the file paths matched; 'sole' = the message had exactly one edit and one delta,
   *  so the pairing is unambiguous even when the paths differ (e.g. relative vs absolute) */
  via: 'path' | 'sole';
}

function absOf(d: DeltaRecord): string {
  if (!d.realParentDir || !d.trackingPath) return '';
  const base = d.trackingPath.split('/').pop() ?? '';
  return d.realParentDir.endsWith('/') ? d.realParentDir + base : join(d.realParentDir, base);
}

/**
 * Pair each delta with the edit it belongs to. Two rules, strongest first:
 *   1. paths agree  -> use it
 *   2. the message held exactly one edit and exactly one delta -> use it, and say so
 * Anything else is left unpaired. A wrong before-image is worse than a missing one, because
 * the report would then show a diff that never happened.
 */
export function planJoins(deltas: DeltaRecord[], edits: LoggedEdit[]): { joins: PlannedJoin[]; untracked: number; unresolved: number } {
  const byUuid = new Map<string, LoggedEdit[]>();
  for (const e of edits) {
    if (!e.uuid) continue;
    const list = byUuid.get(e.uuid) ?? [];
    list.push(e);
    byUuid.set(e.uuid, list);
  }
  const taken = new Set<ToolCallStep>();
  const joins: PlannedJoin[] = [];
  let untracked = 0;
  let unresolved = 0;
  for (const d of deltas) {
    const name = d.backupFileName;
    if (!name) {
      untracked += 1;
      continue;
    }
    if (!d.messageId) {
      unresolved += 1;
      continue;
    }
    const group = byUuid.get(d.messageId) ?? [];
    const abs = absOf(d);
    const free = group.filter((e) => !taken.has(e.step));
    if (free.length === 0) {
      unresolved += 1;
      continue;
    }
    let hit = free.find((e) => e.filePath && abs && e.filePath === abs);
    let via: PlannedJoin['via'] = 'path';
    if (!hit && group.length === 1 && free.length === 1) {
      hit = free[0];
      via = 'sole';
    }
    if (!hit) {
      unresolved += 1;
      continue;
    }
    taken.add(hit.step);
    joins.push({
      step: hit.step,
      backupFileName: name,
      absPath: abs || hit.filePath || '',
      via,
      ...(hit.logOldRaw === undefined ? {} : { logOldRaw: hit.logOldRaw }),
    });
  }
  return { joins, untracked, unresolved };
}

export interface AttachResult {
  stats: FileHistoryStats;
  /** steps whose before-image came from the backup store; the text is already redacted */
  attached: Map<ToolCallStep, { before: string; source: string; absPath: string }>;
}

/**
 * Resolve planned joins against the backup store and attach the before-image. When the log
 * ALSO carries an `old_string`, the two are compared instead of one silently overwriting the
 * other: a mismatch means the log and the host's backup disagree about history, which is
 * exactly the kind of thing a forensic tool exists to surface.
 */
export function attachBackups(
  planned: PlannedJoin[],
  idx: { root: string; backups: number; oversize: number; unreadable: number },
  opts: { redact: (s: string) => string; redactEnabled: boolean },
): AttachResult {
  const attached = new Map<ToolCallStep, { before: string; source: string; absPath: string }>();
  let agree = 0;
  let disagree = 0;
  let recovered = 0;
  let missing = 0;
  let oversize = 0;
  let unreadable = 0;
  let resolved = 0;
  for (const p of planned) {
    const path = join(idx.root, p.backupFileName);
    let st: { size: number };
    try {
      st = statSync(path);
    } catch {
      missing += 1;
      continue;
    }
    if (st.size > MAX_BACKUP_BYTES) {
      oversize += 1;
      continue;
    }
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch {
      unreadable += 1;
      continue;
    }
    resolved += 1;
    const before = norm(raw);
    // The backup is the file as it was BEFORE this edit, so the log's own old_string — the text
    // the edit replaced — must appear inside it. Containment, not equality: the backup is the
    // whole file, the old_string a fragment of it. Both sides are UNREDACTED here on purpose
    // (see LoggedEdit.logOldRaw); redaction would be compared instead of the data.
    const logOld = p.logOldRaw;
    if (logOld == null) recovered += 1;
    else if (before.includes(norm(logOld))) agree += 1;
    else disagree += 1;
    attached.set(p.step, {
      before: opts.redactEnabled ? opts.redact(before) : before,
      source: p.backupFileName,
      absPath: p.absPath,
    });
  }
  const joins = attached.size;
  const reason = describe({ resolved, joins, agree, disagree, recovered, untracked: 0, missing, oversize, unreadable, backups: idx.backups });
  return {
    stats: { root: idx.root, available: idx.backups > 0, backups: idx.backups, resolved, joins, agree, disagree, recovered, untracked: 0, missing, oversize, unreadable, reason },
    attached,
  };
}

function describe(n: { resolved: number; joins: number; agree: number; disagree: number; recovered: number; untracked: number; missing: number; oversize: number; unreadable: number; backups: number }): string {
  const bits: string[] = [];
  if (n.joins > 0) bits.push(`${n.joins} 处编辑已匹配到 ~/.claude/file-history 备份（共 ${n.backups} 个备份）`);
  if (n.agree > 0) bits.push(`其中 ${n.agree} 处与日志内联的 old_string 逐字一致`);
  if (n.recovered > 0) bits.push(`${n.recovered} 处日志未写 old_string，只能由备份还原`);
  if (n.untracked > 0) bits.push(`${n.untracked} 处宿主未纳入备份范围`);
  if (n.missing > 0) bits.push(`${n.missing} 个备份在磁盘上已不存在`);
  if (n.oversize > 0) bits.push(`${n.oversize} 个备份超过 ${MAX_BACKUP_BYTES / 1048576} MiB 上限未读`);
  if (n.unreadable > 0) bits.push(`${n.unreadable} 个备份无法读取`);
  if (n.disagree > 0) bits.push(`${n.disagree} 处日志的 old_string 与备份矛盾（按备份渲染）`);
  if (bits.length === 0) return '';
  return `${bits.join('；')}。`;
}

/** Does this edit call already carry its own before-image? */
export function needsBeforeImage(args: Record<string, unknown> | null): boolean {
  if (!args) return false;
  const hasOld = typeof args.old_string === 'string' || typeof args.oldText === 'string';
  const hasNew = typeof args.new_string === 'string' || typeof args.newText === 'string' || typeof args.content === 'string';
  return hasNew && !hasOld;
}

/** Pull the fields the join needs out of one `file-history-delta` record. */
export function deltaFromRecord(obj: any, ts: number): DeltaRecord | null {
  const b = obj?.backup;
  if (!b || typeof b !== 'object') return null;
  return {
    ...(typeof obj.messageId === 'string' ? { messageId: obj.messageId } : {}),
    backupFileName: typeof b.backupFileName === 'string' ? b.backupFileName : null,
    ...(typeof obj.trackingPath === 'string' ? { trackingPath: obj.trackingPath } : {}),
    ...(typeof b.realParentDir === 'string' ? { realParentDir: b.realParentDir } : {}),
    ts,
  };
}

/**
 * Is this tool call a file edit worth pairing with a backup? Every edit qualifies, not only the
 * ones missing an inline `old_string`: the delta names its own message, so the pairing is exact
 * either way, and cross-checking the ones that DO have an inline `old_string` is the payoff —
 * a log that disagrees with the host's own backup is a finding, not a detail.
 */
export function isLoggedEdit(name: string, args: unknown): boolean {
  return isEditTool(name) && !!args && typeof args === 'object';
}

export function filePathOf(args: unknown): string | undefined {
  const o = args && typeof args === 'object' ? (args as Record<string, unknown>) : null;
  if (!o) return undefined;
  const fp = typeof o.file_path === 'string' ? o.file_path : typeof o.path === 'string' ? o.path : undefined;
  return fp;
}
