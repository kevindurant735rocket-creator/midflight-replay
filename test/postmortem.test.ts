import { describe, it, expect } from 'vitest';
import {
  postmortem,
  renderPostmortem,
  LOOP_RUN_MIN,
  REPEAT_EDIT_MIN,
  NEAR_FULL_FRACTION,
} from '../src/postmortem.js';
import type { ReplayStep } from '../src/types.js';

let seq = 0;
function call(name: string, rawArgs: string): ReplayStep {
  return { kind: 'tool_call', ts: seq++, callId: `c${seq}`, name, args: {}, rawArgs } as ReplayStep;
}
function edit(path: string): ReplayStep {
  return {
    kind: 'tool_call',
    ts: seq++,
    callId: `c${seq}`,
    name: 'Edit',
    args: { file_path: path },
    rawArgs: JSON.stringify({ file_path: path }),
  } as ReplayStep;
}
function usage(input: number, cached: number, contextWindow?: number): ReplayStep {
  return { kind: 'usage', ts: seq++, input, cachedInput: cached, output: 1, reasoning: 0, total: input, contextWindow } as ReplayStep;
}
function compaction(): ReplayStep {
  return { kind: 'compaction', ts: seq++, summary: 's' } as ReplayStep;
}

describe('postmortem — loops', () => {
  it('is silent below the run threshold', () => {
    seq = 0;
    const steps = [call('exec', '{"cmd":"ls"}'), call('exec', '{"cmd":"ls"}')];
    expect(postmortem(steps).filter((f) => f.kind === 'loop')).toHaveLength(0);
    expect(steps.length).toBe(LOOP_RUN_MIN - 1);
  });

  it('flags a run at the threshold and quotes the run, not the prose', () => {
    seq = 0;
    const steps: ReplayStep[] = [];
    for (let i = 0; i < 4; i += 1) steps.push(call('exec', '{"cmd":"ps aux | grep x"}'));
    const loops = postmortem(steps).filter((f) => f.kind === 'loop');
    expect(loops).toHaveLength(1);
    expect(loops[0].severity).toBe(1);
    expect(loops[0].headline).toContain('连续跑了 4 次');
    expect(loops[0].evidence.join(' ')).toContain('ps aux | grep x');
    expect(loops[0].evidence.join(' ')).toContain('参数一个字都没改');
  });

  it('a different call in between breaks the run', () => {
    seq = 0;
    const steps = [
      call('exec', '{"cmd":"a"}'),
      call('exec', '{"cmd":"a"}'),
      call('exec', '{"cmd":"a"}'),
      call('read', '{"path":"b"}'),
      call('exec', '{"cmd":"a"}'),
      call('exec', '{"cmd":"a"}'),
      call('exec', '{"cmd":"a"}'),
    ];
    expect(postmortem(steps).filter((f) => f.kind === 'loop')).toHaveLength(2);
  });

  it('ignores assistant prose between calls — a stuck agent still emits text', () => {
    seq = 0;
    const steps: ReplayStep[] = [];
    for (let i = 0; i < LOOP_RUN_MIN; i += 1) {
      if (i === 1) steps.push({ kind: 'assistant', ts: seq++, text: 'still trying' } as ReplayStep);
      steps.push(call('exec', '{"cmd":"same"}'));
    }
    expect(postmortem(steps).filter((f) => f.kind === 'loop')).toHaveLength(1);
  });

  it('two calls with different arguments are not a loop', () => {
    seq = 0;
    const steps = [call('exec', '{"cmd":"a"}'), call('exec', '{"cmd":"b"}'), call('exec', '{"cmd":"c"}')];
    expect(postmortem(steps).filter((f) => f.kind === 'loop')).toHaveLength(0);
  });
});

describe('postmortem — repeated edits', () => {
  it('is silent below the edit threshold', () => {
    seq = 0;
    const steps = [edit('a.ts'), edit('a.ts')];
    expect(postmortem(steps).filter((f) => f.kind === 'repeated-edit')).toHaveLength(0);
    expect(steps.length).toBe(REPEAT_EDIT_MIN - 1);
  });

  it('counts edits to one file and gives the share of the session', () => {
    seq = 0;
    const steps: ReplayStep[] = [];
    for (let i = 0; i < 3; i += 1) steps.push(edit('/repo/src/a.ts'));
    for (let i = 0; i < 3; i += 1) steps.push(edit('/repo/src/b.ts'));
    const f = postmortem(steps).filter((x) => x.kind === 'repeated-edit');
    expect(f).toHaveLength(2);
    expect(f[0].headline).toContain('被改了 3 次');
    expect(f[0].evidence.join(' ')).toContain('占整个会话的');
  });

  it('reads file_event steps as edits, and never counts a delete as churn', () => {
    seq = 0;
    const mk = (op: 'create' | 'modify' | 'delete') =>
      ({ kind: 'file_event', ts: seq++, path: '/repo/x.ts', op, tool: 'Edit' } as ReplayStep);
    const steps = [mk('modify'), mk('modify'), mk('modify'), mk('delete'), mk('delete'), mk('delete')];
    const f = postmortem(steps).filter((x) => x.kind === 'repeated-edit');
    expect(f).toHaveLength(1);
    expect(f[0].headline).toContain('/repo/x.ts');
  });
});

