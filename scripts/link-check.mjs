#!/usr/bin/env node
// Every relative link and image in the published READMEs must resolve, and every
// anchor must exist in the target file. A dead image above the fold is the
// cheapest way to lose a visitor, and the easiest thing to rot silently.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Resolving on this machine is not the same as resolving for a reader: a file git does
 * not ship is on this disk and a 404 on github.com. That is not hypothetical — the README
 * promised `.github/workflows/self-replay.yml` for months of local work while the file sat
 * in `.git/info/exclude`, so the one page every visitor reads described a file the
 * repository has never contained. Checked with `git ls-files`, which is the same question
 * a clone asks.
 */
// fileURLToPath, not `new URL(...).pathname`: this checkout lives under a directory whose
// name is Chinese, and the percent-encoded form is a path that does not exist — which
// made every tracked file look unpublished.
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const published = (abs) => {
  try {
    // git wants a path relative to the repo, not the absolute one existsSync just took.
    execFileSync('git', ['ls-files', '--error-unmatch', '--', relative(repoRoot, abs)], { cwd: repoRoot, stdio: 'ignore' });
    return true;
  } catch { return false; }
};

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/link-check.mjs <file.md>...'); process.exit(2); }

const slugs = (md) => {
  const out = new Set();
  for (const m of md.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const s = m[1].toLowerCase()
      .replace(/`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim().replace(/\s+/g, '-');
    if (s) out.add(s);
  }
  return out;
};

/**
 * Text a reader cannot click. A changelog entry that documents the link syntax itself —
 * "the checker only read markdown `[](...)` links" — is prose about links, and scanning it
 * reported a link to a file called `...` that does not exist. Code spans and fenced blocks
 * come out before the scan, the way a Markdown renderer would.
 */
const clickable = (md) =>
  md.replace(/```[\s\S]*?```/g, (b) => b.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));

let bad = 0, checked = 0;

/** Resolve a repo-relative path the way a reader's clone would. Returns null if it is fine. */
const defect = (f, p) => {
  const target = resolve(dirname(f), p);
  if (!existsSync(target)) return `no such file`;
  if (statSync(target).size === 0) return `file is empty`;
  if (!published(target)) return `git does not ship it; readers get a 404`;
  return null;
};
for (const f of files) {
  const md = readFileSync(f, 'utf8');
  const scan = clickable(md);
  for (const m of scan.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = m[1];
    if (/^(https?:|mailto:|#)/.test(href)) {
      if (href.startsWith('#') && !slugs(md).has(href.slice(1))) {
        console.error(`  BROKEN anchor  ${f} -> ${href}`); bad++;
      }
      continue;
    }
    const [p, anchor] = href.split('#');
    const target = resolve(dirname(f), p);
    checked++;
    const d = defect(f, p);
    if (d) {
      console.error(`  BROKEN link    ${f} -> ${href}  (${d})`); bad++; continue;
    }
    if (anchor && p.endsWith('.md')) {
      const t = readFileSync(target, 'utf8');
      if (!slugs(t).has(anchor.toLowerCase())) {
        console.error(`  BROKEN anchor  ${f} -> ${href}`); bad++;
      }
    }
  }
  // Everything above the fold is HTML, not markdown: <a href>, <source srcset> and the
  // in-page anchors inside them were all invisible to the loop above, which is why a dead
  // demo GIF or a `#install` that no heading produces could sit in the first screen.
  for (const m of scan.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) {
    for (const raw of m[1].split(/\s+/).filter(Boolean)) {
      if (/^(https?:|mailto:|data:)/.test(raw)) continue;
      if (raw.startsWith('#')) {
        if (!slugs(md).has(raw.slice(1).toLowerCase())) {
          console.error(`  BROKEN anchor  ${f} -> ${raw}`); bad++;
        }
        continue;
      }
      const [p] = raw.split('#');
      if (!p) continue;
      checked++;
      const d = defect(f, p);
      if (d) { console.error(`  BROKEN link    ${f} -> ${raw}  (${d})`); bad++; }
    }
  }
  for (const m of scan.matchAll(/<img[^>]+src="([^"]+)"/g)) {
    const src = m[1];
    if (/^https?:/.test(src)) continue;
    checked++;
    const t = resolve(dirname(f), src);
    if (!existsSync(t)) { console.error(`  BROKEN image   ${f} -> ${src}`); bad++; }
    else if (statSync(t).size < 1024) { console.error(`  SUSPECT image  ${f} -> ${src} (${statSync(t).size} B)`); bad++; }
  }
  console.log(`  ${f}: ok`);
}
console.log(bad ? `LINK-CHECK-FAILED bad=${bad} of ${checked}` : `LINK-CHECK-OK checked=${checked}`);
process.exit(bad ? 1 : 0);
