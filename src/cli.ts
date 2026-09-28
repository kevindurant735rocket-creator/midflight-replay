#!/usr/bin/env node
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { detectAdapter, parseSession, statsOf } from './adapters/index.js';
import { redact } from './redact.js';
import { readReportPayload, planRevert, listRevertable } from './revert.js';
import { buildReport } from './report.js';
import { buildPaste, assertPasteSafe } from './paste.js';
import { writeFileSync } from 'node:fs';
import { readVersion } from './version.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { postmortem, renderPostmortem } from './postmortem.js';
import { scanAgents, formatAgentTable } from './agents.js';
import { installSkill, presentTargets, TARGETS, SKILL_NAME, type InstallTarget } from './install.js';

const USAGE = `midflight — 把 AI 智能体跑完的一次会话，变成一个能来回拖动的网页

先试这一条（读你机器上最近的一次 Codex 会话，生成 replay.html）
  midflight replay "$(ls -t ~/.codex/sessions/*/*/*/*.jsonl | head -1)" --out replay.html

  不确定自己有哪些会话日志？先问一句
  midflight agents --probe

用法
  midflight replay <会话文件>            生成一个自带全部内容的网页，可以直接拖动回看
  midflight doctor <会话文件>            检查这个日志能不能读，坏在哪一行（有问题时退出码 1）
  midflight stats  <会话文件>            只数一数：这个会话一共多少步、都是些什么步骤
  midflight postmortem <会话文件>        找问题：反复改同一个文件、绕圈、上下文快满了
  midflight revert  <report.html> --list  看看这个报告里哪几步可以撤回
  midflight revert  <report.html> --step <n>  打印出反向补丁；永远不碰你的工作区
  midflight agents [--json] [--probe]    本机装了哪些智能体、哪些日志读得动
  midflight install <名字>|--all          把 midflight 的用法装进那个智能体
  midflight redact                       从标准输入里过一遍脱敏（路径/密钥/邮箱）
  midflight --version                    打印版本号
  midflight help                         打印这段说明

装到智能体里的选项
  --probe         把每个读得动的智能体的最新日志都真解析一遍（慢一点，但能证明真的能用）
  --all           列出所有认识的智能体，不管你这台机器上有没有装
  --dry-run       只打印会写到哪里，不动任何文件
  --force         目标位置已经有别的文件时，先问过再覆盖

replay 的选项
  --out <文件>        写到哪个文件（默认直接打印到屏幕）
  --paste             不生成网页，改成一段可以贴进 PR 的纯文本
  --max-steps <n>     最多放多少步进去（默认 3000；工具调用和上下文压缩事件永不丢）
  --per-step-chars <n>  每步最多留多少字（默认 1200）
  --no-redact         关闭脱敏（默认是开的）
  --json              顺便在 stderr 打一份机器能读的汇总

全部在你自己的机器上跑：不联网、不上报、不建数据库、不装任何依赖。
日志里没被读懂的部分会直接告诉你第几行，不猜、不编。
`;

async function cmdAgents(json: boolean, probe: boolean, all: boolean): Promise<number> {
  const home = process.env.HOME ?? '';
  const reports = await scanAgents({
    homeDir: home,
    probe,
    ...(probe
      ? {
          parse: async (p: string) => {
            const s = await parseSession(p, { homeDir: home });
            return {
              steps: s.steps.length,
              parseErrors: s.parseErrors.length,
              agent: s.meta.agent ?? '',
            };
          },
        }
      : {}),
  });
  const shown = all ? reports : reports;
  if (json) {
    console.log(JSON.stringify({ home, agents: shown }, null, 2));
  } else {
    console.log(formatAgentTable(shown));
  }
  return 0;
}

