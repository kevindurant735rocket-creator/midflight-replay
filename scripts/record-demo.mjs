/**
 * Records a demo of a real report so the README can show the product moving,
 * not just a still. Re-runnable; overwrites its output directory.
 *
 *   node scripts/record-demo.mjs <report.html> [--out docs/demo] [--seconds 24]
 *
 * Produces <out>/demo.webm plus a poster frame <out>/poster.png.
 * Requires: npx playwright install chromium   (devDependency only — the shipped
 * CLI has zero dependencies, and this script is not part of the package).
 *
 * Honest framing: the scenes are driven by the report's own documented controls
 * (`#play`, the click-to-jump axis, and the keyboard shortcuts the UI advertises).
 * `select(i)` is called directly only to land on a step the cursor could not
 * reach in a 20-second film (a compaction or a diff buried thousands of steps
 * deep); it is the same function the click handlers call.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { mkdir, rm, rename, stat } from 'node:fs/promises';

const argv = process.argv.slice(2);
const file = argv[0];
const opt = (k, d) => { const i = argv.indexOf(k); return i === -1 ? d : argv[i + 1]; };
const outDir = resolve(opt('--out', 'docs/demo'));
const seconds = Number(opt('--seconds', 24));
const W = 1280, H = 800;

if (!file) { console.error('usage: node scripts/record-demo.mjs <report.html> [--out dir] [--seconds n]'); process.exit(2); }
const url = pathToFileURL(resolve(file)).href;

// Playwright writes into <dir> and only renames on close, so record to a scratch
// dir and move the file into place. Deleting with rm is scoped to our own scratch
// path, never a user-supplied one.
const scratch = `${outDir}/.rec`;
await mkdir(scratch, { recursive: true });

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: 1,
  recordVideo: { dir: scratch, size: { width: W, height: H } },
});
const page = await ctx.newPage();
const video = page.video();
await page.goto(url, { waitUntil: 'load' });
await page.waitForSelector('.row', { timeout: 15000 });

const hold = (ms) => page.waitForTimeout(ms);
const step = () => page.evaluate(() => (typeof cur === 'number' ? cur : -1));
const N = await page.evaluate(() => (typeof N === 'number' ? N : 0));
if (N <= 0) { console.error(`no steps in ${file} — nothing to film`); process.exit(3); }

// Which steps are worth filming. Prefer a compaction (the thing no other tool in
// this niche shows) and a file mutation (the diff panel).
const picks = await page.evaluate(() => {
  const kind = (i) => S[i] && S[i].kind;
  const nm = (i) => (S[i] && (S[i].name || '')) || '';
  return {
    compaction: S.findIndex((s) => s.kind === 'compaction'),
    edit: S.findIndex((s) => s.kind === 'tool_call' && /^(Write|Edit|apply_patch)$/.test(s.name || '')),
    tool: S.findIndex((s) => s.kind === 'tool_call'),
    assistant: S.findIndex((s) => s.kind === 'assistant'),
  };
});
const jump = async (i) => { if (i >= 0) { await page.evaluate((k) => select(k), i); } };

await hold(1100); // header badges + coverage bar land

// Scene 1 — press play and let the session actually run.
await page.click('#play');
await hold(Math.min(5200, seconds * 1000 * 0.28));
await page.click('#play'); // pause
await hold(500);

// Scene 2 — a real mouse click on the main axis, 55% across: the click-to-jump
// the axis advertises. (With thousands of steps a single rect is sub-pixel wide,
// so this is what a user's mouse actually does.)
const ax = await page.locator('.axiswrap svg').first().boundingBox();
if (ax) await page.mouse.click(ax.x + ax.width * 0.55, ax.y + ax.height / 2);
await hold(900);
console.log(`axis click at 55% landed on step ${await step()} of ${N}`);

// Scene 3 — a file mutation with a rendered diff.
if (picks.edit >= 0) await jump(picks.edit);
else if (picks.tool >= 0) await jump(picks.tool);
await hold(1400);
await page.screenshot({ path: `${outDir}/poster.png` }); // richest frame = hero image
await hold(500);

// Scene 4 — compaction, if this session has one: the ⇣ evaporate row + badge.
if (picks.compaction >= 0) { await jump(picks.compaction); await hold(1500); }

// Scene 5 — the advertised keyboard shortcuts, so the reviewer sees them work.
await page.keyboard.press('Home');
await hold(700);
await page.keyboard.press('PageDown');
await hold(700);
await page.keyboard.press('PageDown');
await hold(900);
if (picks.assistant >= 0) { await jump(picks.assistant); await hold(1000); }
await hold(300);

const finalStep = await step();
await ctx.close();
await browser.close();

const v = await video.path();
await mkdir(outDir, { recursive: true });
await rename(v, `${outDir}/demo.webm`);
await rm(scratch, { recursive: true, force: true });

const kb = async (p) => ((await stat(p)).size / 1024).toFixed(0);
const mb = async (p) => ((await stat(p)).size / 1048576).toFixed(2);
console.log(`poster  ${outDir}/poster.png  ${await kb(`${outDir}/poster.png`)} KB`);
console.log(`video   ${outDir}/demo.webm   ${await mb(`${outDir}/demo.webm`)} MB  (target ~${seconds}s, ${W}x${H})`);
console.log(`source  ${file}  N=${N}  compaction=${picks.compaction} edit=${picks.edit} assistant=${picks.assistant}  final step=${finalStep}`);
