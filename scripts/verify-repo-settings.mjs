#!/usr/bin/env node
/**
 * AC4 — assert the repository's own "come help me" surface is actually open.
 *
 * A README that asks for stars and a CONTRIBUTING that asks for pull requests are worth
 * nothing if issues and discussions are off: the traffic has nowhere to land. This reads
 * the settings with `gh` and prints one line per setting, then exits non-zero on the first
 * one that is wrong. No `gh`, no auth, or no remote -> it says so and exits 0, because a
 * local clone on a plane is not a broken repository.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const REPO = process.env.MF_REPO ?? 'kevindurant735rocket-creator/midflight-replay';

function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    if (allowFail) return null;
    throw e;
  }
}

if (!existsSync('.git')) {
  console.log('REPO-SETTINGS-SKIP not a git checkout');
  process.exit(0);
}

const auth = gh(['auth', 'status'], { allowFail: true });
if (auth === null) {
  console.log('REPO-SETTINGS-SKIP gh CLI unavailable or unauthenticated');
  process.exit(0);
}

const repo = gh(['repo', 'view', REPO, '--json', 'name,hasIssuesEnabled,hasDiscussionsEnabled,isPrivate,stargazerCount']);
if (repo === null) {
  console.log(`REPO-SETTINGS-SKIP ${REPO} not visible to this token`);
  process.exit(0);
}

const meta = JSON.parse(repo);
let bad = 0;
const need = (label, ok, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}: ${detail}`);
  if (!ok) bad++;
};

console.log(`repo settings ${meta.name} (${meta.stargazerCount}★)`);
need('issues', meta.hasIssuesEnabled === true, `has_issues_enabled=${meta.hasIssuesEnabled}`);
need('discussions', meta.hasDiscussionsEnabled === true, `has_discussions_enabled=${meta.hasDiscussionsEnabled}`);
need('public', meta.isPrivate === false, `private=${meta.isPrivate}`);

for (const tpl of ['bug_report.md', 'host_adapter_request.yml']) {
  const p = `.github/ISSUE_TEMPLATE/${tpl}`;
  need(`template ${tpl}`, existsSync(p), p);
}

if (bad > 0) {
  console.error(`REPO-SETTINGS-FAIL ${bad} setting(s) wrong`);
  process.exit(1);
}
console.log('REPO-SETTINGS-OK');
