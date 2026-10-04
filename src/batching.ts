/**
 * Fewer replies per task. Every reply re-sends the whole conversation, so a lookup done one tool
 * call per reply costs a full context read each time. Measured on a real week: 1.00 tool calls per
 * reply, and 22% of replies were the next step of a chain of single read-only lookups (18% of all
 * context re-read). Two cheap pushes toward batching independent lookups into one reply:
 *  - BATCH_RULE, a sentence at session/subagent start;
 *  - batchNudge(), a short note after a chain of single-lookup replies (rate-limited, ask-once style).
 */
import { bashFileOps } from './bashops.js';
import { transcriptEntries } from './handoff.js';
import { appendBuffer, readBuffer } from './memory/store.js';

export const BATCH_RULE =
  'Batch lookups: when you need several reads, greps or checks that do not depend on each other, request them in one reply (parallel tool calls) and chain shell steps in one Bash call. Each extra reply re-sends the whole conversation.';

/** Replies in a row, each a single lookup, before the note. */
export const CHAIN = 3;
const MAX_PER_SESSION = 3;
const GAP_MS = 10 * 60 * 1000;

const MUTATING = /\b(npm|npx|yarn|pnpm|git\s+(commit|push|checkout|reset|merge|rebase|stash)|rm|mv|cp|mkdir|curl|wget|node|python3?|tsx|make|cargo|go\s+(run|build|test))\b/;

/** A read-only lookup: Read/Grep/Glob, or a shell command that only reads or greps files. */
export function isLookup(tool: string, input: any, cwd: string): boolean {
  if (tool === 'Read' || tool === 'Grep' || tool === 'Glob') return true;
  if (tool !== 'Bash') return false;
  const cmd = String(input?.command || '');
  if (!cmd || MUTATING.test(cmd)) return false;
  const ops = bashFileOps(cmd, cwd);
  return ops.uses.length > 0 && !ops.files.some((f) => f.op === 'edit');
}

/** The last `n` main-thread replies (tool calls grouped by message id, oldest first). */
function lastReplies(transcript: string | undefined, n: number): Array<{ tools: Array<{ name: string; input: any }>; text: number }> {
  const order: string[] = [];
  const byId = new Map<string, { tools: Array<{ name: string; input: any }>; text: number }>();
  for (const e of transcriptEntries(transcript, 128 * 1024)) {
    if (e?.type !== 'assistant' || e.isSidechain) continue;
    const id = String(e.message?.id || e.uuid || '');
    if (!byId.has(id)) {
      byId.set(id, { tools: [], text: 0 });
      order.push(id);
    }
    const r = byId.get(id)!;
    for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
      if (b?.type === 'tool_use') r.tools.push({ name: String(b.name || ''), input: b.input });
      else if (b?.type === 'text') r.text += String(b.text || '').length;
    }
  }
  return order.slice(-n).map((id) => byId.get(id)!);
}

/**
 * After a lookup: if the last CHAIN replies were each one lookup and nothing else, a short note
 * (at most MAX_PER_SESSION per session, GAP_MS apart). Null otherwise.
 */
export function batchNudge(sid: string, tool: string, input: any, transcript: string | undefined, cwd: string, now: number): string | null {
  if (!transcript || !isLookup(tool, input, cwd)) return null;
  const sent = readBuffer(sid).filter((e: any) => e.t === 'nudge' && e.k === 'batch');
  if (sent.length >= MAX_PER_SESSION || (sent.length && now - sent[sent.length - 1].ts < GAP_MS)) return null;
  const replies = lastReplies(transcript, CHAIN);
  if (replies.length < CHAIN) return null;
  if (!replies.every((r) => r.tools.length === 1 && r.text < 300 && isLookup(r.tools[0].name, r.tools[0].input, cwd))) return null;
  appendBuffer(sid, { t: 'nudge', ts: now, k: 'batch' });
  return `[grugbrain: ${CHAIN} lookups in a row, one per reply. If you already know other files or patterns you need, request them together in your next reply (parallel tool calls); each reply re-sends the whole conversation.]`;
}
