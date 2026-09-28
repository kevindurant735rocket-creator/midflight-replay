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
    // A real session store: Cursor writes chats under ~/.cursor/chats/<hash>/<id>.json
    mkdirSync(join(h, '.cursor/chats/abc123'), { recursive: true });
    writeFileSync(join(h, '.cursor/chats/abc123/session-1.json'), '{"messages":[]}');
    const r = await scanAgents({ homeDir: h });
    const cursor = r.find((x) => x.id === 'cursor')!;
    expect(cursor.status).toBe('unsupported');
    expect(cursor.adapter).toBeNull();
    expect(cursor.files).toBe(1);
    const t = formatAgentTable(r);
    expect(t).toMatch(/Cursor/);
    expect(t).toMatch(/no adapter/);
  });

  // Regression: `midflight install` writes its own rule file into ~/.cursor/rules and
  // ~/.codeium/windsurf/rules. Counting those made the table claim "2 session files found"
  // on a machine where Cursor had never stored a single chat. Measured on this machine
  // before the fix: Cursor 2 files / Windsurf 1 file, all three being our own artifacts.
  it('does not count installed rules or skills as session records', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor/rules/midflight-replay'), { recursive: true });
    writeFileSync(join(h, '.cursor/rules/midflight-replay/midflight-replay.mdc'), 'rule');
    mkdirSync(join(h, '.cursor/skills/browser-use'), { recursive: true });
    writeFileSync(join(h, '.cursor/skills/browser-use/SKILL.md'), 'skill');
    mkdirSync(join(h, '.codeium/windsurf/rules/midflight-replay'), { recursive: true });
    writeFileSync(join(h, '.codeium/windsurf/rules/midflight-replay/midflight-replay.md'), 'rule');
    const r = await scanAgents({ homeDir: h });
    for (const id of ['cursor', 'windsurf']) {
      const row = r.find((x) => x.id === id)!;
      expect(row.files).toBe(0);
      // installed, but nothing to read — a state of its own, not an adapter gap
      expect(row.status).toBe('empty');
      expect(row.support).not.toMatch(/no adapter/);
    }
  });

  it('reports the real session count once a real chat exists next to the rule files', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor/rules/midflight-replay'), { recursive: true });
    writeFileSync(join(h, '.cursor/rules/midflight-replay/midflight-replay.mdc'), 'rule');
    mkdirSync(join(h, '.cursor/chats/abc123'), { recursive: true });
    writeFileSync(join(h, '.cursor/chats/abc123/session-1.json'), '{"messages":[]}');
    writeFileSync(join(h, '.cursor/chats/abc123/session-2.json'), '{"messages":[]}');
    const cursor = (await scanAgents({ homeDir: h })).find((x) => x.id === 'cursor')!;
    expect(cursor.files).toBe(2);
    expect(cursor.status).toBe('unsupported');
  });

  it('never prints a file count of zero as if it were a finding', async () => {
    const h = home();
    mkdirSync(join(h, '.cursor'), { recursive: true });
    const t = formatAgentTable(await scanAgents({ homeDir: h }));
    expect(t).not.toMatch(/0 file\(s\) found/);
    expect(t).toMatch(/no records/);
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
