import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for a real bug: the Action advertised `session:
// logs/last-run.jsonl`, but the digest step runs from $GITHUB_ACTION_PATH, so
// the relative path resolved against the action's own checkout and the run
// died with `not a file: logs/last-run.jsonl`. The repo's own self-replay
// workflow shipped that exact shape, so publishing the repo would have turned
// the badge red on day one.
//
// No js-yaml dependency on purpose: the step body is sliced out of the raw
// YAML by indentation, then executed, so the test exercises the shipped bash
// rather than a copy of it.
const ACTION = resolve(fileURLToPath(new URL('../action.yml', import.meta.url)));
const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const yaml = readFileSync(ACTION, 'utf8');

function stepBody(name: string): string {
  const start = yaml.indexOf(`- name: ${name}`);
  expect(start, `step "${name}" not found in action.yml`).toBeGreaterThan(-1);
  const rest = yaml.slice(start);
  const runAt = rest.indexOf('\n      run: |\n');
  expect(runAt, `step "${name}" has no run body`).toBeGreaterThan(-1);
  const body = rest.slice(runAt + '\n      run: |\n'.length);
  const lines: string[] = [];
  for (const line of body.split('\n')) {
    if (line.trim() === '') { lines.push(''); continue; }
    if (!line.startsWith('        ')) break;
    lines.push(line.slice(8));
  }
  return lines.join('\n');
}

let workspace = '';
let out = '';

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'mf-action-'));
  mkdirSync(join(workspace, 'logs'), { recursive: true });
  copyFileSync(join(REPO, 'fixtures/codex-mini.jsonl'), join(workspace, 'logs/last-run.jsonl'));
  // Stand in for $GITHUB_ACTION_PATH: a directory that is NOT the caller's
  // workspace, which is exactly how the bug presented itself.
  mkdirSync(join(workspace, '.action'), { recursive: true });
  cpSync(join(REPO, 'action.yml'), join(workspace, '.action/action.yml'));
  out = join(workspace, 'github_output');
  writeFileSync(out, '');
  execFileSync('bash', ['-c', stepBody('Resolve the session log')], {
    cwd: workspace,
    env: {
      ...process.env,
      SESSION: 'logs/last-run.jsonl',
      DIR: '.agent-sessions',
      GITHUB_OUTPUT: out,
    },
    stdio: 'pipe',
  });
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function outputs(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const line of readFileSync(out, 'utf8').split('\n')) {
    const eq = line.indexOf('=');
    if (eq > 0) map[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return map;
}

describe("the Action's session-path resolution", () => {
  it('hands the digest step an absolute path even for a relative session', () => {
    const o = outputs();
    expect(o.path, 'resolve step must emit `path`').toBeTruthy();
    expect(o.path.startsWith('/'), `path must be absolute, got ${o.path}`).toBe(true);
  });

  it('keeps the caller spelling in `label` so runner paths never leak into the PR', () => {
    expect(outputs().label).toBe('logs/last-run.jsonl');
  });

  it('replays that path from a different cwd (the $GITHUB_ACTION_PATH case)', () => {
    const p = outputs().path;
    const html = execFileSync(
      process.execPath,
      [join(REPO, 'dist/cli.js'), 'replay', p, '--paste', '--max-steps', '3000'],
      { cwd: join(workspace, '.action'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
    );
    expect(html.length).toBeGreaterThan(0);
    expect(html.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('resolves the default `session: auto` from a `.agent-sessions/` dir', () => {
    const sessions = join(workspace, '.agent-sessions');
    mkdirSync(sessions, { recursive: true });
    copyFileSync(join(REPO, 'fixtures/claude-mini.jsonl'), join(sessions, 'a.jsonl'));
    // newer mtime wins: `ls -1t | head -1` must pick b.jsonl
    const newer = join(sessions, 'b.jsonl');
    copyFileSync(join(REPO, 'fixtures/codex-mini.jsonl'), newer);
    const out2 = join(workspace, 'github_output2');
    writeFileSync(out2, '');
    execFileSync('bash', ['-c', stepBody('Resolve the session log')], {
      cwd: workspace,
      env: { ...process.env, SESSION: 'auto', DIR: '.agent-sessions', GITHUB_OUTPUT: out2 },
      stdio: 'pipe',
    });
    const o: Record<string, string> = {};
    for (const line of readFileSync(out2, 'utf8').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) o[line.slice(0, eq)] = line.slice(eq + 1);
    }
    expect(o.label).toBe('.agent-sessions/b.jsonl');
    expect(o.path.startsWith('/')).toBe(true);
  });

  it('fails loudly when `session: auto` finds nothing', () => {
    const out3 = join(workspace, 'github_output3');
    writeFileSync(out3, '');
    let code = 0;
    try {
      execFileSync('bash', ['-c', stepBody('Resolve the session log')], {
        cwd: workspace,
        env: { ...process.env, SESSION: 'auto', DIR: 'no-such-dir', GITHUB_OUTPUT: out3 },
        stdio: 'pipe',
      });
    } catch (e) {
      code = (e as { status: number | null }).status ?? -1;
    }
    expect(code).toBe(1);
  });

  it('credits the label, not the runner path, in the comment caption', () => {
    const digest = stepBody('Build the digest');
    expect(digest).toContain('$LABEL');
    expect(digest).not.toMatch(/from \\`\$PATH_OUT\\`/);
  });
});
