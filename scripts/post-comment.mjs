#!/usr/bin/env node
// Post or update ONE sticky audit comment on a pull request.
//
// Sticky means: a second run edits the first comment instead of stacking a new
// one, so a 40-commit PR does not end up with 40 identical digests. The marker
// HTML comment below is the only thing we match on; keep it stable forever.
import { readFileSync } from 'node:fs';

const MARKER = '<!-- midflight-replay -->';
const [server, repo, pr, file] = process.argv.slice(2);

if (!server || !repo || !pr || !file) {
  console.error('usage: post-comment.mjs <server> <repo> <pr-number> <file>');
  process.exit(2);
}
const token = process.env.GH_TOKEN;
if (!token) {
  console.error('GH_TOKEN is not set; cannot comment.');
  process.exit(2);
}

const body = readFileSync(file, 'utf8');
const marked = body.includes(MARKER) ? body : `${MARKER}\n${body}`;
const api = `${server}/api/v3/repos/${repo}/issues/${pr}/comments`;
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'midflight-replay-action',
};

const list = await fetch(`${api}?per_page=100`, { headers });
if (!list.ok) {
  console.error(`list comments failed: ${list.status} ${await list.text()}`);
  process.exit(1);
}
const existing = (await list.json()).find((c) => (c.body ?? '').includes(MARKER));

if (existing) {
  const res = await fetch(`${api}/${existing.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ body: marked }),
  });
  if (!res.ok) {
    console.error(`update failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  console.log(`updated comment ${existing.id}`);
} else {
  const res = await fetch(api, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ body: marked }),
  });
  if (!res.ok) {
    console.error(`create failed: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  const made = await res.json();
  console.log(`created comment ${made.id}`);
}
