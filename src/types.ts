/** Normalized replay contract. Ground truth: docs/FORMATS.md (measured from real sessions). */

export type ReplayStep =
  | { kind: 'user'; ts: number; text: string }
  | { kind: 'assistant'; ts: number; text: string }
  | { kind: 'reasoning'; ts: number; summary: string }
  | { kind: 'tool_call'; ts: number; callId: string; name: string; args: unknown; rawArgs: string }
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
}

export interface ParseStats {
  totalLines: number;
  parsedLines: number;
  errorLines: number;
  unknownSteps: number;
  byKind: Record<string, number>;
  durationMs: number;
}
