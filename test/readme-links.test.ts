import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
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
 * used to keep out of every published tree. Both of these tests exist so that claim cannot come
 * back: one proves the real docs pass, one proves the rule can still fail.
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
    // Both files are untracked for the length of the run, which is the whole point: the link
    // resolves on this disk and 404s in every clone. It does not borrow a real path, so the
    // test keeps meaning the same thing when a real path becomes committed.
    const target = join(repoRoot, 'docs', '_link-probe-target.md');
    const f = join(repoRoot, 'docs', '_link-probe.md');
    writeFileSync(target, '# nobody ships this\n', 'utf8');
    writeFileSync(f, '# probe\n\n[x](./_link-probe-target.md)\n', 'utf8');
    try {
      const r = run([f]);
      expect(r.status).toBe(1);
      expect(`${r.stdout}${r.stderr}`).toMatch(/git does not ship it/);
    } finally {
      rmSync(f, { force: true });
      rmSync(target, { force: true });
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

/**
 * The demo is the whole pitch. A visitor decides in about two seconds, and both READMEs
 * used to open with a wall of prose that pushed the 16-second GIF off the first screen.
 * Nothing in the build would have noticed: the links were fine, the commands were fine, the
 * file was just arranged against itself. This asserts position, not existence, so moving
 * the picture back down fails the run.
 */
describe('demo sits above the fold', () => {
  for (const file of ['README.md', 'README.zh-CN.md']) {
    it(`${file} shows the replay before the first section heading`, () => {
      const text = readFileSync(join(repoRoot, file), 'utf8');
      const demo = text.indexOf('docs/demo/demo.gif');
      const firstHeading = text.search(/^## /m);
      expect(demo).toBeGreaterThan(-1);
      expect(firstHeading).toBeGreaterThan(-1);
      expect(demo).toBeLessThan(firstHeading);
    });
  }
});
