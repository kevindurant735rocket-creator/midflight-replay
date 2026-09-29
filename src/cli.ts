#!/usr/bin/env node
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { detectAdapter, parseSession, statsOf } from './adapters/index.js';
import { redact } from './redact.js';
import { readReportPayload, planRevert, listRevertable } from './revert.js';
import { buildReport } from './report.js';
import { thinBanner } from './compact.js';
import { buildPaste, assertPasteSafe } from './paste.js';
import { writeFileSync } from 'node:fs';
import { readVersion } from './version.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { postmortem, renderPostmortem } from './postmortem.js';
import { VERDICT_LABEL } from './coverage.js';
import { scanAgents, formatAgentTable } from './agents.js';
import { installSkill, presentTargets, TARGETS, SKILL_NAME, type InstallTarget } from './install.js';

const USAGE = `midflight — 把 AI 智能体跑完的一次会话，变成一个能来回拖动的网页

先试这一条（不给文件，它自己找你机器上最近的一次会话，生成 replay.html）
  midflight replay --out replay.html

  想知道它挑的是哪一次，或者这台机器上哪些智能体写过日志
  midflight agents --probe

用法
  midflight replay [会话文件或目录]       生成一个自带全部内容的网页，可以直接拖动回看
                                       不给文件就自动挑最近的一次会话
  midflight doctor [会话文件或目录]       检查这个日志能不能读，坏在哪一行（有问题时退出码 1）
  midflight stats  [会话文件或目录]      只数一数：这个会话一共多少步、都是些什么步骤
  midflight postmortem [会话文件或目录]  找问题：反复改同一个文件、绕圈、上下文快满了
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

/**
 * The record kinds the parsers emit, in the words a reader would use. Unknown
 * kinds fall through unchanged — a new adapter's kind should still print.
 */
const KIND_LABEL: Record<string, string> = {
  user: '用户消息',
  assistant: '助手回复',
  reasoning: '推理',
  tool_call: '工具调用',
  tool_output: '工具输出',
  turn_start: '轮次开始',
  turn_end: '轮次结束',
  usage: '用量',
  compaction: '上下文压缩',
  file_event: '文件改动',
  note: '备注',
  unknown: '不认识',
};

/**
 * `JSON.parse` failures arrive as V8 sentences: "Unexpected token 'g', \"garbage{\"
 * is not valid JSON". On the FAIL screen that is a second, unexplained language.
 * Say what happened in the reader's words and keep V8's own words as the reason,
 * so nothing is lost and nothing is invented.
 */
function explainParseError(raw: string): string {
  // V8 prefixes most of these with `invalid JSON: `; match past the prefix.
  const m = /(?:^|:\s*)Unexpected end of JSON input/.test(raw);
  if (m) return '这一行没写完就被截断了（V8：Unexpected end of JSON input）';
  const t = /(?:^|:\s*)Unexpected token '(.+?)'/.exec(raw);
  if (t) return `从第 ${t[1].length} 个字符开始就不对，V8 认不出（Unexpected token '${t[1]}'）`;
  if (/not valid JSON/.test(raw)) return '这一行不是合法的 JSON';
  return raw;
}

/** Warnings are raised in English near the parsers; the FAIL screen speaks Chinese. */
function warningText(w: string): string {
  if (/no sessionId seen|no session_meta line found/.test(w)) return '日志里没写会话 ID，标题是推断出来的';
  if (/session header is inferred/.test(w)) return '会话标题是推断出来的';
  if (/^format not detected/.test(w)) {
    const m = /with the (\S+) adapter/.exec(w);
    return `认不出这是哪种会话日志，勉强用 ${m ? m[1] : '默认'} 适配器读了一遍`;
  }
  if (/no timestamp on a replayable record|missing\/invalid timestamp/.test(w)) {
    // Two spellings upstream ("no timestamp on a replayable record" /
    // "missing/invalid timestamp"). Same fact, so one Chinese sentence — and
    // drop the English tail entirely rather than appending a translation to it.
    const n = /^line (\d+): /.exec(w);
    const where = n ? `第 ${n[1]} 行` : '有一行';
    return /dated at session start/.test(w)
      ? `${where}没有时间戳，只能按会话开始的时间算`
      : `${where}没有可用的时间戳，时间是沿用上一条算的`;
  }
  if (/^(\d+) line\(s\) failed to parse$/.test(w)) return `有 ${/^(\d+)/.exec(w)![1]} 行没读懂`;
  if (/^file-history:/.test(w)) return w;
  return w;
}

type SessionArg = { path: string; source: 'given' | 'discovered'; agent?: string };

/**
 * A real user does not know where their log lives, and no help screen teaches a
 * four-level glob by heart. When the argument is missing, empty, or a directory,
 * pick the newest session this machine actually has and say out loud which one.
 * An explicit file is still honoured exactly as before, so nothing that works
 * today changes behaviour.
 */
async function resolveSession(arg: string | undefined): Promise<SessionArg | null> {
  const a = (arg ?? '').trim();
  if (a) {
    try {
      if (existsSync(a) && statSync(a).isFile()) return { path: a, source: 'given' };
    } catch {
      /* unreadable path: fall through and look for a session instead of dying */
    }
  }
  const home = process.env.HOME ?? '';
  if (!home) return null;
  let reports: Awaited<ReturnType<typeof scanAgents>>;
  try {
    reports = await scanAgents({ homeDir: home });
  } catch {
    return null;
  }
  let best: { file: string; mtime: number; label: string } | null = null;
  for (const r of reports) {
    if (!r.newest) continue;
    if (!best || r.newestMtime > best.mtime) best = { file: r.newest, mtime: r.newestMtime, label: r.label };
  }
  return best ? { path: best.file, source: 'discovered', agent: best.label } : null;
}

/** One line naming the session we picked, so the user can see what they got. */
function noteDiscovered(s: SessionArg): void {
  if (s.source !== 'discovered') return;
  console.error(`没给文件，用你这台机器上最近的一次会话：${s.agent}\n  ${s.path}\n`);
}

function noSessionFound(json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, error: 'no session log found on this machine', hint: 'run `midflight agents --probe` to see which agents wrote logs' }, null, 2));
    return;
  }
  console.error(`没找到能读的会话日志。\n`);
  console.error(`  先看这台机器上哪些智能体写过日志：\n    midflight agents --probe\n`);
  console.error(`  或者直接把日志文件给它：\n    midflight replay /path/to/session.jsonl\n`);
}

async function cmdDoctor(path: string, json: boolean): Promise<number> {
  const arg = await resolveSession(path);
  if (!arg) {
    noSessionFound(json);
    return 2;
  }
  if (!json) noteDiscovered(arg);
  path = arg.path;
  const t0 = Date.now();
  const session = await parseSession(path, { homeDir: process.env.HOME });
  const lines = countLines(path);
  const st = statsOf(session, lines, Date.now() - t0);
  const bytes = statSync(path).size;
  const ok = session.parseErrors.length === 0 && session.steps.length > 0;
  const adapter = await detectAdapter(path);
  const payload = {
    ok,
    file: path,
    bytes,
    adapter,
    // The fallback adapter stamps its own name, so a file we could not identify used to
    // come back as `"agent": "codex"` next to `"adapter": "unknown"`. Both fields are quoted
    // verbatim when someone opens an issue, and a Gemini or Aider log filed as a codex log
    // sends the triage down the wrong path. When we could not name the format, say so.
    agent: adapter === 'unknown' ? 'unknown' : session.meta.agent,
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
    // This is the screen a user reads when something is wrong with their log.
    // Every word on it is theirs: an English V8 message ("invalid JSON: Unexpected
    // token 'g'") on a screen titled FAIL tells a reader nothing about what to
    // do next. `--json` keeps the English keys on purpose — that is a machine
    // contract, not a sentence anyone reads.
    console.log(`${ok ? '能读' : '读不了'}  ${path}`);
    console.log(
      `  格式 ${payload.adapter} · 来源 ${payload.agent} · 共 ${payload.lines} 行，解析出 ${payload.steps} 步` +
        ` · ${st.durationMs}ms · ${(bytes / 1048576).toFixed(1)} MiB`,
    );
    const kinds = Object.entries(st.byKind).sort((a, b) => b[1] - a[1]);
    // Only print the breakdown when there is one — a bare "steps by kind:" with
    // nothing after it reads like the tool forgot to finish its sentence.
    if (kinds.length > 0) {
      console.log(`  每类步数：${kinds.map(([k, v]) => `${KIND_LABEL[k] ?? k} ${v}`).join(' · ')}`);
    }
    if (payload.parseErrorCount) {
      console.log(`  有 ${payload.parseErrorCount} 行读不懂，最前面的几行：`);
      for (const e of session.parseErrors.slice(0, 5)) {
        console.log(`    第 ${e.line} 行：${explainParseError(e.error)}`);
      }
      if (payload.parseErrorCount > 5) console.log(`    …… 还有 ${payload.parseErrorCount - 5} 行没显示`);
    }
    if (payload.fileHistoryBackups > 0 || payload.fileHistoryJoins > 0) {
      const h = payload.fileHistory;
      console.log(
        `  备份还原：找到 ${payload.fileHistoryBackups} 个备份，${payload.fileHistoryJoins} 处编辑对上了` +
          (h
            ? `，其中 ${h.recovered} 处只能靠备份还原，${h.agree + h.disagree} 处和日志逐字核对过（${h.disagree} 处不一致），${h.untracked} 处没盯上`
            : ''),
      );
    }
    for (const w of session.warnings) console.log(`  注意：${warningText(w)}`);
  }
  return ok ? 0 : 1;
}

function cmdStats(path: string, json: boolean): Promise<number> {
  return (async () => {
    const arg = await resolveSession(path);
    if (!arg) {
      noSessionFound(json);
      return 2;
    }
    if (!json) noteDiscovered(arg);
    path = arg.path;
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
    const arg = await resolveSession(path);
    if (!arg) {
      noSessionFound(json);
      return 2;
    }
    if (!json) noteDiscovered(arg);
    path = arg.path;
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
  const arg = await resolveSession(path);
  if (!arg) {
    noSessionFound(false);
    return 2;
  }
  noteDiscovered(arg);
  path = arg.path;
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
  // A file whose every line failed to parse is not a session, and the one line
  // printed below ("wrote replay.html  steps 0/0") is indistinguishable from
  // success. `doctor` already refuses that case; `replay` must agree, or the
  // first command a newcomer runs tells them their log is fine when it is not.
  // The same predicate doctor uses, so the two can never drift apart.
  if (session.parseErrors.length > 0 && session.steps.length === 0) {
    console.error(`error: 这个文件每一行都读不懂，写出来的网页是空的。`);
    for (const e of session.parseErrors.slice(0, 3)) {
      console.error(`  第 ${e.line} 行：${e.error}`);
    }
    console.error(`  完整原因：midflight doctor ${path}`);
    if (out) writeFileSync(out, r.html, 'utf8');
    return 1;
  }
  if (session.parseErrors.length > 0) {
    const first = session.parseErrors[0];
    console.error(
      `warn: ${session.parseErrors.length} 行读不懂（第一处：第 ${first.line} 行），网页里已按能读的部分渲染`,
    );
  }
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
      // The first line a user reads after the tool succeeds. It led with an
      // English verb and printed the coverage verdict as the raw enum
      // `coverage=partial` while the rest of the CLI spoke Chinese — and the
      // Chinese for that verdict already existed (VERDICT_LABEL), used by the
      // report itself. Same words in both places or the two disagree.
      console.error(
        `已写入 ${out}  ${(r.bytes / 1048576).toFixed(2)} MiB  ${r.kept}/${r.total} 步  ` +
          `撤回：${VERDICT_LABEL[r.coverageVerdict as keyof typeof VERDICT_LABEL] ?? r.coverageVerdict}  解析 ${parseMs}ms`,
      );
      // `3000/6172 步` in the success line above is the same fact the report page spells
      // out. On the terminal it looked like a formatting artifact, so a user replaying a
      // long session opened the file, found half the conversation missing, and had no way
      // back to the flag that caused it. Same sentence as the report, same words, no drift.
      if (r.truncated) console.error(`提示：${thinBanner(r.kept, r.total, r.droppedByKind)}`);
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
/**
 * `--list` used to print `[log         ]` — a bracketed internal enum padded
 * to a fixed width. Nothing in the rest of the CLI talks that way, and the
 * padding made the two real sources (`log`, `file-history`) look like one
 * five-word constant. The project's own Chinese is already decided:
 * `日志内联` for a before-image the transcript carried, `备份还原` for one
 * recovered from ~/.claude/file-history. Reuse those words instead of
 * inventing a third vocabulary.
 */
function revertSourceLabel(source: 'log' | 'file-history'): string {
  return source === 'file-history' ? '备份还原' : '日志内联';
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
      console.error('这份报告里能撤回的编辑：没有任何一步带 before-image。');
      return 1;
    }
    for (const r of rows) {
      console.log(`step ${String(r.step).padStart(5)}  ${revertSourceLabel(r.source)}  ${r.path}`);
    }
    console.error(`\n${rows.length} 个能撤回的步骤。用 --step <n> 生成补丁。`);
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
    console.error(`已写入 ${out}  第 ${r.step} 步  ${r.path}  +${r.added} -${r.removed}  来源：${revertSourceLabel(r.source)}`);
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
  // `--out replay.html` puts a path in argv that is not a session file. Filtering
  // only the `--flag` tokens left that path in `rest`, so `midflight replay --out x`
  // read its own output back as a session and failed on line 3 of its own HTML.
  // Skip the value of every flag that takes one; `--out=x` carries no separate value.
  const VALUE_FLAGS = new Set(['--out', '--max-steps', '--per-step-chars', '--step']);
  const rest: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    rest.push(a);
  }
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
      case 'doctor':
        return await cmdDoctor(rest[0] ?? '', json);
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
