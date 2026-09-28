import { createReadStream } from 'node:fs';
import { basename, extname } from 'node:path';
import type { ReplayStep, Session } from '../types.js';

/**
 * Windsurf (Codeium Cascade) keeps a conversation at
 *   ~/.codeium/windsurf/cascade/<session-uuid>.pb
 * and that file is ENCRYPTED at rest. Two independent public readings agree:
 *  - memory-forge-rs `docs/archive/windsurf-adapter-plan.md` measured the `.pb` header
 *    as a non-standard magic and could not decode it without a `.proto` schema;
 *  - nexpath `src/ext-vscode/src/extractors/windsurf.ts` measured a live Windsurf 2.0
 *    install at Shannon entropy 8.00 bits/byte with no prompt text in plaintext or
 *    base64, and its author concluded there is no readable prompt on disk at all.
 * The only plaintext Windsurf writes is session metadata (id, LLM-written title, cwd)
 * under `windsurf.acp.metadataCache` in `state.vscdb` — a one-line summary per
 * session, with none of the prompts or replies.
 *
 * So this adapter does NOT pretend to parse Windsurf. It proves the store is
 * unreadable, on the reader's own bytes, and says so in the report. The alternative
 * — shipping an "empty" Windsurf timeline — would show a user a blank scrubber and
 * let them conclude their session had no steps, which is the exact class of false
 * claim this project exists to remove. Decrypting the store is out of scope: it needs
 * a schema the vendor does not publish, it breaks on every Windsurf release, and it
 * is a terms-of-service question, not an engineering one.
 */
export interface CascadeProbe {
  bytes: number;
  /** Shannon entropy in bits per byte. Random data is 8.00; English prose is ~4.5. */
  entropy: number;
  /** Longest run of printable ASCII. Prose has thousands; ciphertext has tens. */
  longestPrintableRun: number;
  /** True when the bytes look like ciphertext rather than a text format. */
  looksEncrypted: boolean;
}

const PROBE_LIMIT = 4 * 1024 * 1024; // enough to characterise a store; bounded so a 2GB file cannot stall a report

export async function probeCascade(path: string): Promise<CascadeProbe> {
  const counts = new Uint32Array(256);
  let bytes = 0;
  let printableRun = 0;
  let longestPrintableRun = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
    const b = chunk as Buffer;
    for (let i = 0; i < b.length && bytes < PROBE_LIMIT; i++) {
      const v = b[i];
      counts[v]++;
      bytes++;
      // Printable ASCII plus the whitespace that separates words.
      if ((v >= 0x20 && v <= 0x7e) || v === 0x09 || v === 0x0a || v === 0x0d) {
        printableRun++;
        if (printableRun > longestPrintableRun) longestPrintableRun = printableRun;
      } else {
        printableRun = 0;
      }
    }
    if (bytes >= PROBE_LIMIT) break;
  }
  let h = 0;
  if (bytes > 0) {
    for (let v = 0; v < 256; v++) {
      const c = counts[v];
      if (c === 0) continue;
      const p = c / bytes;
      h -= p * Math.log2(p);
    }
  }
  const entropy = bytes === 0 ? 0 : h;
  // Two independent signals, so a single unlucky file cannot flip the verdict:
  // near-maximal entropy AND almost no readable run.
  const looksEncrypted = bytes > 0 && entropy > 7.5 && longestPrintableRun < 64;
  return { bytes, entropy, longestPrintableRun, looksEncrypted };
}

export async function parseWindsurfCascade(path: string): Promise<Session> {
  const probe = await probeCascade(path);
  const id = basename(path, extname(path)) || 'unknown';
  const mib = (probe.bytes / 1024 / 1024).toFixed(1);
  const meta = { sessionId: id, agent: 'windsurf', sourceFile: path } as Session['meta'];
  const warnings: string[] = [];
  const steps: ReplayStep[] = [];

  if (probe.bytes === 0) {
    warnings.push('windsurf: cascade 文件是空的，没有可读内容');
    return { meta, steps, parseErrors: [], warnings, unknownCount: 0, truncated: false };
  }

  const entropy = probe.entropy.toFixed(2);
  const lead = probe.looksEncrypted
    ? `熵 ${entropy} bits/byte（随机数据上限 8.00），最长可打印片段 ${probe.longestPrintableRun} 字节 —— 这是密文，不是文本格式`
    : `熵 ${entropy} bits/byte，最长可打印片段 ${probe.longestPrintableRun} 字节 —— 看起来不是密文，但也没有 midflight 认识的记录结构`;

  steps.push({
    kind: 'note',
    ts: 0,
    level: probe.looksEncrypted ? 'warn' : 'info',
    text:
      `Windsurf 把这段对话加密后存在磁盘上（${mib} MiB，${lead}）。` +
      `midflight 不解密，因此没有可回放的步骤 —— 这一栏空着是因为读不出来，不是因为这一次会话没做事。`,
  });
  warnings.push(
    `windsurf: cascade/${id}.pb 无法回放（${mib} MiB，熵 ${entropy} bits/byte）。` +
      `Windsurf 的对话正文在磁盘上是加密的，只有一个 LLM 写的标题是明文。`,
  );
  return { meta, steps, parseErrors: [], warnings, unknownCount: 0, truncated: false };
}
