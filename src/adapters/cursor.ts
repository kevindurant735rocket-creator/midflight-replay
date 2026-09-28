import { parseAnthropicShaped, CURSOR_HOST, type ClaudeParseOptions } from './claude.js';
import type { Session } from '../types.js';

/**
 * Cursor CLI (`cursor-agent`) writes every agent turn to
 *   ~/.cursor/projects/<encoded-workspace-path>/agent-transcripts/<name>.jsonl
 * as Anthropic-shaped JSON Lines: a message record carries `role` plus a
 * `message.content` block array, and a turn ends with `{"type":"turn_ended"}`.
 *
 * What is NOT read here, on purpose:
 *  - `~/.cursor/chats/<ws-hash>/<chat-uuid>/store.db` — the IDE's own store. It is a
 *    SQLite `blobs(id, data)` table whose root blob is a protobuf tree. Reading it
 *    needs a protobuf schema Cursor does not publish, and a half-read store would
 *    replay as a session with holes in it. The CLI transcripts are plaintext and
 *    complete, so they are the honest source.
 *  - `subagents/` transcripts. They are nested agents, not the session the user
 *    ran; a replay that silently interleaves them is a different session.
 */
export async function parseCursor(
  lines: AsyncIterable<string>,
  sourceFile?: string,
  opts: ClaudeParseOptions = {},
): Promise<Session> {
  return parseAnthropicShaped(lines, sourceFile, opts, CURSOR_HOST);
}
