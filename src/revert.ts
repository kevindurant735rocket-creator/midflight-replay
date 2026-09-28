/**
 * The inverse of the report: turn one step back into a patch that undoes it.
 *
 * Scope is deliberately narrow (P0-2, docs/BACKLOG.md):
 *   - READ a self-contained report produced by `replay`.
 *   - EMIT one unified diff to stdout / --out, ready for `git apply -R`.
 *   - NEVER touch the working tree. The command that would write is `git apply`, the
 *     user's, with their review in between. Keeping the write out of here is what keeps
 *     the zero-network / zero-write / no-hidden-surprise claim true.
 *
 * The report is the only input. It is a single self-contained file, so `revert` needs no
 * access to the original session log, the backup store, or the network — the exact same
 * forensic artefact a colleague can be handed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { isEditTool, unifiedPatch } from './diff.js';
import type { ReplayStep } from './types.js';

export interface RevertOk {
  ok: true;
  step: number;
  path: string;
  patch: string;
  added: number;
  removed: number;
  source: 'log' | 'file-history';
}

export interface RevertRefused {
  ok: false;
  step: number;
  reason: string;
  code:
    | 'NO_BEFORE_IMAGE'   // the step never carried a before-image and none was recovered
    | 'NOT_A_FILE_EDIT'    // the step is not a file-mutating tool call
    | 'STEP_OUT_OF_RANGE'  // no such step
    | 'NO_FILE_PATH'       // cannot name the target file, so cannot write a valid patch header
    | 'EMPTY_DIFF'         // before == after; a patch would be a no-op that `git apply` accepts silently
    | 'TREE_UNREADABLE'    // the target file is not on disk any more, so there is no "after" state to patch
    | 'TREE_DIVERGED';     // the file no longer contains what this step wrote — the tree moved on
}

export type RevertResult = RevertOk | RevertRefused;

const D_MARK = 'const D = ';

/**
 * Slice the embedded payload out of a report by walking braces with string
 * awareness, NOT by matching up to the next `};`.
 *
 * The lazy-regex version broke on real sessions: `};` occurs constantly inside
 * log text (any JS or JSON the agent wrote), so the match stopped mid-string and
 * `revert` could not read reports built from exactly the code sessions it exists
 * to inspect. Counting depth while tracking quotes and escapes finds the payload
 * that is actually there.
 *
 * @returns the JSON text, or null when the braces never balance (truncated file)
 */
function slicePayload(html: string): string | null {
  const at = html.indexOf(D_MARK);
  if (at === -1) return null;
  let start = at + D_MARK.length;
  while (start < html.length && /\s/.test(html[start]!)) start++;
  if (html[start] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return html.slice(start, i + 1);
  }
  return null; // ran off the end with the object still open
}

/** Pull the embedded `const D = {...}` payload out of a report. Throws if the file is not a report. */
export function readReportPayload(html: string): { steps: ReplayStep[]; cwd?: string } {
  if (html.indexOf(D_MARK) === -1) {
    throw new Error('这不是 midflight 生成的报告：找不到内嵌数据 `const D = {...}`。');
  }
  const json = slicePayload(html);
  if (json === null) {
    throw new Error('报告文件不完整：内嵌数据的括号没有闭合，文件可能已被截断或损坏。');
  }
  let data: { steps?: ReplayStep[]; meta?: { cwd?: string } };
  try {
    data = JSON.parse(json) as typeof data;
  } catch (err) {
    throw new Error(`报告内嵌数据无法解析（文件可能已损坏）：${(err as Error).message}`);
  }
  if (!Array.isArray(data.steps)) throw new Error('报告内嵌数据里没有 steps 数组，文件可能已损坏。');
  return { steps: data.steps, cwd: typeof data.meta?.cwd === 'string' ? data.meta.cwd : undefined };
}

