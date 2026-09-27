/** Normalized replay contract. Ground truth: docs/FORMATS.md (measured from real sessions). */

export type ReplayStep =
  | { kind: 'user'; ts: number; text: string }
  | { kind: 'assistant'; ts: number; text: string }
  | { kind: 'reasoning'; ts: number; summary: string }
  | {
      kind: 'tool_call';
      ts: number;
      callId: string;
      name: string;
      args: unknown;
      rawArgs: string;
      /**
       * The text this edit APPLIED, lifted out of the JSON args. `perStepChars` clips rawArgs,
       * and a clipped JSON string no longer parses — so the new text used to vanish for any
       * edit larger than the per-step cap, taking the diff with it. Carried separately, and
       * clipped separately, so the diff survives a small budget.
       */
      newText?: string;
      /** before-image recovered from the host's own backup store (~/.claude/file-history).
       *  Set ONLY when the log itself carried no old_string; already redacted. */
      beforeImage?: string;
      /** which backup version produced it, e.g. `3f2a91c@v1` — provenance for the reader */
      beforeImageFrom?: string;
    }
  | { kind: 'tool_output'; ts: number; callId: string; output: string; truncated: boolean }
  | { kind: 'turn_start'; ts: number; turnId: string; model?: string; effort?: string; contextWindow?: number }
  | { kind: 'turn_end'; ts: number; turnId: string; durationMs?: number; ttftMs?: number }
  | {
      kind: 'usage';
      ts: number;
      input: number;
      cachedInput: number;
      output: number;
      reasoning: number;
      total: number;
      contextWindow?: number;
      turnId?: string;
      /** cumulative total across the whole thread, when the host reports it */
      threadTotal?: number;
    }
  /** first-hand compaction event emitted by the host (not inferred from token drops) */
  /** contextBefore is the HOST-reported pre-compaction size in TOKENS, not characters.
   *  Characters only exist in the report's own measured curve (ctx.evaporated). */
  | { kind: 'compaction'; ts: number; summary: string; turnId?: string; contextBefore?: number }
  | { kind: 'file_event'; ts: number; path: string; op: 'create' | 'modify' | 'delete'; tool: string; text?: string }
  | { kind: 'note'; ts: number; level: 'info' | 'warn' | 'error'; text: string }
  | { kind: 'unknown'; ts: number; raw: string; sourceLine: number };

export type StepKind = ReplayStep['kind'];

export interface SessionMeta {
  sessionId: string;
  agent: string;
  /** human title the host assigned to the conversation, when it logs one */
  title?: string;
  cliVersion?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  provider?: string;
  gitBranch?: string;
  contextWindow?: number;
  startedAt?: number;
  sourceFile?: string;
}

export interface ParseError {
  line: number;
  error: string;
  raw: string;
}

export interface Session {
  meta: SessionMeta;
  steps: ReplayStep[];
  parseErrors: ParseError[];
  warnings: string[];
  unknownCount: number;
  /** true when parse errors were severe enough to invalidate the session */
  truncated: boolean;
  /** what the host's file-history backup store could add, and how much was actually used */
  fileHistory?: FileHistoryStats;
}

/**
 * What the host's file-history backup store contributed. Canonical here so the adapter, the
 * coverage bar, `doctor --json` and the report cannot drift into four different shapes.
 */
export interface FileHistoryStats {
  root: string;
  /** the store (or this session's directory of it) exists */
  available: boolean;
  /** backup files present for this session */
  backups: number;
  /** delta records that named a backup AND whose message was found */
  resolved: number;
  /** before-images actually attached to a step */
  joins: number;
  /** joins where the log's own old_string agreed with the backup */
  agree: number;
  /** joins where the log HAD an old_string and the backup contradicts it — a real discrepancy */
  disagree: number;
  /** joins where the log had no old_string at all: the backup is the only surviving copy */
  recovered: number;
  /** deltas the host declined to track (`backupFileName: null`) */
  untracked: number;
  /** named backups that were gone from disk */
  missing: number;
  /** backups over the read ceiling */
  oversize: number;
  /** backups that could not be read */
  unreadable: number;
  reason: string;
}

export interface ParseStats {
  totalLines: number;
  parsedLines: number;
  errorLines: number;
  unknownSteps: number;
  byKind: Record<string, number>;
  durationMs: number;
}
