#!/usr/bin/env node
// `tsc` writes a plain 0644 file and nothing downstream adds the bit back, so a fresh
// `npm ci && npm run build` produced a `dist/cli.js` that could not be executed. Nothing on
// this machine caught it, because the local build had been chmod'ed by hand at some point and
// carried the bit from then on: the README command check died with EACCES on the first CI run
// against a clean clone. The mode is part of what `bin` promises, so the build sets it.
import { chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const rel of ['dist/cli.js']) {
  chmodSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 0o755);
}
