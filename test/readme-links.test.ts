import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: this checkout sits under a Chinese-named directory and
// the percent-encoded form points nowhere.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * A link that resolves on the author's machine and 404s for the reader is worse than a
 * broken link, because nothing reports it. The README spent a release claiming this repo
 * ran an action on its own pull requests, pointing at a workflow file that `.git/info/exclude`
 * kept out of every published tree. Both of these tests exist so that claim cannot come back:
 * one proves the real docs pass, one proves the rule can still fail.
 */
const run = (files: string[]) =>
  spawnSync(process.execPath, ['scripts/link-check.mjs', ...files], { encoding: 'utf8' });

describe('every link a reader can click resolves — in a clone, not just on this disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mf-links-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('the published docs pass', () => {
    const r = run(['README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CHANGELOG.md']);
    expect(`${r.stdout}${r.stderr}`).not.toMatch(/BROKEN|FAILED/);
    expect(r.status).toBe(0);
  });

  it('rejects a file that exists here but git does not ship', () => {
    // The probe has to sit inside the checkout: the point is a path that resolves on this
    // disk and is still absent from every commit. A temp dir one level up cannot express it.
    const f = join(repoRoot, 'docs', '_link-probe.md');
    // .github/workflows/ is in .git/info/exclude: on disk, tracked by nothing.
    writeFileSync(f, '# probe\n\n[x](../.github/workflows/ci.yml)\n', 'utf8');
    try {
      const r = run([f]);
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toMatch(/git does not ship it/);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it('rejects an anchor no heading produces, even inside html above the fold', () => {
    const f = join(dir, 'anchor.md');
    writeFileSync(f, '# real heading\n\n<a href="#nope">jump</a>\n', 'utf8');
    const r = run([f]);
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/BROKEN anchor/);
  });
});
