/**
 * Fleet-level agent detection.
 *
 * `midflight doctor` answers "is THIS file parseable". This module answers the two
 * questions a new user actually asks first, both of which used to have no answer at all:
 *
 *   1. which coding agents have left session logs on this machine, and
 *   2. which of those can midflight actually read today.
 *
 * Honesty rule (same one as KNOWN-GAPS.md): a row is either measured or it is not here.
 * An agent whose store is found but has no adapter is reported as `unsupported` with the
 * real file count and byte total, never quietly omitted — an unfilled gap you can see is
 * useful, an invisible gap is not.
 *
 * No dependencies. Probes are plain filesystem walks with a filename filter and a hard
 * depth cap, because this runs on a stranger's machine inside a doctor command.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterName } from './adapters/index.js';

export interface AgentSpec {
  id: string;
  label: string;
  /** the adapter that can parse this agent's logs, or null when none ships today */
  adapter: AdapterName | null;
  /** one line, factual, no optimism */
  support: string;
  /** home-relative roots that get walked */
  roots: string[];
  /** filename filter; null means "any file" */
  match: RegExp | null;
  recursive: boolean;
  maxDepth: number;
  /** what the row reports when the store is absent */
  absentMeans: string;
  /**
   * Path-level filter: a file only counts as a session record when its whole path matches.
   * Needed whenever `match` is null, because those hosts keep other things under the same
   * root. On this machine `midflight install` had written its own rule file into
   * ~/.cursor/rules and the row then claimed "2 session files found" — a number that was
   * true about the files and false about what a session is.
   */
  only?: RegExp;
  /** directory names that can never hold session records, pruned during the walk */
  pruneDirs?: RegExp;
  /** plain-language answer for "installed, but no session data on this machine" */
  sessionHint?: string;
}

export interface AgentHit {
  file: string;
  bytes: number;
  mtimeMs: number;
}

export interface AgentReport {
  id: string;
  label: string;
  adapter: AdapterName | null;
  support: string;
  /**
   * `empty` is its own state on purpose: the host directory exists but holds no session
   * record, so there is nothing for an adapter to fail at. Reporting that as `unsupported`
   * tells the reader to go looking for a parser bug that does not exist.
   */
  status: 'supported' | 'unsupported' | 'absent' | 'empty';
  /** roots that actually existed on this machine */
  rootsFound: string[];
  files: number;
  bytes: number;
  newest: string | null;
  newestMtime: number;
  /** newest log, capped at this many bytes, so doctor output stays one screen */
  hit?: AgentHit;
}

