/**
 * Zero-false-positive tests.
 *
 * A forensic report that cries wolf gets deleted, not trusted. Every detector here gets a
 * session that is genuinely clean and gets asserted to stay silent, plus a case that sits
 * just under the bar. The point is not that the thresholds are large — it is that a user
 * whose agent behaved correctly is never told it did not.
 */
import { describe, it, expect } from 'vitest';
import { postmortem, renderPostmortem, LOOP_RUN_MIN, REPEAT_EDIT_MIN, NEAR_FULL_FRACTION } from '../src/postmortem.js';
import type { ReplayStep } from '../src/types.js';

let seq = 0;
function call(name: string, args: Record<string, unknown>): ReplayStep {
  return {
    kind: 'tool_call',
    ts: seq++,
    callId: `c${seq}`,
    name,
    args,
    rawArgs: JSON.stringify(args),
  } as ReplayStep;
}
function edit(path: string): ReplayStep {
  return call('Edit', { file_path: path });
}
function usage(input: number, cached: number, contextWindow?: number): ReplayStep {
  return { kind: 'usage', ts: seq++, input, cachedInput: cached, output: 1, reasoning: 0, total: input, contextWindow } as ReplayStep;
}
function fileEvent(path: string, op: 'create' | 'modify' | 'delete'): ReplayStep {
  return { kind: 'file_event', ts: seq++, path, op, tool: 'apply_patch' } as ReplayStep;
}
function user(text: string): ReplayStep {
  return { kind: 'user', ts: seq++, text } as ReplayStep;
}
function assistant(text: string): ReplayStep {
  return { kind: 'assistant', ts: seq++, text } as ReplayStep;
}

/** A 30-step session of an agent doing ordinary work: varied calls, one edit per file, low context use. */
function healthySession(): ReplayStep[] {
  const s: ReplayStep[] = [user('把登录页的文案改一下，顺便补个测试')];
  s.push(call('Read', { file_path: '/repo/src/login.ts' }));
  s.push(call('Read', { file_path: '/repo/src/login.test.ts' }));
  s.push(edit('/repo/src/login.ts'));
  s.push(assistant('改好了文案，接着补测试。'));
  s.push(fileEvent('/repo/src/login.ts', 'modify'));
  s.push(call('Grep', { pattern: 'login' }));
  s.push(edit('/repo/src/login.test.ts'));
  s.push(call('Bash', { cmd: 'npm test -- login' }));
  s.push(usage(18_000, 12_000, 200_000));
  s.push(call('Read', { file_path: '/repo/src/session.ts' }));
  s.push(edit('/repo/src/session.ts'));
  s.push(call('Bash', { cmd: 'npm test -- session' }));
  s.push(usage(24_000, 15_000, 200_000));
  s.push(call('Read', { file_path: '/repo/src/report.ts' }));
  s.push(edit('/repo/src/report.ts'));
  s.push(assistant('三处都改完了，跑一遍完整测试。'));
  s.push(call('Bash', { cmd: 'npm test' }));
  s.push(call('Bash', { cmd: 'npx tsc --noEmit' }));
  s.push(usage(31_000, 19_000, 200_000));
  s.push(call('Bash', { cmd: 'npm test' }));
  s.push(assistant('全绿。'));
  s.push(usage(29_000, 21_000, 200_000));
  return s;
}

const kinds = (steps: ReplayStep[]): string[] => postmortem(steps).map((f) => f.kind);

describe('postmortem stays silent on a clean session', () => {
  it('finds nothing in a 23-step session of ordinary work', () => {
    const s = healthySession();
    expect(s.length).toBeGreaterThanOrEqual(20);
    expect(postmortem(s)).toEqual([]);
  });

  it('prints the plain "nothing found" line, not an empty report', () => {
    const out = renderPostmortem(postmortem(healthySession()), 'clean-session');
    expect(out).toMatch(/no loops, no repeated edits, no context pressure/);
    // A user must not have to guess whether an empty report means "checked" or "broke"
    expect(out.split('\n').filter((l) => l.trim()).length).toBeGreaterThan(1);
  });

  it('reports zero findings for an empty step list rather than throwing', () => {
    expect(postmortem([])).toEqual([]);
  });
});

