/**
 * Minimal unified diff for edit steps (AC-3c).
 *
 * Codex and Claude Code do NOT agree here, and the report must not pretend they do:
 *   - Claude Code logs carry `old_string` / `new_string` per edit tool call, so a real
 *     before/after diff is reconstructable (measured 244 edit calls, 127 with before-image, on a 31 MiB Claude session).
 *   - Codex rollout `function_call.arguments` has no `old_string`, so we can only show the
 *     patch the agent claimed to apply. The coverage bar states this; this module never
 *     fabricates a reverse.
 */

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
  a: number | null;
  b: number | null;
}

export interface DiffResult {
  lines: DiffLine[];
  added: number;
  removed: number;
  /** false when there was nothing to diff against — the report must label this case. */
  reconstructable: boolean;
}

const EDIT_TOOLS = /\b(edit|write|multiedit|notebookedit|apply_patch|str_replace)\b/i;

/** Does this tool call mutate a file? */
export function isEditTool(name: string): boolean {
  return EDIT_TOOLS.test(name);
}

function lines(s: string): string[] {
  return s.split('\n');
}

/** Longest-common-subsequence table, bounded. Real edit hunks are small; big inputs bail to a
 *  whole-block replace rather than allocating an O(n*m) table on a 20k-char blob. */
function lcsDiff(a: string[], b: string[]): DiffLine[] {
  if (a.length * b.length > 400_000) {
    return [
      ...a.map((t, i) => ({ kind: 'del' as const, text: t, a: i + 1, b: null })),
      ...b.map((t, i) => ({ kind: 'add' as const, text: t, a: null, b: i + 1 })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i], a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: 'del', text: a[i], a: i + 1, b: null });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j], a: null, b: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i], a: i + 1, b: null }), i++;
  while (j < m) out.push({ kind: 'add', text: b[j], a: null, b: j + 1 }), j++;
  return out;
}

/**
 * @param rawArgs the (already redacted) tool argument string
 * @returns a diff when the log actually carried a before-image, otherwise `reconstructable:false`
 *          and the applied text as plain added lines. Never invents a `del` line.
 */
export function diffFromArgs(rawArgs: string): DiffResult | null {
  let args: any;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    args = null;
  }
  const obj = args && typeof args === 'object' ? args : null;

  const oldStr =
    typeof obj?.old_string === 'string' ? obj.old_string
    : typeof obj?.oldText === 'string' ? obj.oldText
    : null;
  // `content` is how Claude Code's Write carries the whole new file (measured: 52/52 Write calls
  // on this machine use file_path+content, never old_string). Without it a file-writing step
  // would render no diff at all.
  const newStr =
    typeof obj?.new_string === 'string' ? obj.new_string
    : typeof obj?.newText === 'string' ? obj.newText
    : typeof obj?.content === 'string' ? obj.content
    : null;

  if (newStr == null) return null;

  if (oldStr != null) {
    const d = lcsDiff(lines(oldStr), lines(newStr));
    return {
      lines: d,
      added: d.filter((x) => x.kind === 'add').length,
      removed: d.filter((x) => x.kind === 'del').length,
      reconstructable: true,
    };
  }
  // No before-image in the log: a create, or a host that does not record one.
  return {
    lines: lines(newStr).map((t, i) => ({ kind: 'add' as const, text: t, a: null, b: i + 1 })),
    added: lines(newStr).length,
    removed: 0,
    reconstructable: false,
  };
}
