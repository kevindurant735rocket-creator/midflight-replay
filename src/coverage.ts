import type { FileHistoryStats, ReplayStep } from './types.js';
import { isEditTool, diffFromArgs } from './diff.js';

/**
 * The honesty bar (AC-12a). The product's whole pitch is "forensics, not instrumentation",
 * so the report must state exactly how much of the file history this particular log can
 * actually give back — before the reader trusts a diff as if it were a real time machine.
 */
/** Codex has no structured edit tool: every file change is a shell command (measured 3391/3391
 *  `exec_command` on a real 109 MiB rollout). Counting only structured edits would report
 *  "no edits" for a session that rewrote the repo, so shell-carried mutations are counted too —
 *  and labelled as the heuristic they are. */
const SHELL_TOOLS = /^(exec_command|shell|bash|sh|zsh|run_command|terminal)$/i;
const WRITE_MARKERS =
  /(>>?\s*[\w./~-]|<<\s*['\"]?EOF|\bapply_patch\b|\btee\b|\bsed\s+-i\b|\bpatch\s+-p|\brm\s+-[a-z]*f|\bmv\s+|\bcp\s+|\bmkdir\b|\btouch\b|\bgit\s+(checkout|apply|restore|reset|stash))/i;

export function isShellTool(name: string): boolean {
  return SHELL_TOOLS.test(name || '');
}
export function looksLikeMutation(rawArgs: string): boolean {
  return WRITE_MARKERS.test(rawArgs || '');
}

export interface Coverage {
  agent: string;
  /** edit-type tool calls seen */
  edits: number;
  /** shell calls whose command text carries a write marker (heuristic) */
  shellMutations: number;
  /** edits with a before-image from any source (log inline or host backup store) */
  withBefore: number;
  /** subset whose before-image the log itself carried (`old_string`) */
  withBeforeLog: number;
  /** subset recovered from ~/.claude/file-history (P0-1) */
  withBeforeBackup: number;
  /** backups the host had for this session; 0 when there is no backup store */
  backups: number;
  /** edits that needed a before-image and got none, after both sources were tried */
  missing: number;
  /** withBefore / edits, 1.0 when there are no edits at all */
  ratio: number;
  verdict: 'full' | 'partial' | 'diff-only' | 'no-edits';
  /** one sentence, stated in the report verbatim */
  reason: string;
}

export function computeCoverage(steps: ReplayStep[], agent: string, fh?: FileHistoryStats): Coverage {
  let edits = 0;
  let withBeforeLog = 0;
  let withBeforeBackup = 0;
  let shellMutations = 0;
  for (const s of steps) {
    if (s.kind !== 'tool_call') continue;
    if (isShellTool(s.name)) {
      if (looksLikeMutation(s.rawArgs)) shellMutations += 1;
      continue;
    }
    if (!isEditTool(s.name)) continue;
    edits += 1;
    const d = diffFromArgs(s.rawArgs, s.beforeImage, s.newText);
    if (!d?.reconstructable) continue;
    // Provenance matters to the reader: a before-image the host stated contemporaneously is
    // a stronger claim than one reconstructed from a backup file after the fact.
    if (diffFromArgs(s.rawArgs, undefined, s.newText)?.reconstructable) withBeforeLog += 1;
    else withBeforeBackup += 1;
  }
  const withBefore = withBeforeLog + withBeforeBackup;
  const missing = Math.max(0, edits - withBefore);
  const backups = fh?.backups ?? 0;
  const ratio = edits === 0 ? 1 : withBefore / edits;
  const total = edits + shellMutations;
  // Named only when it explains the gap; otherwise it is noise in a one-sentence verdict.
  const backupNote =
    withBeforeBackup > 0
      ? `（其中 ${withBeforeBackup} 处由 ~/.claude/file-history 备份还原，共扫描到 ${backups} 个备份）`
      : backups > 0
        ? `（本机有 ${backups} 个 file-history 备份，日志已自带全部 before-image，未做交叉校验）`
        : '';
  let verdict: Coverage['verdict'];
  let reason: string;
  if (total === 0) {
    verdict = 'no-edits';
    reason = '本会话没有观察到文件写入，无文件变更可回看。';
  } else if (edits === 0) {
    verdict = 'diff-only';
    reason =
      `该 host 没有结构化编辑工具：${shellMutations} 处改动全部由 shell 命令承载（按命令文本启发式识别），` +
      `日志未记录任何 before-image，因此只能看命令本身，不能逆放。`;
  } else if (ratio === 1) {
    verdict = 'full';
    reason = `${edits} 处编辑全部带 before-image，文件状态可离线逆放。${backupNote}`;
  } else if (ratio > 0) {
    verdict = 'partial';
    reason = `${edits} 处编辑中 ${withBefore} 处带 before-image，其余 ${missing} 处只能看到 agent 自述的补丁。${backupNote}`;
  } else if (backups > 0) {
    verdict = 'diff-only';
    reason =
      `本会话 ${edits} 处编辑既没有日志内联的 old_string，也没有能对上的 file-history 备份` +
      `（已扫描 ${backups} 个备份），只能看 diff，不能逆放。`;
  } else {
    verdict = 'diff-only';
    reason =
      `本会话 ${edits} 处编辑均未记录 before-image（该 host 不写 old_string，本机也没有该会话的 file-history 备份），` +
      `只能看 diff，不能逆放。`;
  }
  return { agent, edits, withBefore, withBeforeLog, withBeforeBackup, backups, missing, ratio, shellMutations, verdict, reason };
}

export const VERDICT_LABEL: Record<Coverage['verdict'], string> = {
  full: '可逆放',
  partial: '部分可逆放',
  'diff-only': '仅 diff',
  'no-edits': '无编辑',
};
