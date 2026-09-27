#!/usr/bin/env node
// Every relative link and image in the published READMEs must resolve, and every
// anchor must exist in the target file. A dead image above the fold is the
// cheapest way to lose a visitor, and the easiest thing to rot silently.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

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

let bad = 0, checked = 0;
for (const f of files) {
  const md = readFileSync(f, 'utf8');
  for (const m of md.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
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
    if (!existsSync(target)) {
      console.error(`  BROKEN link    ${f} -> ${href}`); bad++; continue;
    }
    if (anchor && p.endsWith('.md')) {
      const t = readFileSync(target, 'utf8');
      if (!slugs(t).has(anchor.toLowerCase())) {
        console.error(`  BROKEN anchor  ${f} -> ${href}`); bad++;
      }
    }
  }
  for (const m of md.matchAll(/<img[^>]+src="([^"]+)"/g)) {
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
