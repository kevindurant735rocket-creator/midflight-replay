/**
 * Postmortem detection — the last thing the roadmap promised: "flag loops,
 * repeated edits, and near-full context".
 *
 * Every detector here is a COUNT over steps the host itself logged. Nothing is
 * inferred from prose, nothing is guessed about intent, and a detector that has
 * no evidence stays silent. That is the same rule the coverage verdict follows:
 * a report that cries wolf is worse than one that says nothing, because the
 * reader has to spend their own attention to check it.
 *
 * Thresholds live here as named constants, not as inline magic numbers, so the
 * tests can assert against the same value the code branches on and so a reader
 * can see the bar without reading the loop.
 */
import type { ReplayStep } from './types.js';

/** a file edited this many times in one session is churn, not work */
export const REPEAT_EDIT_MIN = 3;
/** the same call, byte-identical arguments, this many times in a row is a loop */
export const LOOP_RUN_MIN = 3;
/** context at or above this fraction of the window is where the next turn dies */
export const NEAR_FULL_FRACTION = 0.85;

export type FindingKind = 'loop' | 'repeated-edit' | 'near-full-context';

export interface Finding {
  kind: FindingKind;
  /** what a reader should believe, in one line, with the number in it */
  headline: string;
  /** ordered, quotable evidence — step indexes and the values that triggered it */
  evidence: string[];
  /** worst first. loop > repeated-edit > near-full-context */
  severity: 1 | 2 | 3;
}

const MUTATING = /^(edit|write|multiedit|notebookedit|apply_patch|str_replace|create|update)/i;

