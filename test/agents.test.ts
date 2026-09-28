import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scanAgents, formatAgentTable, AGENTS } from '../src/agents.js';
import { installSkill, buildSkill, presentTargets, TARGETS, SKILL_NAME } from '../src/install.js';

const home = (): string => mkdtempSync(join(tmpdir(), 'midflight-agents-'));

describe('scanAgents measures instead of guessing', () => {
  it('reports a store as supported only when the files are really there', async () => {
    const h = home();
    mkdirSync(join(h, '.codex/sessions/2026/09/28'), { recursive: true });
    writeFileSync(join(h, '.codex/sessions/2026/09/28/rollout-a.jsonl'), '{"a":1}\n');
    writeFileSync(join(h, '.codex/sessions/2026/09/28/rollout-b.jsonl'), '{"b":2}\n');
    // a non-rollout file in the same tree must not be counted
    writeFileSync(join(h, '.codex/sessions/2026/09/28/notes.txt'), 'x');
    const r = await scanAgents({ homeDir: h });
    const codex = r.find((x) => x.id === 'codex')!;
    expect(codex.status).toBe('supported');
    expect(codex.files).toBe(2);
    expect(codex.bytes).toBe(16); // two 8-byte records
    expect(r.find((x) => x.id === 'claude-code')!.status).toBe('absent');
  });

  // The honesty rule from KNOWN-GAPS.md: an agent whose store exists but has no adapter
  // is reported with a real count, never dropped from the table.
  it('surfaces an installed agent with no adapter instead of hiding it', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'), { recursive: true });
    writeFileSync(join(h, '.cursor/state.json'), '{"v":1}');
    const r = await scanAgents({ homeDir: h });
    const cursor = r.find((x) => x.id === 'cursor')!;
    expect(cursor.status).toBe('unsupported');
    expect(cursor.adapter).toBeNull();
    expect(cursor.files).toBe(1);
    const t = formatAgentTable(r);
    expect(t).toMatch(/Cursor/);
    expect(t).toMatch(/no adapter/);
  });

  it('every registry row declares an adapter or says why not', () => {
    for (const a of AGENTS) {
      expect(typeof a.support).toBe('string');
      expect(a.support.length).toBeGreaterThan(10);
      if (a.adapter === null) expect(a.support).toMatch(/no adapter/);
      else expect(['codex', 'claude-code']).toContain(a.adapter);
    }
  });

  it('probes the newest log through the parser when asked', async () => {
    const h = home();
    mkdirSync(join(h, '.codex/sessions/2026/09/28'), { recursive: true });
    const p = join(h, '.codex/sessions/2026/09/28/rollout-a.jsonl');
    writeFileSync(p, '{"a":1}\n');
    let called = 0;
    const r = await scanAgents({
      homeDir: h,
      probe: true,
      parse: async () => {
        called++;
        return { steps: 7, parseErrors: 0, agent: 'codex' };
      },
    });
    expect(called).toBe(1);
    expect(r.find((x) => x.id === 'codex')!.support).toMatch(/7 steps, 0 parse errors/);
  });
});

describe('install writes one file, and only that file', () => {
  it('writes the skill and is idempotent', () => {
    const h = home();
    const t = TARGETS.find((x) => x.id === 'codex')!;
    const a = installSkill(t, { homeDir: h, version: '0.1.0' });
    expect(a.written).toBe(true);
    expect(existsSync(a.path)).toBe(true);
    const b = installSkill(t, { homeDir: h, version: '0.1.0' });
    expect(b.written).toBe(false);
    // same unit on both paths: UTF-8 octets, not UTF-16 code units
    expect(b.bytes).toBe(a.bytes);
    expect(b.bytes).toBe(Buffer.byteLength(readFileSync(a.path, 'utf8'), 'utf8'));
  });

  it('refuses to clobber a different file without --force', () => {
    const h = home();
    const t = TARGETS.find((x) => x.id === 'codex')!;
    const first = installSkill(t, { homeDir: h, version: '0.1.0' });
    writeFileSync(first.path, '# mine, do not delete\n');
    const blocked = installSkill(t, { homeDir: h, version: '0.1.0' });
    expect(blocked.written).toBe(false);
    expect(blocked.conflict).toMatch(/--force/);
    expect(readFileSync(first.path, 'utf8')).toBe('# mine, do not delete\n');
    const forced = installSkill(t, { homeDir: h, version: '0.1.0', force: true });
    expect(forced.written).toBe(true);
    expect(readFileSync(first.path, 'utf8')).toMatch(new RegExp(SKILL_NAME));
  });

  it('frontmatter matches what each host actually loads', () => {
    for (const t of TARGETS) {
      const body = buildSkill(t, '0.1.0');
      if (t.needsFrontmatter === 'name+description') {
        expect(body.startsWith('---\n')).toBe(true);
        expect(body).toMatch(new RegExp(`name: ${SKILL_NAME}`));
        expect(body).toMatch(/description: .+/);
      } else if (t.needsFrontmatter === 'description-only') {
        expect(body).toMatch(/^---\ndescription: .+\n/);
        expect(body).not.toMatch(/^name: /m);
      } else {
        expect(body.startsWith('# midflight')).toBe(true);
      }
    }
  });

  // The skill is the whole "works inside my agent" claim, so its commands must
  // exist in this build. A skill that teaches a removed flag is worse than none.
  it('only teaches commands this build actually has', () => {
    const usage = readFileSync(new URL('../src/cli.ts', import.meta.url), 'utf8');
    for (const t of TARGETS) {
      for (const m of buildSkill(t, '0.1.0').matchAll(/^midflight ([a-z]+)/gm)) {
        expect(usage).toMatch(new RegExp(`case '${m[1]}'`));
      }
    }
  });

  it('targets only hosts whose parent dir exists when no target is named', () => {
    const h = home();
    expect(presentTargets(h)).toEqual([]);
    mkdirSync(join(h, '.codex'), { recursive: true });
    expect(presentTargets(h).map((t) => t.id)).toEqual(['codex']);
  });
});