describe('postmortem — context pressure', () => {
  it('is silent when nothing crossed the bar and no compaction happened', () => {
    seq = 0;
    const steps = [usage(1000, 900, 100000)];
    expect(postmortem(steps)).toHaveLength(0);
  });

  it('reports a peak below the window as a percentage with both raw numbers', () => {
    seq = 0;
    const steps = [usage(90000, 88000, 100000)];
    const f = postmortem(steps);
    expect(f).toHaveLength(1);
    expect(f[0].kind).toBe('near-full-context');
    expect(f[0].headline).toContain('90.0%');
    expect(f[0].headline).toContain('窗口');
    expect(f[0].headline).toContain('90,000');
    expect(NEAR_FULL_FRACTION).toBe(0.85);
  });

  it('cached tokens are a cost, not a size — they must not be added to input', () => {
    seq = 0;
    // input 90k of a 100k window is 90%. If cachedInput were added it would be
    // 178% and the finding would look like a lie.
    const f = postmortem([usage(90000, 88000, 100000)]);
    expect(f[0].headline).toContain('90.0%');
    expect(f[0].headline).not.toContain('178');
  });

  it('refuses to print a percentage above 100% as if it were a measurement', () => {
    seq = 0;
    const f = postmortem([usage(322441, 318562, 243200)]);
    expect(f[0].headline).toContain('322,441');
    expect(f[0].headline).toContain('243,200');
    expect(f[0].headline).not.toMatch(/\d+\.\d%/);
    expect(f[0].evidence.join(' ')).toContain('下限');
  });

  it('a compaction alone is enough to report, with its count', () => {
    seq = 0;
    const f = postmortem([usage(100, 0, 100000), compaction()]);
    expect(f).toHaveLength(1);
    expect(f[0].evidence.join(' ')).toContain('1 次第一手压缩事件');
  });

  it('ignores usage records with no window — it cannot compute a ratio', () => {
    seq = 0;
    expect(postmortem([usage(999999, 0, undefined)])).toHaveLength(0);
  });
});

describe('postmortem — output', () => {
  it('says so plainly when there is nothing to report', () => {
    seq = 0;
    const out = renderPostmortem(postmortem([usage(1, 0, 100000)]), 'sess-1');
    expect(out).toContain('postmortem sess-1');
    expect(out).toContain('no loops, no repeated edits, no context pressure');
  });

  it('sorts worst first and ends with the count and the rule behind it', () => {
    seq = 0;
    const steps: ReplayStep[] = [];
    for (let i = 0; i < 3; i += 1) steps.push(call('exec', '{"cmd":"loop"}'));
    for (let i = 0; i < 3; i += 1) steps.push(edit('z.ts'));
    steps.push(usage(95000, 0, 100000));
    const out = renderPostmortem(postmortem(steps), 'sess-2');
    expect(out.indexOf('[loop]')).toBeLessThan(out.indexOf('[repeated-edit]'));
    expect(out.indexOf('[repeated-edit]')).toBeLessThan(out.indexOf('[near-full-context]'));
    // FOUR, not three: the three identical Edits are a loop in their own right,
    // and a file edited the same way three times in a row is genuinely both.
    expect(out).toContain('共 4 项发现');
    expect(out).toContain('全部按日志里实际记录的步数统计');
  });
});

describe('postmortem — where a finding points', () => {
  it('firstStep is the index of the first step of the run, into the array given', () => {
    seq = 0;
    const steps: ReplayStep[] = [
      { kind: 'user', ts: seq++, text: 'go' } as ReplayStep,
      call('exec', '{"cmd":"poll"}'),
      call('exec', '{"cmd":"poll"}'),
      call('exec', '{"cmd":"poll"}'),
    ];
    const loop = postmortem(steps).find((f) => f.kind === 'loop')!;
    // step 0 is prose, so the run starts at index 1 — and 1 is what a UI must jump to.
    expect(loop.firstStep).toBe(1);
  });

  it('every finding carries an index the report can jump to', () => {
    seq = 0;
    const steps: ReplayStep[] = [];
    for (let i = 0; i < 3; i += 1) steps.push(edit('/repo/a.ts'));
    steps.push({ kind: 'assistant', ts: seq++, text: 'x' } as ReplayStep);
    steps.push(usage(95000, 0, 100000));
    for (const f of postmortem(steps)) {
      expect(Number.isInteger(f.firstStep)).toBe(true);
      expect(f.firstStep).toBeGreaterThanOrEqual(0);
      expect(f.firstStep).toBeLessThan(steps.length);
    }
  });
});