describe('loop detector — clean sessions are not loops', () => {
  it('stays silent at one call below the run threshold', () => {
    const s = Array.from({ length: LOOP_RUN_MIN - 1 }, () => call('Bash', { cmd: 'npm test' }));
    expect(kinds([...s, assistant('好了')])).not.toContain('loop');
  });

  it('does not read two identical calls far apart as a run', () => {
    const s = [
      call('Bash', { cmd: 'npm test' }),
      call('Read', { file_path: '/repo/a.ts' }),
      call('Edit', { file_path: '/repo/b.ts' }),
      call('Bash', { cmd: 'npm run build' }),
      call('Bash', { cmd: 'npm test' }),
    ];
    expect(kinds(s)).not.toContain('loop');
  });

  it('does not treat the same tool with different arguments as a run', () => {
    const s = [
      call('Read', { file_path: '/repo/a.ts' }),
      call('Read', { file_path: '/repo/b.ts' }),
      call('Read', { file_path: '/repo/c.ts' }),
      call('Read', { file_path: '/repo/d.ts' }),
    ];
    expect(kinds(s)).not.toContain('loop');
  });

  it('keeps quiet on a session that mixes one repeat with lots of other work', () => {
    const s = [
      call('Bash', { cmd: 'npm test' }),
      call('Bash', { cmd: 'npm test' }),
      call('Read', { file_path: '/repo/a.ts' }),
      call('Bash', { cmd: 'npm test' }),
      call('Edit', { file_path: '/repo/a.ts' }),
      call('Bash', { cmd: 'npm test' }),
      call('Bash', { cmd: 'npm test' }),
    ];
    expect(kinds(s)).not.toContain('loop');
  });
});

describe('repeated-edit detector — reading is not editing', () => {
  it('stays silent at one edit below the threshold', () => {
    const s = Array.from({ length: REPEAT_EDIT_MIN - 1 }, () => edit('/repo/src/a.ts'));
    expect(kinds(s)).not.toContain('repeated-edit');
  });

  it('does not count repeated reads of one file as repeated edits', () => {
    const s = Array.from({ length: 8 }, () => call('Read', { file_path: '/repo/src/hot.ts' }));
    expect(kinds(s)).not.toContain('repeated-edit');
  });

  it('stays silent when edits are spread across many files', () => {
    const s: ReplayStep[] = [];
    for (let i = 0; i < 12; i += 1) s.push(edit(`/repo/src/mod-${i}.ts`));
    expect(kinds(s)).not.toContain('repeated-edit');
  });

  it('does not count a delete as churn on the path it removed', () => {
    const s: ReplayStep[] = [
      fileEvent('/repo/src/old.ts', 'delete'),
      fileEvent('/repo/src/old.ts', 'delete'),
      fileEvent('/repo/src/old.ts', 'delete'),
    ];
    expect(kinds(s)).not.toContain('repeated-edit');
  });

  it('stays silent on a create-then-modify pair for a brand new file', () => {
    const s: ReplayStep[] = [
      fileEvent('/repo/src/new.ts', 'create'),
      fileEvent('/repo/src/new.ts', 'modify'),
    ];
    expect(kinds(s)).not.toContain('repeated-edit');
  });
});

describe('near-full-context detector — a roomy session is not a full one', () => {
  it('stays silent just below the bar with no compaction', () => {
    const win = 200_000;
    const below = Math.floor(win * (NEAR_FULL_FRACTION - 0.01));
    const s = [usage(below, 100_000, win), usage(below - 1000, 101_000, win), usage(below - 2000, 102_000, win)];
    expect(kinds(s)).not.toContain('near-full-context');
  });

  it('stays silent when the host never reported a window', () => {
    const s = [usage(190_000, 0), usage(195_000, 0), usage(199_000, 0)];
    expect(kinds(s)).not.toContain('near-full-context');
  });

  it('does not add the cached prefix to the input when measuring occupancy', () => {
    // 200k input against a 200k window is exactly at the window, cached 900k is a cost line
    const s = [usage(200_000, 900_000, 200_000)];
    expect(kinds(s)).toContain('near-full-context');
    // ...and the reason it fired is occupancy, not an inflated denominator
    const f = postmortem(s)[0];
    expect(f.evidence.join(' ')).not.toMatch(/1,100,000/);
  });

  it('stays silent when usage is heavy but stays under the bar for every record', () => {
    const win = 400_000;
    const s = [usage(120_000, 80_000, win), usage(150_000, 90_000, win), usage(160_000, 95_000, win)];
    expect(kinds(s)).not.toContain('near-full-context');
  });
});

describe('every detector stays silent on the same clean fixture', () => {
  // One fixture, three assertions: a detector that learned to fire on healthy work would
  // break here even if its own threshold test still passed.
  it('loop, repeated-edit and near-full-context are all quiet on healthy work', () => {
    const s = healthySession();
    for (const kind of ['loop', 'repeated-edit', 'near-full-context']) {
      expect(kinds(s), `${kind} fired on a clean session`).not.toContain(kind);
    }
  });

  it('the clean fixture still trips all three once the behaviour is actually there', () => {
    // Guards the guard: if the fixture above were silently broken, these would pass for
    // the wrong reason. So the same builder must trip each detector when fed the real thing.
    const loopTrip = [
      call('Bash', { cmd: 'npm test' }),
      call('Bash', { cmd: 'npm test' }),
      call('Bash', { cmd: 'npm test' }),
    ];
    expect(kinds(loopTrip)).toContain('loop');

    const editTrip = [edit('/repo/a.ts'), edit('/repo/a.ts'), edit('/repo/a.ts')];
    expect(kinds(editTrip)).toContain('repeated-edit');

    const ctxTrip = [usage(195_000, 0, 200_000), usage(196_000, 0, 200_000)];
    expect(kinds(ctxTrip)).toContain('near-full-context');
  });
});
