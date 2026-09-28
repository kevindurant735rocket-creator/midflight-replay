import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

/**
 * The README's "open one" is the only proof a stranger can click without installing
 * anything, and the three files it points at are committed artifacts. Nothing regenerated
 * them: the postmortem panel shipped and the samples kept serving a UI from before it —
 * all three were missing a panel the same page advertises. A test is the only thing that
 * makes "regenerate me" fire on the commit that should have, because nobody remembers.
 *
 * Needs `dist/` (ci-checks builds before it tests); the message says so if it is missing.
 */
describe('the committed sample outputs are what this build produces', () => {
  it('replaying the fixtures reproduces the committed files byte for byte', () => {
    const r = spawnSync('bash', ['scripts/demo-samples.sh'], { encoding: 'utf8' });
    const out = `${r.stdout}${r.stderr}`;
    expect(out, out).toContain('DEMO-SAMPLES-OK');
    expect(r.status).toBe(0);
  });
});
