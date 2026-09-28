import type { ReplayStep, Session } from './types.js';
import { computeCoverage, VERDICT_LABEL } from './coverage.js';
import { isEditTool, diffFromArgs } from './diff.js';
import { buildContextTrack } from './context.js';

export interface PasteOptions {
  /** hard budget in bytes (contract AC-5b: 60KB) */
  maxBytes?: number;
}

/**
 * The GitHub-safe half of the dual output.
 *
 * Hard constraints, machine-checked by test/paste.test.ts:
 *   - only details / summary / table / thead / tbody / tr / th / td / pre / code / div
 *   - zero <script>, zero <style>, zero on* attributes
 *   - no external references of any kind
 *   - CSS-free by design: it must stay readable if every style attribute is stripped
 *
 * It is a *postmortem digest*, not a fake interactive replay. The full replay is `--html`.
 * If the digest does not fit, sections are dropped in reverse priority order and the
 * block says so — it never silently truncates.
 */

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

const kb = (n: number): string => (n > 1e6 ? `${(n / 1048576).toFixed(1)}M` : n > 1e3 ? `${(n / 1024).toFixed(1)}k` : String(n));

const ALLOWED = new Set([
  'details', 'summary', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'pre', 'code', 'div', 'p', 'b', 'br', 'hr',
]);

/** Test hook: every tag in the produced block must be in this set. */
export const PASTE_ALLOWED_TAGS = [...ALLOWED].sort();

export function assertPasteSafe(html: string): string[] {
  const problems: string[] = [];
  for (const m of html.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/g)) {
    const tag = (m[1] ?? '').toLowerCase();
    if (!ALLOWED.has(tag)) problems.push(`forbidden tag <${tag}>`);
  }
  if (/\son[a-z]+\s*=/i.test(html)) problems.push('inline event handler on*=');
  if (/(href|src)\s*=/i.test(html)) problems.push('external reference href/src');
  return problems;
}

const row = (cells: string[], head = false): string => {
  const t = head ? 'th' : 'td';
  return `<tr>${cells.map((c) => `<${t}>${c}</${t}>`).join('')}</tr>`;
};
const table = (head: string[], body: string[]): string =>
  body.length ? `<table><thead>${row(head, true)}</thead><tbody>${body.join('')}</tbody></table>` : '';

export interface PasteResult {
  html: string;
  bytes: number;
  dropped: string[];
}

