import type { ReplayStep } from './types.js';

/**
 * Thinning policy, frozen at G3 (contract §4 red line 3) and re-frozen by G4-1 REWORK-4.
 * Contract, not taste:
 *   a. per-step text is capped before embedding
 *   b. when the step count exceeds budget we stride-sample, but these four NEVER drop:
 *      tool_call / compaction / note(level>=warn) / parse-error rows
 *   b2. protected rows alone can exceed the budget (3,711 protected vs the 3,000
 *      default on this machine's 110MB Codex session). G4-3 added a prose reserve so
 *      the conversation is never thinned to *zero* by arithmetic — see PROSE_SHARE.
 *   c. the report carries a visible declaration of what was thinned, per kind
 *   d. if it still does not fit, the caller errors out instead of shipping a half report
 */
export const NEVER_DROP = new Set<ReplayStep['kind']>(['tool_call', 'compaction']);

/**
 * Fraction of the budget held back for non-protected steps (prose) when the protected
 * rows alone would consume the whole budget. Measured on this machine's 110 MB Codex
 * session: 3,689 tool calls + 22 compactions = 3,711 protected vs a 3,000 default, so
 * the old `max(0, max - protected)` budget floored at 0 and dropped 11,189 of 14,905
 * steps, while the banner only said "kept all tool calls" — so the report looked
 * complete and was not. What the reserve actually buys on that session (measured):
 * 300 more steps — user 3, assistant 48, reasoning 0 (the Codex adapter emits no
 * reasoning rows), turn_start 8, usage 140, tool_output 99. The two largest classes
 * dropped are still `usage` 4,777 and `tool_output` 3,584; the context curve is
 * therefore computed on the *full* step list and projected (see keptIdx), never on
 * the thinned one. A forensic replay that silently loses all the prose is worse than
 * a small report, so the prose keeps a floor.
 */
export const PROSE_SHARE = 0.1;

export function isProtected(s: ReplayStep): boolean {
  if (NEVER_DROP.has(s.kind)) return true;
  if (s.kind === 'note') return s.level === 'warn' || s.level === 'error';
  return false;
}

export interface ThinOptions {
  /** max steps to embed (default 3000) */
  maxSteps?: number;
  /** max chars kept per step payload (default 1200) */
  perStepChars?: number;
}

export interface ThinResult {
  steps: ReplayStep[];
  kept: number;
  total: number;
  truncated: boolean;
  /** how many steps of each kind did NOT survive, so the banner can name them */
  droppedByKind: Record<string, number>;
  /**
   * Original index of every kept step, in order. Lets the context track be measured on
   * the full session and then projected onto the sampled timeline, so thinned usage
   * rows cannot flatten the context curve.
   */
  keptIdx: number[];
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/** Cap every text-bearing field. Never throws; the `truncated` flags already on steps stay honest. */
export function capStep(s: ReplayStep, n: number): ReplayStep {
  if (s.kind === 'user' || s.kind === 'assistant') return { ...s, text: clip(s.text, n) };
  if (s.kind === 'reasoning') return { ...s, summary: clip(s.summary, n) };
  if (s.kind === 'tool_call') return { ...s, args: clip(String(s.args), n), rawArgs: clip(s.rawArgs, n) };
  if (s.kind === 'tool_output') return { ...s, output: clip(s.output, n) };
  if (s.kind === 'compaction') return { ...s, summary: clip(s.summary, n) };
  if (s.kind === 'note') return { ...s, text: clip(s.text, n) };
  return s;
}

/**
 * Uniform-stride thinning over the non-protected steps. The stride walk keeps order stable,
 * so the timeline stays monotonic and a reader can tell it is a sample, not a reordering.
 */
export function thin(steps: ReplayStep[], opts: ThinOptions = {}): ThinResult {
  const maxSteps = opts.maxSteps ?? 3000;
  const perStepChars = opts.perStepChars ?? 1200;
  const total = steps.length;
  if (total <= maxSteps) {
    return {
      steps: steps.map((s) => capStep(s, perStepChars)),
      kept: total,
      total,
      truncated: false,
      droppedByKind: {},
      keptIdx: steps.map((_, i) => i),
    };
  }

  const protectedIdx = new Set<number>();
  steps.forEach((s, i) => {
    if (isProtected(s)) protectedIdx.add(i);
  });

  // Protected rows are a floor, not a ceiling — they may already exceed maxSteps. Either
  // way, hold back a slice for the prose so it is sampled, not annihilated.
  const proseReserve = Math.max(1, Math.floor(maxSteps * PROSE_SHARE));
  const budget = protectedIdx.size >= maxSteps ? proseReserve : Math.max(0, maxSteps - protectedIdx.size);
  const free = steps.map((_, i) => i).filter((i) => !protectedIdx.has(i));
  const keepFree = new Set<number>();
  if (budget > 0 && free.length > 0) {
    const stride = free.length / budget;
    for (let k = 0; k < budget; k++) keepFree.add(free[Math.floor(k * stride)]);
  }

  const out: ReplayStep[] = [];
  steps.forEach((s, i) => {
    if (protectedIdx.has(i) || keepFree.has(i)) out.push(capStep(s, perStepChars));
  });
  const droppedByKind: Record<string, number> = {};
  const keptIdxSet = new Set<number>();
  steps.forEach((s, i) => { if (protectedIdx.has(i) || keepFree.has(i)) keptIdxSet.add(i); });
  steps.forEach((s, i) => {
    if (keptIdxSet.has(i)) return;
    droppedByKind[s.kind] = (droppedByKind[s.kind] ?? 0) + 1;
  });
  const keptIdx = steps.map((_, i) => i).filter((i) => keptIdxSet.has(i));
  return { steps: out, kept: out.length, total, truncated: true, droppedByKind, keptIdx };
}

/**
 * The exact banner text the contract requires. Kept here so tests can assert the real
 * string. It names the dropped kinds, not just the count: "dropped 11,189 steps" reads
 * like a rounding artifact, "dropped 11,189 · reasoning 10,203 · assistant 800" tells a
 * reviewer that the part they most wanted to read is the part that is gone.
 */
export function thinBanner(kept: number, total: number, droppedByKind: Record<string, number> = {}): string {
  const entries = Object.entries(droppedByKind).sort((a, b) => b[1] - a[1]);
  const shown = entries.slice(0, 3).map(([k, n]) => `${k} ${n.toLocaleString('en-US')}`);
  if (entries.length > 3) shown.push(`另 ${entries.length - 3} 类`);
  const dropped = total - kept;
  const detail = shown.length ? `（丢弃 ${dropped.toLocaleString('en-US')} 步 · ${shown.join(' · ')}）` : '';
  return `已抽稀：展示 ${kept.toLocaleString('en-US')} / 共 ${total.toLocaleString('en-US')} 步${detail}，保留全部工具调用与压缩事件。加大 --max-steps 可保留更多对话文本。`;
}
