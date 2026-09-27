#!/usr/bin/env node
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { detectAdapter, parseSession, statsOf } from './adapters/index.js';
import { redact } from './redact.js';
import { buildReport } from './report.js';
import { buildPaste, assertPasteSafe } from './paste.js';
import { writeFileSync } from 'node:fs';
import { readVersion } from './version.js';

const USAGE = `midflight — forensic replay for AI coding agents

Usage
  midflight replay <session.jsonl> [options]   build a self-contained replay
  midflight doctor <session.jsonl> [--json]    parse a session and report health; exit 1 on bad input
  midflight stats  <session.jsonl> [--json]    parse and print step counts
  midflight redact                            run the redactor over stdin
  midflight --version                          print the installed version
  midflight help

Replay options
  --out <file>        write the HTML here (default: stdout)
  --paste             emit the GitHub-safe digest block instead of the interactive report
  --max-steps <n>     max steps to embed (default 3000; tool calls and compaction events are never dropped)
  --per-step-chars <n>  max chars kept per step payload (default 1200)
  --no-redact         disable redaction (redaction is ON by default)
  --json              machine-readable summary on stderr

Everything runs locally. No network, no telemetry, no database, no dependencies.
`;

async function cmdDoctor(path: string, json: boolean): Promise<number> {
  if (!exists(path)) {
    const msg = `not a file: ${path}`;
    if (json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(`error: ${msg}`);
    return 2;
  }
  const t0 = Date.now();
  const session = await parseSession(path, { homeDir: process.env.HOME });
  const lines = countLines(path);
  const st = statsOf(session, lines, Date.now() - t0);
  const bytes = statSync(path).size;
  const ok = session.parseErrors.length === 0 && session.steps.length > 0;
  const payload = {
    ok,
    file: path,
    bytes,
    adapter: detectAdapter(path),
    agent: session.meta.agent,
    sessionId: session.meta.sessionId,
    cliVersion: session.meta.cliVersion,
    cwd: session.meta.cwd,
    model: session.meta.model,
    contextWindow: session.meta.contextWindow,
    lines: st.totalLines,
    steps: session.steps.length,
    parseErrors: session.parseErrors.slice(0, 20),
    parseErrorCount: session.parseErrors.length,
    unknownSteps: st.unknownSteps,
    warnings: session.warnings,
    byKind: st.byKind,
    // P0-1: the two numbers that decide whether this log can be replayed offline at all.
    // Flat on purpose — `jq '.fileHistoryJoins'` must not need to know the shape of the detail.
    fileHistoryBackups: session.fileHistory?.backups ?? 0,
    fileHistoryJoins: session.fileHistory?.joins ?? 0,
    fileHistory: session.fileHistory ?? null,
    parseMs: st.durationMs,
  };
  if (json) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${path}`);
    console.log(`  adapter=${payload.adapter} agent=${payload.agent} lines=${payload.lines} steps=${payload.steps} (${st.durationMs}ms, ${(bytes / 1048576).toFixed(1)} MiB)`);
    console.log(`  byKind=${JSON.stringify(st.byKind)}`);
    if (payload.parseErrorCount) {
      console.log(`  ${payload.parseErrorCount} bad line(s); first:`);
      for (const e of session.parseErrors.slice(0, 5)) console.log(`    line ${e.line}: ${e.error}`);
    }
    if (payload.fileHistoryBackups > 0 || payload.fileHistoryJoins > 0) {
      const h = payload.fileHistory;
      console.log(
        `  file-history: ${payload.fileHistoryBackups} backup(s); ${payload.fileHistoryJoins} edit(s) matched` +
          (h ? ` — recovered ${h.recovered}, cross-checked ${h.agree + h.disagree} (${h.disagree} disagree), untracked ${h.untracked}` : ''),
      );
    }
    for (const w of session.warnings) console.log(`  warn: ${w}`);
  }
  return ok ? 0 : 1;
}

function cmdStats(path: string, json: boolean): Promise<number> {
  return (async () => {
    if (!exists(path)) {
      console.error(`error: not a file: ${path}`);
      return 2;
    }
    const t0 = Date.now();
    const session = await parseSession(path, { homeDir: process.env.HOME });
    const st = statsOf(session, countLines(path), Date.now() - t0);
    if (json) console.log(JSON.stringify({ byKind: st.byKind, steps: session.steps.length, errors: st.errorLines }, null, 2));
    else for (const [k, v] of Object.entries(st.byKind).sort((a, b) => b[1] - a[1])) console.log(`${String(v).padStart(6)}  ${k}`);
    return 0;
  })();
}

/** parse `--flag value` / `--flag=value` without a dep */
function flag(argv: string[], name: string): string | undefined {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}
const numFlag = (argv: string[], name: string): number | undefined => {
  const v = flag(argv, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number, got ${v}`);
  return n;
};