export const AGENTS: AgentSpec[] = [
  {
    id: 'codex',
    label: 'Codex CLI',
    adapter: 'codex',
    support: 'full adapter — session_meta + response_item + compaction events',
    roots: ['.codex/sessions', '.codex/archived_sessions'],
    match: /rollout-.*\.jsonl$/,
    recursive: true,
    maxDepth: 6,
    absentMeans: 'no ~/.codex/sessions — Codex has not written a session here yet',
    sessionHint: 'Codex 装在这台机器上，但还没有会话记录（会话写在 ~/.codex/sessions）',
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    adapter: 'claude-code',
    support: 'full adapter — transcript records + ~/.claude/file-history before-images',
    roots: ['.claude/projects'],
    match: /\.jsonl$/,
    recursive: true,
    maxDepth: 4,
    absentMeans: 'no ~/.claude/projects — Claude Code has not written a session here yet',
    sessionHint: 'Claude Code 装在这台机器上，但还没有会话记录（会话写在 ~/.claude/projects）',
  },
  {
    id: 'cursor',
    label: 'Cursor',
    adapter: null,
    support: 'no adapter — Cursor keeps chat state in a private store, not a JSONL transcript',
    roots: ['.cursor'],
    match: null,
    recursive: true,
    maxDepth: 3,
    absentMeans: 'no ~/.cursor directory',
    only: /[\\/]chats[\\/]/,
    pruneDirs: /^(rules|skills|extensions|images|commands)$/,
    sessionHint: 'Cursor 装在这台机器上，但还没找到聊天记录（Cursor 把聊天放在 ~/.cursor/chats）',
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    adapter: null,
    support: 'no adapter — its chat log is a single JSON blob, not a step-addressable JSONL',
    roots: ['.gemini/tmp', '.gemini'],
    match: /logs\.json$|chat\.json$/,
    recursive: true,
    maxDepth: 4,
    absentMeans: 'no ~/.gemini/tmp logs',
    sessionHint: 'Gemini CLI 的目录在，但还没有会话记录（它只在 ~/.gemini/tmp 留临时日志）',
  },
  {
    id: 'opencode',
    label: 'opencode',
    adapter: null,
    support: 'no adapter — session storage is a per-message directory tree, not a log',
    roots: ['.local/share/opencode/storage', '.config/opencode', '.opencode'],
    match: /message|part|session/,
    recursive: true,
    maxDepth: 3,
    absentMeans: 'no opencode storage directory',
    sessionHint: 'opencode 的目录在，但还没有会话记录',
  },
  {
    id: 'github-copilot-cli',
    label: 'GitHub Copilot CLI',
    adapter: null,
    support: 'no adapter — history is a single session-history file, no per-step records',
    roots: ['.config/github-copilot', '.copilot'],
    match: /history|session/i,
    recursive: true,
    maxDepth: 3,
    absentMeans: 'no ~/.config/github-copilot',
    sessionHint: 'GitHub Copilot CLI 的配置目录在，但还没有会话记录',
  },
  {
    id: 'aider',
    label: 'Aider',
    adapter: null,
    support: 'no adapter — its history file is chat markdown with no tool-call records',
    roots: ['.aider.chat.history.md', '.aider'],
    match: null,
    recursive: false,
    maxDepth: 1,
    absentMeans: 'no ~/.aider.chat.history.md',
    sessionHint: 'Aider 的聊天历史文件不在，暂时读不到内容',
  },
  {
    id: 'continue',
    label: 'Continue',
    adapter: null,
    support: 'no adapter — sessions live in a VS Code SQLite database, not a log file',
    roots: ['.continue'],
    match: /\.db$|\.sqlite3?$/i,
    recursive: true,
    maxDepth: 4,
    absentMeans: 'no ~/.continue',
    sessionHint: 'Continue 的配置目录在，但还没有会话记录',
  },
  {
    id: 'cline',
    label: 'Cline',
    adapter: null,
    support: 'no adapter — task history is UI state, the transcript is in the extension host',
    roots: ['.cline', '.config/cline'],
    match: /task|history/i,
    recursive: true,
    maxDepth: 3,
    absentMeans: 'no ~/.cline',
    sessionHint: 'Cline 的目录在，但还没有会话记录',
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    adapter: null,
    support: 'no adapter — conversations are account-side, nothing readable on disk',
    roots: ['.codeium/windsurf', '.windsurf'],
    match: null,
    recursive: true,
    maxDepth: 3,
    absentMeans: 'no ~/.codeium/windsurf',
    only: /[\\/]chats[\\/]|cascade[^\\/]*\.db$/i,
    pruneDirs: /^(rules|skills|extensions|commands|bin|logs)$/,
    sessionHint: 'Windsurf 装在这台机器上，但还没找到聊天记录（Windsurf 的对话存在它的账号侧，本机只有规则文件）',
  },
  {
    id: 'factory-droid',
    label: 'Factory Droid',
    adapter: null,
    support: 'no adapter — its ~/.factory/sessions store is not yet decoded',
    roots: ['.factory/sessions', '.factory'],
    match: /session|rollout/i,
    recursive: true,
    maxDepth: 4,
    absentMeans: 'no ~/.factory/sessions',
    sessionHint: 'Factory Droid 的目录在，但还没有可解码的会话文件',
  },
];

function walk(root: string, spec: AgentSpec, cap: number, out: AgentHit[], baseDepth: number): void {
  if (out.length >= cap) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (out.length >= cap) return;
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (spec.pruneDirs?.test(name)) continue;
      if (spec.recursive && root.split('/').length - baseDepth < spec.maxDepth) {
        walk(p, spec, cap, out, baseDepth);
      }
      continue;
    }
    if (spec.match && !spec.match.test(name)) continue;
    if (spec.only && !spec.only.test(p)) continue;
    out.push({ file: p, bytes: st.size, mtimeMs: st.mtimeMs });
  }
}

export interface ScanOptions {
  homeDir: string;
  /** stop counting after this many files per agent (default 2000) */
  cap?: number;
  /** scan the newest log of every supported agent through the parser (default false) */
  probe?: boolean;
  parse?: (path: string) => Promise<{ steps: number; parseErrors: number; agent: string }>;
}

