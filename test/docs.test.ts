import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for a real bug found on 2026-09-27, hours before the first
// publish: docs/RELEASE.md told the reader to smoke-test the published package
// with `npx -y midflight@0.1.0` and to verify `npm view midflight version`.
// The package is `midflight-replay`; the *binary* it installs is `midflight`.
// `midflight` is free on npm, so that command would have installed whatever a
// stranger had squatted onto it — the "24 hours after, npx fails" triage in the
// same file would then have blamed the wrong cause.
//
// The mistake is invisible in review because both names look right in context.
// So it is asserted here, from the manifest outward, instead of trusted to prose.

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PKG = (JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')) as { name: string }).name;

/** npx targets that are tools, not this project's package. */
const TOOL_ALLOWLIST = ['vitest', 'playwright', 'tsx', 'tsc', '-y'];

/**
 * Packages this project *probes*, never installs. docs/COMPETITIVE.md exists to
 * read their metadata; naming them there is the job, not a confusion bug.
 */
const COMPETITOR_ALLOWLIST = ['agent-replay', 'flightrec'];

/**
 * Horizontal whitespace only. `\s` also matches a newline, so `npm install\nnpm
 * run build` silently matched `npm install npm` -- a false positive that would
 * train reviewers to ignore this test.
 */
const GAP = '[^\\S\\r\\n]+';

function docs(): string[] {
  const out: string[] = [];
  for (const f of ['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
    out.push(join(REPO, f));
  }
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push(p);
    }
  };
  walk(join(REPO, 'docs'));
  return out;
}

describe('docs: the package name is never confused with the binary name', () => {
  it('manifest states the pair the docs depend on', () => {
    expect(PKG).toBe('midflight-replay');
  });

  it('every npx target is this package or an allowlisted tool', () => {
    const wrong: string[] = [];
    for (const file of docs()) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/\bnpx\s+(--?[\w-]+\s+)*([@a-z0-9][\w./@-]*)/g)) {
        const target = m[2];
        if (TOOL_ALLOWLIST.includes(target)) continue;
        if (target === PKG || target.startsWith(`${PKG}@`)) continue;
        wrong.push(`${file.replace(REPO + '/', '')}: npx ${target}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('every npm view/install/publish target is this package', () => {
    const wrong: string[] = [];
    for (const file of docs()) {
      const text = readFileSync(file, 'utf8');
      const re = new RegExp(String.raw`\bnpm${GAP}(view|install|i|add)${GAP}([@a-z0-9][\w./@-]*)`, 'g');
      for (const m of text.matchAll(re)) {
        if (m[2] === PKG || COMPETITOR_ALLOWLIST.includes(m[2])) continue;
        wrong.push(`${file.replace(REPO + '/', '')}: npm ${m[1]} ${m[2]}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('the publish runbook says the package is midflight-replay, not the binary', () => {
    const release = readFileSync(join(REPO, 'docs/RELEASE.md'), 'utf8');
    // The post-publish smoke test is the line a stranger actually pastes.
    expect(release).toContain(`npx -y ${PKG}@0.1.0`);
    expect(release).toContain(`npm view ${PKG} version`);
  });
});