async function cmdReplay(path: string, argv: string[]): Promise<number> {
  if (!exists(path)) {
    console.error(`error: not a file: ${path}`);
    return 2;
  }
  const t0 = Date.now();
  const session = await parseSession(path, {
    homeDir: process.env.HOME,
    ...(argv.includes('--no-redact') ? { enabled: false as const } : {}),
  });
  const parseMs = Date.now() - t0;
  const maxSteps = numFlag(argv, 'max-steps');
  const perStepChars = numFlag(argv, 'per-step-chars');
  const wantPaste = argv.includes('--paste');
  const out = flag(argv, 'out');

  if (wantPaste) {
    const r = buildPaste(session, { ...(maxSteps ? { maxBytes: maxSteps * 1024 } : {}) });
    const problems = assertPasteSafe(r.html);
    if (problems.length) {
      console.error(`error: paste block violates its own contract: ${problems.join('; ')}`);
      return 2;
    }
    if (out) writeFileSync(out, r.html, 'utf8');
    else process.stdout.write(r.html);
    if (argv.includes('--json')) {
      console.error(JSON.stringify({ mode: 'paste', bytes: r.bytes, dropped: r.dropped, parseMs }, null, 2));
    }
    return 0;
  }

  const r = buildReport(session, {
    ...(maxSteps ? { maxSteps } : {}),
    ...(perStepChars ? { perStepChars } : {}),
    sourceLabel: path,
  });
  if (out) {
    writeFileSync(out, r.html, 'utf8');
    if (argv.includes('--json')) {
      console.error(
        JSON.stringify(
          { mode: 'html', out, bytes: r.bytes, kept: r.kept, total: r.total, coverage: r.coverageVerdict, parseMs, parseErrors: session.parseErrors.length },
          null,
          2,
        ),
      );
    } else {
      console.error(`wrote ${out}  ${(r.bytes / 1048576).toFixed(2)} MiB  steps ${r.kept}/${r.total}  coverage=${r.coverageVerdict}  parse=${parseMs}ms`);
    }
  } else {
    process.stdout.write(r.html);
  }
  return 0;
}

function exists(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function countLines(p: string): number {
  // Cheap: newline count via a stream would need a dep; chunked sync read is enough.
  const fd = openSync(p, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    let n = 0;
    let pos = 0;
    let read: number;
    let last = 10;
    while ((read = readSync(fd, buf, 0, buf.length, pos)) > 0) {
      pos += read;
      for (let i = 0; i < read; i++) if (buf[i] === 10) n++;
      last = buf[read - 1] ?? last;
    }
    const size = statSync(p).size;
    return size > 0 && last !== 10 ? n + 1 : n;
  } finally {
    closeSync(fd);
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const json = argv.includes('--json');
  const rest = argv.slice(1).filter((a) => !a.startsWith('--'));
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    // Read from the package the tarball actually shipped, so the number can
    // never drift from what npm reports. Never fatal if the layout changes.
    console.log(readVersion());
    return 0;
  }
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE);
    return cmd ? 0 : 1;
  }
  try {
    switch (cmd) {
      case 'replay':
        return await cmdReplay(rest[0] ?? '', argv);
      case 'doctor': {
        if (!rest[0]) {
          console.error('error: doctor needs a session file');
          return 2;
        }
        return await cmdDoctor(rest[0], json);
      }
      case 'stats':
        return await cmdStats(rest[0] ?? '', json);
      case 'redact': {
        const chunks: Buffer[] = [];
        for await (const c of process.stdin) chunks.push(c as Buffer);
        const r = redact(Buffer.concat(chunks).toString('utf8'), { homeDir: process.env.HOME });
        console.log(r.text);
        return 0;
      }
      default:
        console.error(`error: unknown command ${cmd}\n\n${USAGE}`);
        return 2;
    }
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }
}

main().then((c) => {
  process.exitCode = c;
});