export async function scanAgents(opts: ScanOptions): Promise<AgentReport[]> {
  const cap = opts.cap ?? 2000;
  const reports: AgentReport[] = [];
  for (const spec of AGENTS) {
    const home = opts.homeDir;
    const roots = spec.roots.map((r) => (r.startsWith('~') ? join(home, r.slice(1)) : join(home, r)));
    const found = roots.filter((r) => existsSync(r));
    const hits: AgentHit[] = [];
    for (const r of found) {
      // depth is counted from the probed root so maxDepth means what the table says
      if (spec.recursive) {
        const st = statSync(r);
        if (st.isDirectory()) walk(r, spec, cap, hits, r.split('/').length);
        else if (!spec.match || spec.match.test(r.split('/').pop() ?? ''))
          hits.push({ file: r, bytes: st.size, mtimeMs: st.mtimeMs });
      } else {
        const st = statSync(r);
        hits.push({ file: r, bytes: st.size, mtimeMs: st.mtimeMs });
      }
    }
    const bytes = hits.reduce((a, h) => a + h.bytes, 0);
    let newest: AgentHit | null = null;
    for (const h of hits) if (!newest || h.mtimeMs > newest.mtimeMs) newest = h;
    const status: AgentReport['status'] =
      hits.length === 0
        ? found.length > 0
          ? 'empty'
          : 'absent'
        : spec.adapter
          ? 'supported'
          : 'unsupported';
    // The host directory exists but holds no session record. Saying "no adapter, 2 files
    // found" there is the worst of both worlds: it names a real adapter gap and attaches a
    // file count that is really counting rules files. Say the plain thing instead.
    const installedButEmpty = hits.length === 0 && found.length > 0;
    const rep: AgentReport = {
      id: spec.id,
      label: spec.label,
      adapter: spec.adapter,
      support: installedButEmpty ? spec.sessionHint ?? `${spec.absentMeans}; no session record under it` : spec.support,
      status,
      rootsFound: found,
      files: hits.length,
      bytes,
      newest: newest ? newest.file : null,
      newestMtime: newest ? newest.mtimeMs : 0,
    };
    if (opts.probe && spec.adapter && newest && opts.parse) {
      try {
        const r = await opts.parse(newest.file);
        rep.hit = { file: newest.file, bytes: newest.bytes, mtimeMs: newest.mtimeMs };
        rep.support = `${spec.support} · newest log: ${r.steps} steps, ${r.parseErrors} parse errors`;
      } catch (e) {
        rep.support = `${spec.support} · newest log FAILED to parse: ${(e as Error).message}`;
      }
    }
    reports.push(rep);
  }
  return reports;
}

const human = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

export function formatAgentTable(reports: AgentReport[]): string {
  const pad = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n));
  const lines: string[] = [];
  lines.push('agent                 status       sessions   size        newest');
  lines.push('--------------------  -----------  ---------  ----------  -----------------');
  for (const r of reports) {
    if (r.status === 'absent') {
      lines.push(`${pad(r.label, 20)}  ${pad('not installed', 11)}  ${pad('-', 9)}  ${pad('-', 10)}  -`);
      continue;
    }
    const st =
      r.status === 'supported' ? 'readable' : r.status === 'empty' ? 'no records' : 'no adapter';
    const when = r.newest ? new Date(r.newestMtime).toISOString().slice(0, 10) : '-';
    lines.push(
      `${pad(r.label, 20)}  ${pad(st, 11)}  ${pad(String(r.files), 9)}  ${pad(human(r.bytes), 10)}  ${when}`,
    );
  }
  const readable = reports.filter((r) => r.status === 'supported');
  const found = reports.filter((r) => r.status !== 'absent');
  lines.push('');
  lines.push(
    `${readable.length} of ${found.length} installed agents readable; ` +
      `${reports.length - found.length} not installed on this machine.`,
  );
  for (const r of reports) {
    // "0 file(s) found" is noise: it only ever appeared to pad a sentence that already said
    // there is nothing to read. A count is worth printing only when there is something to count.
    if (r.status === 'unsupported') lines.push(`  ! ${r.label}: ${r.support} (${r.files} file(s) found)`);
    else if (r.status === 'empty') lines.push(`  - ${r.label}: ${r.support}`);
    else if (r.status === 'supported' && r.support.includes('newest log:'))
      lines.push(`  \u2713 ${r.label}: ${r.support.slice(r.support.indexOf('newest log:'))}`);
    if (r.support.includes('FAILED')) lines.push(`  ! ${r.label}: ${r.support}`);
  }
  return lines.join('\n');
}