/** The `-` side the log itself recorded. Fragment-only: the old_string of one edit call. */
function oldOf(rawArgs: string): string | undefined {
  try {
    const a = JSON.parse(rawArgs) as Record<string, unknown> | null;
    if (!a || typeof a !== 'object') return undefined;
    if (typeof a.old_string === 'string' && a.old_string !== '') return a.old_string;
    if (typeof a.oldText === 'string' && a.oldText !== '') return a.oldText;
  } catch { /* clipped args */ }
  return undefined;
}

/** Does this step carry enough to be reversible at all, ignoring whether the tree still matches? */
export function isReversible(s: ReplayStep): boolean {
  if (s.kind !== 'tool_call') return false;
  if (!isEditTool(s.name)) return false;
  if (!filePathOfArgs(s.rawArgs)) return false;
  if (typeof s.beforeImage === 'string' && s.beforeImage !== '') return true;
  return oldOf(s.rawArgs) !== undefined && typeof s.newText === 'string' && s.newText !== '';
}

/** Which steps in a report can be reverted. Works without a live checkout — that is the point of --list. */
export function listRevertable(steps: ReplayStep[]): { step: number; path: string; source: 'log' | 'file-history' }[] {
  const out: { step: number; path: string; source: 'log' | 'file-history' }[] = [];
  steps.forEach((s, i) => {
    if (s.kind !== 'tool_call' || !isReversible(s)) return;
    out.push({
      step: i,
      path: filePathOfArgs(s.rawArgs)!,
      source: typeof s.beforeImage === 'string' && s.beforeImage !== '' ? 'file-history' : 'log',
    });
  });
  return out;
}

/**
 * `git apply -p1` resolves the patch path relative to the repository root, and the
 * session's cwd is that root. So an absolute file_path under the cwd must be made
 * relative for the patch to apply. A file outside the cwd (or no cwd recorded) keeps
 * its absolute form — `git apply` will then refuse, which is the honest outcome: a
 * patch that would edit outside the repository is not something to hand over silently.
 */
function gitPath(abs: string, cwd?: string): string {
  if (!cwd) return abs.replace(/^\/+/, '');
  const norm = abs.replace(/\/+$/, '');
  if (norm === cwd) return '/dev/null';
  if (norm.startsWith(cwd + '/')) return norm.slice(cwd.length + 1);
  return abs.replace(/^\/+/, '');
}

function filePathOfArgs(rawArgs: string): string | undefined {
  try {
    const a = JSON.parse(rawArgs);
    if (a && typeof a === 'object') {
      if (typeof a.file_path === 'string' && a.file_path) return a.file_path;
      if (typeof a.path === 'string' && a.path) return a.path;
    }
  } catch { /* clipped args; no path */ }
  return undefined;
}

/**
 * Build the patch that undoes `stepIndex`, or refuse loudly.
 *
 * Both sides are WHOLE-FILE states, never fragments: a hunk built from a bare
 * `old_string`/`new_string` pair carries no context and no true line number, so `git apply`
 * cannot place it and `--check` fails on a real edit. `beforeWhole` comes from the host's
 * own backup when file-history linked one (P0-1), otherwise from the log's old_string
 * substituted back into the file as it stands. `afterWhole` is the file as it is on disk
 * right now, because that is what the patch has to apply to.
 *
 * Nothing here writes. The caller reviews, then runs `git apply -R` themselves.
 */
