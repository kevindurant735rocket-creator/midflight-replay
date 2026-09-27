import type { ReplayStep } from './types.js';

/**
 * Thinning policy, frozen at G3 (contract §4 red line 3) and re-frozen by G4-1 REWORK-4.
 * Contract, not taste:
 *   a. per-step text is capped before embedding
 *   b. when the step count exceeds budget we stride-sample, but these four NEVER drop:
 *      tool_call / compaction / note(level>=warn) / parse-error rows
 *   c. the report carries a visible declaration of what was thinned
 *   d. if it still does not fit, the caller errors out instead of shipping a half report
 */
export const NEVER_DROP = new Set<ReplayStep['kind']>(['tool_call', 'compaction']);

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
    return { steps: steps.map((s) => capStep(s, perStepChars)), kept: total, total, truncated: false };
  }

  const protectedIdx = new Set<number>();
  steps.forEach((s, i) => {
    if (isProtected(s)) protectedIdx.add(i);
  });

  const budget = Math.max(0, maxSteps - protectedIdx.size);
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
  return { steps: out, kept: out.length, total, truncated: true };
}

/** The exact banner text the contract requires. Kept here so tests can assert the real string. */
export function thinBanner(kept: number, total: number): string {
  return `已抽稀：展示 ${kept} / 共 ${total} 步，保留全部工具调用与压缩事件`;
}
