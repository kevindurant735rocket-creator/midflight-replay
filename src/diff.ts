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
 * @param beforeImage before-text recovered from the host's own backup store (src/filehistory.ts).
 *        Used only when the log itself carried no `old_string`; already redacted.
 * @returns a diff when a before-image is available (inline or recovered), otherwise
 *          `reconstructable:false` and the applied text as plain added lines.
 *          Never invents a `del` line.
 */
export function diffFromArgs(rawArgs: string, beforeImage?: string, newText?: string): DiffResult | null {
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
  // The lifted newText wins when present: it is the same string, already redacted, and it
  // survives the per-step clip that makes rawArgs unparseable.
  const newStr =
    typeof newText === 'string' && newText !== '' ? newText
    : typeof obj?.new_string === 'string' ? obj.new_string
    : typeof obj?.newText === 'string' ? obj.newText
    : typeof obj?.content === 'string' ? obj.content
    : null;

  if (newStr == null) return null;

  // The log's own old_string wins: it is the host's contemporaneous statement of the edit.
  // The recovered backup is the fallback for when the host stopped writing one.
  const before = oldStr ?? (typeof beforeImage === 'string' && beforeImage !== '' ? beforeImage : null);
  if (before != null) {
    const oldS = before;
    const d = lcsDiff(lines(oldS), lines(newStr));
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

/**
 * Render a before/after pair as a git-appliable unified diff, with real context lines.
 *
 * The per-step `old_string` / `new_string` are FRAGMENTS, not whole files, so a hunk built
 * from them alone (`@@ -1,1 @@` / `-old` / `+new`) has no context and no true line number:
 * `git apply` cannot locate it, and `git apply --check` fails even though the edit is real.
 * A revert tool must therefore diff the WHOLE file, not the fragment. Callers supply the
 * whole before-state (from the host's backup) and the whole after-state (the file as it
 * stands now), and this renders them the way git expects. See src/revert.ts.
 */
export function unifiedPatch(beforeText: string, afterText: string, relPath: string, contextLines = 3): string {
  const d = lcsDiff(lines(beforeText), lines(afterText));
  const out: string[] = [`--- a/${relPath}`, `+++ b/${relPath}`];
  // Mark which diff lines fall inside a hunk: a change plus up to `contextLines` of context
  // on each side, splitting when two change-runs are farther apart than 2*contextLines.
  const keep = new Array<boolean>(d.length).fill(false);
  const changed = (i: number) => d[i].kind !== 'ctx';
  for (let i = 0; i < d.length; i++) {
    if (!changed(i)) continue;
    const from = Math.max(0, i - contextLines);
    const to = Math.min(d.length - 1, i + contextLines);
    for (let j = from; j <= to; j++) keep[j] = true;
  }
  let i = 0;
  while (i < d.length) {
    if (!keep[i]) { i++; continue; }
    // collect one hunk
    let end = i;
    while (end + 1 < d.length && keep[end + 1]) end++;
    // compute -/+ ranges
    let aStart = -1, bStart = -1, aCount = 0, bCount = 0;
    for (let j = i; j <= end; j++) {
      const L = d[j];
      if (L.kind !== 'add') { if (aStart < 0) aStart = L.a!; aCount++; }
      if (L.kind !== 'del') { if (bStart < 0) bStart = L.b!; bCount++; }
    }
    out.push(`@@ -${aStart},${aCount} +${bStart},${bCount} @@`);
    for (let j = i; j <= end; j++) {
      const L = d[j];
      out.push((L.kind === 'add' ? '+' : L.kind === 'del' ? '-' : ' ') + L.text);
    }
    i = end + 1;
  }
  return out.join('\n') + '\n';
}
