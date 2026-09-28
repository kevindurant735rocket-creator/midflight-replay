import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildReport } from '../src/report.js';
import { parseSession } from '../src/adapters/index.js';

/**
 * Regression: a session whose tool output contains an HTML tag produced a BLANK report.
 * The data is inlined into one `<script>`, so `<!--` and `<script` inside a tool output move
 * the HTML tokenizer into script-data-escaped / double-escaped state, where the document's
 * own `</script>` no longer closes the element. Every record after that point became script
 * text, the app never parsed, and the page showed nothing at all — with zero page errors,
 * so nothing in the browser pointed at the cause.
 */
describe('report data can never break out of its own script element', () => {
  const payload = ['<!-- comment -->', '<script>alert(1)</script>', '</script>', '<style>x</style>'].join('\n');
  const session = {
    meta: { sessionId: 'escape', agent: 'claude-code' as const },
    steps: [
      { kind: 'user' as const, ts: 1, text: payload },
      { kind: 'tool_output' as const, ts: 2, callId: 't1', output: payload },
    ],
    parseErrors: [],
    warnings: [],
    unknownCount: 0,
    truncated: false,
  };

  it('escapes every < in the embedded data, not just the ones that look like a close tag', () => {
    const html = buildReport(session as never).html;
    const start = html.indexOf('<script>') + '<script>'.length;
    const end = html.indexOf('\n</script>\n</body>');
    expect(end).toBeGreaterThan(start);
    const data = html.slice(start, end);
    // The app's own source legitimately uses `<`; the DATA must not contribute any.
    expect(data).not.toContain('\\u003c/script\\u003e</script>');
    expect(html).toContain('\\u003c!--');
    expect(html).toContain('\\u003cscript>');
    // The document still has exactly one script close, and it is the real one.
    expect(html.endsWith('</script>\n</body></html>')).toBe(true);
    expect(html.split('</script>').length - 1).toBe(1);
  });

  it('still round-trips the original text through the escape', async () => {
    const html = buildReport(session as never).html;
    // `>` needs no escape: the tokenizer's escape states are entered by `<` alone.
    expect(html).toContain('\\u003c!-- comment -->');
    // and the parser hands the data back byte-for-byte
    const s = await parseSession('fixtures/script-escape.jsonl');
    expect(s.parseErrors).toEqual([]);
    expect(s.steps.some((x) => x.text?.includes('<script>') || x.output?.includes('<script>'))).toBe(true);
  });

  it('the bundled fixture carries the same payload so the CI browser gate covers it', () => {
    const raw = readFileSync('fixtures/script-escape.jsonl', 'utf8');
    expect(raw).toContain('<!--');
    expect(raw).toContain('<script>');
  });

  it('a report built from the fixture is syntactically complete', () => {
    const r = spawnSync(process.execPath, ['dist/cli.js', 'replay', 'fixtures/script-escape.jsonl', '--out', '/tmp/mf-escape.html'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/wrote/);
    const html = readFileSync('/tmp/mf-escape.html', 'utf8');
    expect(html.endsWith('</script>\n</body></html>')).toBe(true);
    expect(html.split('</script>').length - 1).toBe(1);
  });
});