export function planRevert(
  steps: ReplayStep[],
  stepIndex: number,
  cwd?: string,
  readCurrent: (absPath: string) => string | undefined = defaultRead,
): RevertResult {
  if (!Number.isInteger(stepIndex) || stepIndex < 0 || stepIndex >= steps.length) {
    return { ok: false, step: stepIndex, code: 'STEP_OUT_OF_RANGE', reason: `步骤 ${stepIndex} 不存在：这份报告共 ${steps.length} 步。用 --list 看哪些步骤能撤回。` };
  }
  const s = steps[stepIndex] as ReplayStep;
  if (s.kind !== 'tool_call') {
    return { ok: false, step: stepIndex, code: 'NOT_A_FILE_EDIT', reason: `步骤 ${stepIndex} 是 ${s.kind}，不是文件编辑，撤不回来。` };
  }
  if (!isEditTool(s.name)) {
    return { ok: false, step: stepIndex, code: 'NOT_A_FILE_EDIT', reason: `步骤 ${stepIndex} 的工具是 ${s.name}，不写文件，撤不回来。` };
  }
  const path = filePathOfArgs(s.rawArgs);
  if (!path) {
    return { ok: false, step: stepIndex, code: 'NO_FILE_PATH', reason: `步骤 ${stepIndex} 没有记录 file_path，写不出合法的补丁头（--- a/path）。` };
  }
  const relPath = gitPath(path, cwd);
  const afterWhole = readCurrent(path);
  if (afterWhole === undefined) {
    return {
      ok: false, step: stepIndex, code: 'TREE_UNREADABLE',
      reason: `步骤 ${stepIndex}（${s.name} ${path}）的目标文件现在不在磁盘上，没有"改动之后"的状态可打补丁。想逆放请先在正确的 checkout 里运行。`,
    };
  }

  // Case A — the host's own backup holds the whole file as it was before this step.
  if (typeof s.beforeImage === 'string' && s.beforeImage !== '') {
    if (s.beforeImage === afterWhole) {
      return { ok: false, step: stepIndex, code: 'EMPTY_DIFF', reason: `步骤 ${stepIndex}（${s.name} ${path}）的 before-image 与当前文件完全相同，逆放是空操作，不输出。` };
    }
    return emit(stepIndex, path, relPath, s.beforeImage, afterWhole, 'file-history');
  }

  // Case B — only a fragment. Put it back into the file as it stands, then diff whole.
  const oldStr = oldOf(s.rawArgs);
  const newStr = typeof s.newText === 'string' && s.newText !== '' ? s.newText : undefined;
  if (!oldStr || !newStr) {
    return {
      ok: false, step: stepIndex, code: 'NO_BEFORE_IMAGE',
      reason: `步骤 ${stepIndex}（${s.name} ${path}）没有 before-image：日志未内联 old_string，file-history 备份也没关联上。无法安全逆放——宁可不放，也不发出会被 git apply 静默接受的空补丁。`,
    };
  }
  const at = afterWhole.indexOf(newStr);
  if (at < 0) {
    return {
      ok: false, step: stepIndex, code: 'TREE_DIVERGED',
      reason: `步骤 ${stepIndex}（${s.name} ${path}）写入的内容在当前文件里找不到了，工作树已经往前走。逆放会打错地方，拒绝输出。`,
    };
  }
  if (at !== afterWhole.lastIndexOf(newStr)) {
    return {
      ok: false, step: stepIndex, code: 'TREE_DIVERGED',
      reason: `步骤 ${stepIndex}（${s.name} ${path}）写入的内容在当前文件里出现多次，无法确定逆放哪一处，拒绝输出。`,
    };
  }
  return emit(stepIndex, path, relPath, afterWhole.slice(0, at) + oldStr + afterWhole.slice(at + newStr.length), afterWhole, 'log');
}

function defaultRead(absPath: string): string | undefined {
  try {
    return existsSync(absPath) ? readFileSync(absPath, 'utf8') : undefined;
  } catch {
    return undefined;
  }
}

function emit(
  step: number, path: string, relPath: string, beforeWhole: string, afterWhole: string,
  source: 'log' | 'file-history',
): RevertResult {
  const patch = unifiedPatch(beforeWhole, afterWhole, relPath);
  const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
  const removed = patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length;
  if (added === 0 && removed === 0) {
    return { ok: false, step, code: 'EMPTY_DIFF', reason: `步骤 ${step}（${path}）的 before 与 after 完全相同，补丁是空操作，不输出。` };
  }
  return { ok: true, step, path, patch, added, removed, source };
}