export function buildPaste(session: Session, opts: PasteOptions = {}): PasteResult {
  const maxBytes = opts.maxBytes ?? 60 * 1024;
  const steps = session.steps;
  const m = session.meta;
  const cov = computeCoverage(steps, m.agent);
  const ctx = buildContextTrack(steps);

  const dropped: string[] = [];
  const sections: { name: string; priority: number; html: string }[] = [];

  /* --- section 1: header + coverage (never dropped: this is the honest part) --- */
  const head = [
    `<div><b>midflight</b> · agent 会话回放（自动检查 · 零插桩）</div>`,
    table(
      ['项', '值'],
      [
        row(['会话', esc(m.sessionId)]),
        row(['host', esc(m.agent)]),
        row(['模型', esc(m.model ?? '—')]),
        row(['effort', esc(m.effort ?? '—')]),
        row(['步骤', String(steps.length)]),
        row(['解析错误行', String(session.parseErrors.length)]),
        row(
          ['可撤回比例', `${esc(VERDICT_LABEL[cov.verdict])} · ${Math.round((cov.reversibleRatio ?? cov.ratio) * 100)}%（${cov.withBefore} / ${cov.totalChanges ?? cov.edits + cov.shellMutations} 处改动）— ${esc(cov.reason)}`],
        ),
        row(
          ['上下文压缩', ctx.hasFirstHandCompaction
            ? `${ctx.evaporated.filter((x) => x > 0).length} 次（第一手事件，合计丢弃 ${kb(ctx.evaporated.reduce((a, b) => a + b, 0))} 字符）`
            : '未观测到'],
        ),
        row(['红线', '不写工作区 · 不引 git · 不伪造快照']),
      ],
    ),
  ].join('');

  /* --- section 2: tool census --- */
  const census = new Map<string, { n: number; edits: number; recon: number }>();
  for (const s of steps) {
    if (s.kind !== 'tool_call') continue;
    const e = census.get(s.name) ?? { n: 0, edits: 0, recon: 0 };
    e.n += 1;
    if (isEditTool(s.name)) {
      e.edits += 1;
      if (diffFromArgs(s.rawArgs, s.beforeImage, s.newText)?.reconstructable) e.recon += 1;
    }
    census.set(s.name, e);
  }
  const censusRows = [...census.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 25)
    .map(([name, e]) =>
      row([`<code>${esc(name)}</code>`, String(e.n), e.edits ? `${e.edits}（可撤回 ${e.recon}）` : '—']),
    );
  sections.push({
    name: '工具调用普查',
    priority: 1,
    html: `<details><summary>工具调用普查（${census.size} 种）</summary>${table(['工具', '次数', '编辑/可撤回'], censusRows)}</details>`,
  });

  /* --- section 3: turn table --- */
  const turns: { id: string; start: number; end?: number; dur?: number; steps: number; tok: number }[] = [];
  let open: (typeof turns)[number] | null = null;
  for (const s of steps) {
    if (s.kind === 'turn_start') {
      open = { id: s.turnId, start: s.ts, steps: 0, tok: 0 };
      turns.push(open);
    } else if (s.kind === 'turn_end' && open) {
      open.end = s.ts;
      open.dur = s.durationMs;
    } else if (s.kind === 'usage') {
      if (open) open.tok += s.total;
    }
    if (open && s.kind !== 'turn_start') open.steps += 1;
  }
  const turnRows = turns.slice(0, 40).map((t, i) =>
    row([
      String(i + 1),
      `<code>${esc(t.id.slice(0, 8))}</code>`,
      t.dur != null ? `${(t.dur / 1000).toFixed(1)}s` : '—',
      String(t.steps),
      kb(t.tok),
    ]),
  );
  sections.push({
    name: '轮次',
    priority: 2,
    html: `<details><summary>轮次（${turns.length} 轮${turns.length > 40 ? '，显示前 40' : ''}）</summary>${table(
      ['#', 'turn', '时长', '步数', 'token 合计'],
      turnRows,
    )}</details>`,
  });

  /* --- section 4: compaction events --- */
  const comps = steps.map((s, i) => ({ s, i })).filter((x) => x.s.kind === 'compaction') as {
    s: Extract<ReplayStep, { kind: 'compaction' }>;
    i: number;
  }[];
  sections.push({
    name: '压缩事件',
    priority: 3,
    html: `<details><summary>上下文压缩事件（${comps.length}）</summary>${table(
      ['步', '时间', '压缩前 token', '本次压缩丢弃字符'],
      comps.slice(0, 30).map((c) =>
        row([
          `#${c.i + 1}`,
          new Date(c.s.ts).toISOString().replace('T', ' ').slice(0, 19),
          kb(c.s.contextBefore ?? 0),
          kb(ctx.evaporated[c.i] ?? 0),
        ]),
      ),
    )}</details>`,
  });

  /* --- section 5: parse errors --- */
  if (session.parseErrors.length) {
    sections.push({
      name: '损坏行',
      priority: 4,
      html: `<details><summary>无法解析的行（${session.parseErrors.length}）</summary>${table(
        ['行号', '原因'],
        session.parseErrors.slice(0, 15).map((e) => row([String(e.line), `<code>${esc(e.error.slice(0, 120))}</code>`])),
      )}</details>`,
    });
  }

  /* --- assemble within budget, dropping by ascending priority number --- */
  const wrap = (inner: string, notice: string): string => `<div>${inner}${notice}</div>`;
  let notice = '';
  let body = head + sections.map((s) => s.html).join('');
  let html = wrap(body, notice);
  const ordered = [...sections].sort((a, b) => a.priority - b.priority);
  while (Buffer.byteLength(html, 'utf8') > maxBytes && ordered.length) {
    const victim = ordered.shift()!;
    dropped.push(victim.name);
    body = head + sections.filter((s) => s.name !== victim.name).map((s) => s.html).join('');
    notice = `<div><b>已省略：</b>${dropped.map(esc).join('、')}（超出 ${kb(maxBytes)} 预算）</div>`;
    html = wrap(body, notice);
  }

  return { html, bytes: Buffer.byteLength(html, 'utf8'), dropped };
}
