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
  /** 0-based index into the array that was analysed, so a UI can jump straight there.
   *  It is relative to the steps PASSED IN, not to the file: the HTML report thins a
   *  session before it analyses anything, so its findings index the displayed steps. */
  firstStep: number;
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

/**
 * What the reader needs to see in the finding list itself: WHICH call repeated.
 * A real session looped 13 different commands, and a panel that printed
 * "同一个调用连续跑了 3 次" thirteen times told the reader nothing they could
 * act on — the only copy of the command sat in a tooltip. So the headline
 * carries a short label: the tool name plus the single most identifying
 * argument, squeezed onto one line and clipped.
 */
function callLabel(step: ReplayStep): string {
  if (step.kind !== 'tool_call') return '';
  // Codex hands `args` over as the raw JSON *text*; Claude Code hands over an
  // object. Reading only the object form is how every codex loop came out
  // labelled `exec_command「{"cmd":"…"}」` — a reader has to parse JSON to learn
  // which command repeated, which is the one job this label exists to avoid.
  let a: Record<string, unknown> | null = null;
  if (step.args && typeof step.args === 'object') {
    a = step.args as Record<string, unknown>;
  } else if (typeof step.args === 'string') {
    try {
      const parsed = JSON.parse(step.args);
      if (parsed && typeof parsed === 'object') a = parsed as Record<string, unknown>;
    } catch {
      a = null;
    }
  }
  const keys = ['cmd', 'command', 'file_path', 'filePath', 'path', 'notebook_path', 'pattern', 'query', 'url'];
  let detail = '';
  if (a) {
    for (const k of keys) {
      const v = a[k];
      if (typeof v === 'string' && v.trim()) {
        detail = v;
        break;
      }
    }
  }
  if (detail) return `${step.name}「${cut(detail)}」`;
  // No known key carried the meaning. Dumping `{"session_id":49146.0}` is worse
  // than useless: the reader has to parse JSON to learn one number, and JSON's
  // `49146.0` looks like a defect in this tool rather than in the log. Name the
  // few short scalar fields instead, and print whole numbers as whole numbers.
  const short = a ? Object.entries(a).filter(([, v]) => scalarish(v)).slice(0, 3) : [];
  if (short.length > 0) {
    return `${step.name}「${short.map(([k, v]) => `${k}=${scalar(v)}`).join(' ')}」`;
  }
  return step.name;
}

function scalarish(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function scalar(v: unknown): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  if (typeof v === 'string') return cut(v);
  return String(v);
}

/** One line, no runs of whitespace, no giant blobs. */
function cut(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 48 ? `${flat.slice(0, 48)}…` : flat;
}

/** "893、897、901" — the steps that repeated, five at a time then an ellipsis. */
function listSteps(idx: number[]): string {
  const nums = idx.map((i) => i + 1);
  return nums.length <= 5 ? nums.join('、') : `${nums.slice(0, 5).join('、')}…（共 ${nums.length} 次）`;
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

  let run: { fp: string; idx: number[]; first: ReplayStep & { kind: 'tool_call' } } | null = null;
  const flush = (): void => {
    if (run && run.idx.length >= LOOP_RUN_MIN) {
      const [head, ...rest] = run.idx;
      out.push({
        kind: 'loop',
        severity: 1,
        firstStep: head,
        headline: `${callLabel(run.first)} 连续跑了 ${run.idx.length} 次，参数完全相同`,
        evidence: [
          // "第 893-901 步" implied nine calls next to "连续 3 次" — the range
          // counts every step, the run counts only tool calls. Name the steps
          // that actually repeated, so the two numbers cannot disagree, and keep
          // quoting the arguments here: this line is the proof, the headline is
          // the signpost.
          `第 ${listSteps(run.idx)} 步的参数都是同一个：${run.fp.length > 120 ? `${run.fp.slice(0, 120)}…` : run.fp}`,
          `连续 ${run.idx.length} 次调用，从第一次到最后一次参数一个字都没改`,
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
      run = { fp, idx: [i], first: step };
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
      firstStep: idx[0],
      headline: `${path} 被改了 ${idx.length} 次`,
      evidence: [
        `第 ${idx[0] + 1}-${idx[idx.length - 1] + 1} 步，按步数算占整个会话的 ${pct(idx.length / steps.length)}`,
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
  let peakStep = -1;
  let over = 0;
  let unreconciled = 0;
  usage.forEach((u, ui) => {
    const win = u.contextWindow ?? 0;
    if (!win) return;
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
      peakStep = steps.indexOf(u);
    }
    if (f >= NEAR_FULL_FRACTION) over += 1;
    if (u.input > win) unreconciled += 1;
  });
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
    ? `上下文占用触及 ${peakTokens.toLocaleString('en-US')} token，而窗口只有 ${peakWindow.toLocaleString('en-US')} token`
    : `上下文用到窗口的 ${pct(peak)}（${peakTokens.toLocaleString('en-US')} / ${peakWindow.toLocaleString('en-US')} token）`;
  const evidence = [
    overWindow
      ? `宿主上报的输入量超过它自己上报的窗口；这个比例只能当下限看，不能当测量值`
      : `峰值为窗口的 ${pct(peak)}`,
  ];
  if (over > 0) {
    evidence.push(`${usage.length} 条用量记录里有 ${over} 条达到 ${pct(NEAR_FULL_FRACTION)} 以上`);
  }
  if (unreconciled > 0) {
    evidence.push(`${unreconciled} 条记录的输入 token 超过了上报的窗口`);
  }
  if (compactions > 0) evidence.push(`${compactions} 次第一手压缩事件`);
  return [
    {
      kind: 'near-full-context',
      severity: 3,
      firstStep: peakStep < 0 ? 0 : peakStep,
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
  lines.push(`共 ${findings.length} 项发现。全部按日志里实际记录的步数统计。`);
  return `${lines.join('\n')}\n`;
}