async function cmdInstall(args: string[]): Promise<number> {
  const dry = args.includes('--dry-run');
  const force = args.includes('--force');
  const all = args.includes('--all');
  const home = process.env.HOME ?? '';
  const wanted = args.filter((a) => !a.startsWith('--'));
  const version = readVersion();
  let targets: InstallTarget[];
  if (all) {
    targets = TARGETS;
  } else if (wanted.length === 0) {
    const present = presentTargets(home);
    if (present.length === 0) {
      console.error(
        'error: no known agent home found here. Pass a target explicitly, e.g.\n' +
          `  midflight install codex\n\nknown targets: ${TARGETS.map((t) => t.id).join(', ')}`,
      );
      return 2;
    }
    targets = present;
  } else {
    targets = [];
    for (const id of wanted) {
      const t = TARGETS.find((x) => x.id === id);
      if (!t) {
        console.error(
          `error: unknown target ${id}\nknown targets: ${TARGETS.map((x) => x.id).join(', ')}`,
        );
        return 2;
      }
      targets.push(t);
    }
  }
  let wrote = 0;
  let conflicts = 0;
  for (const t of targets) {
    if (dry) {
      // dry-run must not touch the filesystem: report the exact path, write nothing
      const p = `${join(home, t.dir, SKILL_NAME)}/${t.filename}`;
      const already = existsSync(p);
      console.log(
        `${'DRY-RUN'.padEnd(9)} ${t.label.padEnd(16)} ${p}${already ? '  (exists; would be compared)' : ''}`,
      );
      continue;
    }
    const r = installSkill(t, { homeDir: home, version, force });
    const state = r.conflict ? 'CONFLICT' : r.written ? 'WROTE' : 'UNCHANGED';
    if (r.conflict) conflicts++;
    if (r.written) wrote++;
    console.log(`${state.padEnd(9)} ${t.label.padEnd(16)} ${r.path}`);
    if (r.conflict) console.log(`          ${r.conflict}`);
  }
  console.log(
    `\n${targets.length} target(s), ${wrote} written, ${conflicts} conflict(s), ` +
      `${readVersion()} — skill name \`${SKILL_NAME}\`. Nothing else on this machine was touched.`,
  );
  if (dry) {
    console.log('(dry run: nothing was written)');
    return 0;
  }
  return conflicts > 0 ? 1 : 0;
}

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
    adapter: await detectAdapter(path),
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
    const kinds = Object.entries(st.byKind).sort((a, b) => b[1] - a[1]);
    console.log(`  steps by kind: ${kinds.map(([k, v]) => `${k} ${v}`).join('  ')}`);
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

/**
 * Postmortem reads the log and counts. It never exits non-zero for a finding:
 * a loop in someone's session is a fact about their session, not a parse error,
 * and a tool that exits 1 on a finding gets its exit code ignored by CI wrappers.
 */
function cmdPostmortem(path: string, json: boolean): Promise<number> {
  return (async () => {
    if (!exists(path)) {
      console.error(`error: not a file: ${path}`);
      return 2;
    }
    const session = await parseSession(path, { homeDir: process.env.HOME });
    const findings = postmortem(session.steps);
    if (json) {
      console.log(JSON.stringify({ sessionId: session.meta.sessionId, findings }, null, 2));
    } else {
      process.stdout.write(renderPostmortem(findings, session.meta.sessionId));
    }
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

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function cmdRevert(argv: string[]): Promise<number> {
  // Consume flag values so they never look like the positional report path.
  const consumed = new Set<string>();
  for (const f of ['--step', '--out']) {
    const i = argv.indexOf(f);
    if (i >= 0) { consumed.add(argv[i]); if (argv[i + 1]) consumed.add(argv[i + 1]); }
  }
  const positional = argv.filter((a) => !a.startsWith('--') && !consumed.has(a));
  const reportPath = positional[0];
  if (!reportPath) {
    console.error('error: revert needs a report file (one produced by `midflight replay`)');
    return 2;
  }
  const html = readFileSync(reportPath, 'utf8');
  let steps; let cwd: string | undefined;
  try {
    ({ steps, cwd } = readReportPayload(html));
  } catch (e) {
    console.error(`error: ${(e as Error).message}`);
    return 2;
  }

  if (argv.includes('--list')) {
    // --list must work on a report alone: a colleague may not have the checkout.
    const rows = listRevertable(steps);
    if (rows.length === 0) {
      console.error('这份报告里没有可逆放的编辑：没有任何一步带 before-image。');
      return 1;
    }
    for (const r of rows) {
      console.log(`step ${String(r.step).padStart(5)}  [${r.source.padEnd(12)}]  ${r.path}`);
    }
    console.error(`\n${rows.length} 个可逆放步骤。用 --step <n> 生成补丁。`);
    return 0;
  }

  const stepArg = argValue(argv, '--step');
  if (stepArg === undefined) {
    console.error('error: revert needs --step <n> (or --list to see which steps are reversible)');
    return 2;
  }
  const n = Number(stepArg);
  const r = planRevert(steps, n, cwd);
  if (!r.ok) {
    console.error(`refused: ${r.reason}`);
    return 1;
  }
  const out = argValue(argv, '--out');
  if (out) {
    writeFileSync(out, r.patch, 'utf8');
    console.error(`wrote ${out}  step ${r.step}  ${r.path}  +${r.added} -${r.removed}  source=${r.source}`);
    console.error(`apply it backwards with:  git apply -R ${out}`);
  } else {
    process.stdout.write(r.patch);
  }
  return 0;
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
      case 'agents':
        return await cmdAgents(json, argv.includes('--probe'), argv.includes('--all'));
      case 'install':
        return await cmdInstall(argv.slice(1));
      case 'postmortem':
        return await cmdPostmortem(rest[0] ?? '', json);
      case 'revert':
        return await cmdRevert(argv.slice(1));
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
