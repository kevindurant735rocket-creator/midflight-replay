/**
 * Browser acceptance for the interactive report (AC-4 / AC-5 / AC-3b).
 * Run: node scripts/browser-check.mjs <report.html> [more.html ...]
 * Verifies: zero network requests, keyboard scrub, axis click-to-jump,
 * context-axis jump, diff rendering, and scrub latency.
 */
import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name} ${extra}`); }
};

const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/browser-check.mjs <report.html>...'); process.exit(2); }

const browser = await chromium.launch();

for (const f of files) {
  console.log(`\n== ${f}`);
  const ctx = await browser.newContext();
  const reqs = [];
  const page = await ctx.newPage();
  page.on('request', (r) => { if (r.resourceType() !== 'document') reqs.push(r.url()); });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  await page.goto(pathToFileURL(resolve(f)).href, { waitUntil: 'load' });
  await page.waitForTimeout(250);

  // ---- AC-4: the file is self-contained; nothing is fetched ----
  ok('zero network requests', reqs.length === 0, `got ${reqs.length}: ${reqs.slice(0, 3).join(', ')}`);
  ok('no page errors', errs.length === 0, errs[0] ?? '');
  ok('header rendered', (await page.locator('header h1').count()) > 0);
  ok('coverage bar present', (await page.locator('.cov .why').count()) === 1);
  ok('coverage bar states a verdict', (await page.locator('.cov .why').innerText()).length > 10);

  const cur = () => page.evaluate(() => (typeof cur !== 'undefined' ? cur : -1));
  const N = await page.evaluate(() => (typeof N !== 'undefined' ? N : 0));
  ok('step count is positive', N > 0, `N=${N}`);

  // ---- keyboard scrub ----
  await page.evaluate(() => select(0));
  await page.keyboard.press('ArrowRight');
  ok('ArrowRight advances one step', (await cur()) === 1, `cur=${await cur()}`);
  await page.keyboard.press('j');
  ok('j advances one step', (await cur()) === 2, `cur=${await cur()}`);
  await page.keyboard.press('k');
  ok('k goes back one step', (await cur()) === 1, `cur=${await cur()}`);
  await page.keyboard.press('ArrowLeft');
  ok('ArrowLeft goes back one step', (await cur()) === 0, `cur=${await cur()}`);
  await page.keyboard.press('End');
  ok('End jumps to the last step', (await cur()) === N - 1, `cur=${await cur()}`);
  await page.keyboard.press('Home');
  ok('Home jumps to the first step', (await cur()) === 0, `cur=${await cur()}`);
  await page.evaluate(() => select(0));
  // PageDown/PageUp must clamp to the session bounds, not wrap or overshoot:
  // a 12-step session cannot land on 20, so the expected target is min(20, N-1).
  const pdTarget = Math.min(20, N - 1);
  await page.keyboard.press('PageDown');
  ok('PageDown jumps 20 steps, clamped to the last step', (await cur()) === pdTarget, `cur=${await cur()} want=${pdTarget} N=${N}`);
  const puTarget = Math.max(0, pdTarget - 20);
  await page.keyboard.press('PageUp');
  ok('PageUp jumps back 20 steps, clamped to the first step', (await cur()) === puTarget, `cur=${await cur()} want=${puTarget} N=${N}`);

  // ---- AC-5: space toggles playback ----
  await page.evaluate(() => select(0));
  const before = await page.locator('#play').innerText();
  await page.keyboard.press(' ');
  await page.waitForTimeout(500);
  const during = await page.locator('#play').innerText();
  const advanced = (await cur()) > 0;
  await page.keyboard.press(' ');
  ok('space starts playback', before !== during && advanced, `btn ${before}->${during} cur=${await cur()}`);

  // ---- main axis click-to-jump ----
  const rects = page.locator('.axiswrap svg').first().locator('rect[data-i]');
  const rc = await rects.count();
  ok('main axis drew a rect per step', rc === N, `rects=${rc} N=${N}`);
  if (rc > 40) {
    // On a dense timeline each rect is sub-pixel wide, so a synthetic point-click can land on a
    // neighbour. Assert the handler contract instead: the clicked rect's own data-i wins.
    const want = await page.evaluate(() => {
      const r = document.querySelectorAll('.axiswrap svg:first-of-type rect[data-i]')[40];
      r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return +r.getAttribute('data-i');
    });
    ok('main axis click selects that step', (await cur()) === want, `cur=${await cur()} want=${want}`);
  }
  const rowClick = await page.evaluate(() => {
    const r = document.querySelector('.rows [data-i]');
    if (!r) return -1;
    r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return +r.getAttribute('data-i');
  });
  ok('step list rows are clickable', rowClick >= 0 && (await cur()) === rowClick, `row=${rowClick} cur=${await cur()}`);

  // ---- AC-3b: context axis (secondary axis) jumps to first occurrence ----
  const cats = page.locator('.axiswrap svg').nth(1).locator('path[data-cat]');
  const cc = await cats.count();
  ok('context axis drew one band per category', cc > 0, `bands=${cc}`);

  // Pick a band that actually has area; a category with no content renders as a flat
  // zero-height line and is legitimately unclickable.
  const liveCat = await page.evaluate(() => {
    for (let k = 0; k < D.cats.length; k++) if (D.ctx.firstStep[k] >= 0) return k;
    return -1;
  });
  ok('at least one context category is present', liveCat >= 0, `liveCat=${liveCat}`);

  if (liveCat >= 0) {
    const expect = await page.evaluate((k) => D.ctx.firstStep[k], liveCat);
    const band = page.locator(`.axiswrap svg`).nth(1).locator(`path[data-cat="${liveCat}"]`);
    await band.dispatchEvent('click');
    ok('context band click jumps to that category first step', (await cur()) === expect, `cur=${await cur()} expect=${expect}`);

    // The legend swatch is the guaranteed clickable affordance for that same jump.
    await page.evaluate(() => select(0));
    await page.locator('.legend span').nth(liveCat).click();
    ok('legend swatch click jumps to the same step', (await cur()) === expect, `cur=${await cur()} expect=${expect}`);
  }

  // ---- diff rendering on an edit step ----
  const diffStep = await page.evaluate(() => {
    for (let i = 0; i < N; i++) { const d = diffFor(S[i]); if (d && d.lines.length) return i; }
    return -1;
  });
  if (diffStep >= 0) {
    await page.evaluate((i) => select(i), diffStep);
    const nDiff = await page.locator('.diff').count();
    ok('edit step renders a diff block', nDiff === 1, `diffStep=${diffStep} diffs=${nDiff}`);
    const recon = await page.locator('.diff').count() && (await page.locator('.badge.err, .badge.ok').count());
    ok('edit step states reversibility', recon > 0);
  } else {
    console.log('  skip diff test (this session has no before-image edit)');
  }

  // ---- regression: context bands must STACK, not overlap from one baseline ----
  // getBBox() spans the whole path and early zero-mass steps collapse onto the baseline, so
  // measure the geometry at the final step instead: band k's bottom must equal band k-1's top.
  const stack = await page.evaluate(() => {
    const paths = [...document.querySelectorAll('.axiswrap svg')[1].querySelectorAll('path[data-cat]')]
      .sort((a, b) => +a.getAttribute('data-cat') - +b.getAttribute('data-cat'));
    let maxTot = 1;
    for (let i = 0; i < N; i++) { const t = D.ctx.cumulative[i].reduce((a, b) => a + b, 0); if (t > maxTot) maxTot = t; }
    const edges = paths.map((p) => {
      const pts = p.getAttribute('d').match(/[ML](-?[\d.]+),(-?[\d.]+)/g).map((t) => t.slice(1).split(',').map(Number));
      const atEnd = pts.filter((q) => q[0] >= 999.9);
      return { cat: +p.getAttribute('data-cat'), top: atEnd[0][1], bottom: atEnd[1][1] };
    });
    const cum = D.ctx.cumulative[N - 1];
    let acc = 0, worst = 0, bottomOk = true;
    for (const e of edges) {
      const wantTop = 34 - ((acc + cum[e.cat]) / maxTot) * 34;
      const wantBot = 34 - (acc / maxTot) * 34;
      worst = Math.max(worst, Math.abs(e.top - wantTop), Math.abs(e.bottom - wantBot));
      if (Math.abs(e.bottom - wantBot) > 0.05) bottomOk = false;
      acc += cum[e.cat];
    }
    return { worst, bottomOk, bottomOfFirst: edges[0].bottom, edges };
  });
  ok('context bands stack to the expected geometry', stack.worst < 0.05, JSON.stringify(stack));
  ok('the lowest band sits on the baseline', Math.abs(stack.bottomOfFirst - 34) < 0.05, `bottom=${stack.bottomOfFirst}`);

  // ---- regression: the diff gutter must show line numbers, not blank space ----
  const gut = await page.evaluate(() => {
    for (let i = 0; i < N; i++) {
      const d = diffFor(S[i]);
      if (d && d.recon && d.lines.some((l) => l[0] === 'add')) {
        select(i);
        const lns = [...document.querySelectorAll('.diff .ln')].map((e) => e.textContent);
        return { step: i, filled: lns.filter((t) => t && t.length).length, total: lns.length,
                 adds: document.querySelectorAll('.diff .add').length };
      }
    }
    return null;
  });
  if (gut) {
    ok('diff gutter shows line numbers', gut.filled > 0, JSON.stringify(gut));
    ok('a real edit step renders added lines', gut.adds > 0, JSON.stringify(gut));
  } else {
    console.log('  skip gutter test (no recon edit with additions in this session)');
  }

  // ---- regression: a Write-style `content` payload must still produce a diff ----
  const contentDiff = await page.evaluate(() => {
    const fake = { kind: 'tool_call', ts: 1, callId: 'x', name: 'Write',
                   args: { file_path: '/a.ts' }, rawArgs: JSON.stringify({ file_path: '/a.ts', content: 'one\ntwo' }) };
    const d = diffFor(fake);
    return d ? { n: d.lines.length, recon: d.recon, kinds: d.lines.map((l) => l[0]) } : null;
  });
  ok('Write `content` payload yields a diff', !!contentDiff && contentDiff.n === 2, JSON.stringify(contentDiff));
  ok('Write `content` diff is not claimed reversible', !!contentDiff && contentDiff.recon === false);

  // ---- scrub latency ----
  const ms = await page.evaluate(() => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) select((i * 7) % N);
    return (performance.now() - t0) / 200;
  });
  ok('scrub averages under 100ms/step', ms < 100, `${ms.toFixed(2)}ms`);

  ok('no requests fired during interaction', reqs.length === 0, `got ${reqs.length}`);
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
