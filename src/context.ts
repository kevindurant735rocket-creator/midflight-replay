import type { ReplayStep } from './types.js';

/**
 * Context composition, the secondary axis (AC-3b).
 *
 * Honest framing: the host logs do not attribute tokens to sources, so we measure
 * **accumulated content mass in characters**, not exact token attribution, and the report
 * says so. Evaporation is not guessed either — when the host emits a `compaction` event we
 * treat the carried mass as replaced by that summary, and render the discarded part as a
 * ghost band. Measured on a real 109 MiB rollout: 22 compaction events.
 */
export const CATEGORIES = ['conversation', 'reasoning', 'tool_output', 'compaction'] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  conversation: '对话',
  reasoning: '推理',
  tool_output: '工具输出',
  compaction: '压缩摘要',
};

export interface ContextTrack {
  /** cumulative chars per category, one entry per step, aligned to the step array */
  cumulative: number[][];
  /** first step index at which each category contributed anything */
  firstStep: number[];
  /** per-step chars this step added, per category */
  added: number[][];
  /** chars discarded at each compaction step, aligned to steps (0 elsewhere) */
  evaporated: number[];
  /** true when the host emitted at least one real compaction event */
  hasFirstHandCompaction: boolean;
  /** steps where cumulative mass fell without a host compaction event */
  unexplainedDrops: number;
}

export function buildContextTrack(steps: ReplayStep[]): ContextTrack {
  const n = steps.length;
  const carry: number[] = CATEGORIES.map(() => 0);
  const cumulative: number[][] = new Array(n);
  const added: number[][] = new Array(n);
  const firstStep: number[] = CATEGORIES.map(() => -1);
  const evaporated: number[] = new Array(n).fill(0);
  let hasFirstHandCompaction = false;
  let unexplainedDrops = 0;
  let prevTotal = 0;

  for (let i = 0; i < n; i++) {
    const s = steps[i];
    const add: number[] = CATEGORIES.map(() => 0);
    const size = (v: string): number => v.length;

    if (s.kind === 'user' || s.kind === 'assistant') add[0] += size(s.text);
    else if (s.kind === 'reasoning') add[1] += size(s.summary);
    else if (s.kind === 'tool_output') add[2] += size(s.output);
    else if (s.kind === 'compaction') {
      hasFirstHandCompaction = true;
      // The host says: everything carried so far was replaced by this summary.
      const before = carry.reduce((a, b) => a + b, 0);
      const summary = size(s.summary);
      for (let c = 0; c < CATEGORIES.length; c++) carry[c] = 0;
      carry[3] = summary;
      evaporated[i] = Math.max(0, before - summary);
      add[3] = summary;
      if (firstStep[3] < 0) firstStep[3] = i;
    }

    for (let c = 0; c < CATEGORIES.length; c++) {
      if (add[c] > 0 && firstStep[c] < 0) firstStep[c] = i;
      carry[c] += add[c];
    }

    const total = carry.reduce((a, b) => a + b, 0);
    if (i > 0 && total < prevTotal && s.kind !== 'compaction') unexplainedDrops++;
    prevTotal = total;

    cumulative[i] = carry.slice();
    added[i] = add;
  }

  return { cumulative, firstStep, added, evaporated, hasFirstHandCompaction, unexplainedDrops };
}

/**
 * Project a track measured on the full session onto the thinned timeline.
 *
 * Why this exists: thinning (compact.ts) may drop thousands of rows, and on a Codex
 * session the dropped rows are dominated by `usage` and `tool_output` — exactly the
 * rows that carry context mass. Building the curve from the thinned list therefore
 * understates mass by an order of magnitude and flattens the secondary axis into a
 * lie. So the track is measured on every step, then sampled: each displayed step keeps
 * the *true* cumulative mass at its original position. Invariant: projecting with an
 * identity index list must return the input unchanged.
 *
 * `unexplainedDrops` and `hasFirstHandCompaction` are whole-session facts and are
 * carried through as-is rather than resampled.
 */
export function projectContextTrack(track: ContextTrack, keptIdx: number[]): ContextTrack {
  if (keptIdx.length === track.cumulative.length) return track;
  const cumulative = keptIdx.map((i) => track.cumulative[i] ?? [0, 0, 0, 0]);
  const evaporated = keptIdx.map((i) => track.evaporated[i] ?? 0);
  const added = keptIdx.map((i) => track.added[i] ?? [0, 0, 0, 0]);
  // firstStep: original index of the first contributing step, re-expressed as the
  // position of the first *kept* step at or after it (-1 if none survived).
  const firstStep = track.firstStep.map((orig) => {
    if (orig < 0) return -1;
    const at = keptIdx.findIndex((i) => i >= orig);
    return at;
  });
  return {
    cumulative,
    firstStep,
    added,
    evaporated,
    hasFirstHandCompaction: track.hasFirstHandCompaction,
    unexplainedDrops: track.unexplainedDrops,
  };
}
