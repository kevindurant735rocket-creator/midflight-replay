import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The Action's whole value claim is "40 commits -> ONE comment". That claim was
// made in the README and in action.yml, and it had zero tests: the script could
// only ever be exercised against a real pull request. This spins a mock GitHub
// API so the sticky create/update branch is asserted in CI, offline.
const SCRIPT = resolve(fileURLToPath(new URL('../scripts/post-comment.mjs', import.meta.url)));
const MARKER = '<!-- midflight-replay -->';

type Comment = { id: number; body: string };
let server: Server;
let base = '';
let comments: Comment[] = [];
let nextId = 100;
let calls: string[] = [];
let dir = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const list = url.startsWith('/api/v3/repos/o/r/issues/7/comments');
      if (req.method === 'GET' && list) {
        calls.push('LIST');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(comments));
      } else if (req.method === 'POST' && list) {
        calls.push('CREATE');
        const made = { id: nextId++, body: JSON.parse(raw || '{}').body ?? '' };
        comments.push(made);
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify(made));
      } else if (req.method === 'PATCH' && /comments\/\d+$/.test(url)) {
        calls.push('UPDATE');
        const id = Number(url.split('/').pop());
        const hit = comments.find((c) => c.id === id);
        if (hit) hit.body = JSON.parse(raw || '{}').body ?? '';
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(hit));
      } else {
        res.writeHead(404).end('{}');
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = typeof a === 'object' && a ? `http://127.0.0.1:${a.port}` : '';
  dir = mkdtempSync(join(tmpdir(), 'mf-pc-'));
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => { comments = []; calls = []; nextId = 100; });

const run = (file: string) =>
  new Promise<{ code: number; out: string }>((r) => {
    execFile('node', [SCRIPT, base, 'o/r', '7', file],
      { env: { ...process.env, GH_TOKEN: 't' } },
      (e, stdout) => r({ code: e ? ((e as { code?: number }).code ?? 1) : 0, out: stdout }));
  });

const body = (text: string) => { const f = join(dir, 'c.md'); writeFileSync(f, text); return f; };

describe('AC-A1 the Action leaves exactly one sticky comment', () => {
  it('creates on the first run', async () => {
    const r = await run(body('first digest'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('created comment 100');
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain(MARKER);
  });

  it('updates in place on the second run instead of stacking', async () => {
    await run(body('first digest'));
    const r = await run(body('second digest'));
    expect(r.code).toBe(0);
    expect(r.out).toContain('updated comment 100');
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('second digest');
    expect(comments[0].body).not.toContain('first digest');
    expect(calls).toEqual(['LIST', 'CREATE', 'LIST', 'UPDATE']);
  });

  it('never duplicates the marker after 10 runs', async () => {
    for (let i = 0; i < 10; i++) await run(body(`digest ${i}`));
    expect(comments).toHaveLength(1);
    expect(comments[0].body.split(MARKER)).toHaveLength(2);
  });

  it('ignores a human comment that lacks the marker', async () => {
    comments.push({ id: 7, body: 'LGTM, shipping it' });
    await run(body('digest'));
    expect(comments).toHaveLength(2);
    expect(comments[1].body).toContain('digest');
  });

  it('refuses to run without a token', async () => {
    const code = await new Promise<number>((r) => {
      execFile('node', [SCRIPT, base, 'o/r', '7', body('x')],
        { env: { PATH: process.env.PATH ?? '' } },
        (e) => r(e ? ((e as { code?: number }).code ?? 1) : 0));
    });
    expect(code).toBe(2);
  });
});