/** The path an edit step touched, or null when the step is not an edit. */
function editPath(step: ReplayStep): string | null {
  if (step.kind === 'file_event') return step.op === 'delete' ? null : step.path;
  if (step.kind !== 'tool_call') return null;
  if (!MUTATING.test(step.name)) return null;
  const a = step.args as Record<string, unknown> | null;
  if (!a || typeof a !== 'object') return null;
  for (const k of ['file_path', 'path', 'filePath', 'notebook_path']) {
    const v = a[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** Short, stable label for a repeated call — the args, not the prose around them. */
function callFingerprint(step: ReplayStep): string | null {
  if (step.kind !== 'tool_call') return null;
  const raw = step.rawArgs.length <= 400 ? step.rawArgs : `${step.rawArgs.slice(0, 400)}…`;
  return `${step.name} ${raw}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

/**
 * Loops: the same tool with byte-identical arguments, repeated CONSECUTIVELY
 * among tool calls. Consecutive matters — a helper that legitimately reads the
 * same file in three places in a session is not stuck; a run of the same call
 * with no other call between it is. Ignoring other step kinds keeps a stream of
 * assistant prose from breaking the run, which is what a stuck agent emits.
 */
function findLoops(steps: ReplayStep[]): Finding[] {
  const out: Finding[] = [];
  const calls = steps
    .map((s, i) => ({ step: s, i }))
    .filter((x): x is { step: ReplayStep & { kind: 'tool_call' }; i: number } => x.step.kind === 'tool_call');

  let run: { fp: string; idx: number[] } | null = null;
  const flush = (): void => {
    if (run && run.idx.length >= LOOP_RUN_MIN) {
      const [head, ...rest] = run.idx;
      out.push({
        kind: 'loop',
        severity: 1,
        headline: `the same call ran ${run.idx.length} times in a row with identical arguments`,
        evidence: [
          `steps ${head}-${rest[rest.length - 1]}: ${run.fp.length > 160 ? `${run.fp.slice(0, 160)}…` : run.fp}`,
          `${run.idx.length} consecutive calls, 0 arguments changed between the first and the last`,
        ],
      });
    }
    run = null;
  };
  for (const { step, i } of calls) {
    const fp = callFingerprint(step);
    if (!fp) continue;
    if (run && run.fp === fp) run.idx.push(i);
    else {
      flush();
      run = { fp, idx: [i] };
    }
  }
  flush();
  return out;
}

/**
 * Repeated edits: how many times one file was edited, and how much of the
 * session that accounts for. A file touched 40 times in a 200-step session is
 * the session's centre of gravity whether or not that was a good idea.
 */
function findRepeatedEdits(steps: ReplayStep[]): Finding[] {
  const byPath = new Map<string, number[]>();
  steps.forEach((s, i) => {
    const p = editPath(s);
    if (!p) return;
    const arr = byPath.get(p);
    if (arr) arr.push(i);
    else byPath.set(p, [i]);
  });
  const out: Finding[] = [];
  for (const [path, idx] of [...byPath].sort((a, b) => b[1].length - a[1].length)) {
    if (idx.length < REPEAT_EDIT_MIN) continue;
    out.push({
      kind: 'repeated-edit',
      severity: 2,
      headline: `${path} was edited ${idx.length} times`,
      evidence: [
        `steps ${idx[0]}-${idx[idx.length - 1]}, ${pct(idx.length / steps.length)} of the session by step count`,
      ],
    });
  }
  return out;
}

/**
 * Near-full context: the host reports token usage per turn; the window size is
 * reported alongside it. We count how many usage records sat at or above the
 * bar and report the peak, so the reader sees pressure as a curve, not a vibe.
 */
function findContextPressure(steps: ReplayStep[]): Finding[] {
  const usage = steps.filter(
    (s): s is Extract<ReplayStep, { kind: 'usage' }> => s.kind === 'usage',
  );
  if (usage.length === 0) return [];
  let peak = 0;
  let peakTokens = 0;
  let peakWindow = 0;
  let over = 0;
  let unreconciled = 0;
  for (const u of usage) {
    const win = u.contextWindow ?? 0;
    if (!win) continue;
    // `input` ALREADY CONTAINS the cached prefix on both hosts (Codex reports
    // input_tokens with cached_input_tokens as a subset of it). Adding the two
    // double counts and put a real session at "263.6% of the window", which is
    // the kind of number that makes a reader stop trusting the whole report.
    // Occupancy is therefore input alone; cachedInput is a cost, not a size.
    const f = u.input / win;
    if (f > peak) {
      peak = f;
      peakTokens = u.input;
      peakWindow = win;
    }
    if (f >= NEAR_FULL_FRACTION) over += 1;
    if (u.input > win) unreconciled += 1;
  }
  if (peakWindow === 0) return [];
  const compactions = steps.filter((s) => s.kind === 'compaction').length;
  if (over === 0 && compactions === 0) return [];

  // A host can report an input larger than the window it just told us about —
  // a real Codex session does, 322,441 tokens against a 243,200-token window,
  // 245 records at or above the bar. Printing "132.6% of the window" as if the
  // percentage were a measurement is a lie with a decimal point, so the tokens
  // lead and the ratio is marked as a floor whenever it passes 100%.
  const overWindow = peak >= 1;
  const headline = overWindow
    ? `context hit ${peakTokens.toLocaleString('en-US')} tokens against a ${peakWindow.toLocaleString('en-US')}-token window`
    : `context reached ${pct(peak)} of the window (${peakTokens.toLocaleString('en-US')} of ${peakWindow.toLocaleString('en-US')} tokens)`;
  const evidence = [
    overWindow
      ? `the host reported input ABOVE its own reported window; treat the ratio as a floor, not a measurement`
      : `peak ${pct(peak)} of the window`,
  ];
  if (over > 0) {
    evidence.push(`${over} of ${usage.length} usage records at or above ${pct(NEAR_FULL_FRACTION)}`);
  }
  if (unreconciled > 0) {
    evidence.push(`${unreconciled} records where input tokens exceeded the reported window`);
  }
  if (compactions > 0) evidence.push(`${compactions} first-hand compaction events`);
  return [
    {
      kind: 'near-full-context',
      severity: 3,
      headline,
      evidence,
    },
  ];
}

export function postmortem(steps: ReplayStep[]): Finding[] {
  return [...findLoops(steps), ...findRepeatedEdits(steps), ...findContextPressure(steps)].sort(
    (a, b) => a.severity - b.severity,
  );
}

export function renderPostmortem(findings: Finding[], sessionId: string): string {
  if (findings.length === 0) {
    return `postmortem ${sessionId}\n\nno loops, no repeated edits, no context pressure found in the logged steps.\n`;
  }
  const lines = [`postmortem ${sessionId}`, ''];
  for (const f of findings) {
    lines.push(`[${f.kind}] ${f.headline}`);
    for (const e of f.evidence) lines.push(`  - ${e}`);
    lines.push('');
  }
  lines.push(`${findings.length} finding${findings.length === 1 ? '' : 's'}. Counts over logged steps only.`);
  return `${lines.join('\n')}\n`;
}
