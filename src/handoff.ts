/**
 * Handoffs: continue in a fresh, small context instead of dragging (or /compact-ing) a huge one.
 *
 * `/compact` sends the whole conversation to the model again to summarize it. `/clear` costs
 * nothing, and grug writes a handoff from what it already recorded (session log + transcript
 * tail): goal, latest requests, where it got to, open todos, files, commands. No model call.
 * The next session in the project starts with the handoff (~1k tokens) instead of ~500k.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { paths, readJson, writeJsonAtomic } from './config.js';
import { projectKey, readBuffer } from './memory/store.js';
import { estimateTokens, priceFor, CACHE_READ_MULT, CACHE_WRITE_MULT, CACHE_WRITE_1H_MULT } from './tokens.js';

export interface Handoff {
  ts: number;
  sessionId: string;
  project: string;
  contextTokens: number;
  text: string;
  consumedBy?: string;
}

const file = (project: string) => path.join(paths.home(), 'handoffs', `${project.replace(/[^\w.~-]/g, '_')}.json`);

function readTail(p: string, bytes: number): string {
  try {
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const t = buf.toString('utf8');
    return len < size ? t.slice(t.indexOf('\n') + 1) : t;
  } catch {
    return '';
  }
}

/** Parsed JSONL entries from the tail of a transcript. */
export function transcriptEntries(p: string | undefined, bytes = 1024 * 1024): any[] {
  if (!p) return [];
  const out: any[] = [];
  for (const l of readTail(p, bytes).split('\n')) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* torn */
    }
  }
  return out;
}

/**
 * Complete transcript lines appended since `offset` (0 = from the start, or the last `maxBytes`
 * of a huge file). Returns the new offset to resume from, so each byte is parsed once.
 */
export function transcriptEntriesFrom(p: string | undefined, offset: number, maxBytes = 4 * 1024 * 1024): { entries: any[]; offset: number; size: number } {
  const none = { entries: [] as any[], offset, size: 0 };
  if (!p) return none;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      let from = offset > size ? 0 : offset; // truncated or replaced file: start over
      const jumped = size - from > maxBytes;
      if (jumped) from = size - maxBytes;
      if (size === from) return { entries: [], offset: from, size };
      let buf: Buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      if (jumped && from > 0) {
        // landed mid-line: skip to the next line start
        const nl = buf.indexOf(10);
        if (nl < 0) return { entries: [], offset: size, size };
        from += nl + 1;
        buf = buf.subarray(nl + 1);
      }
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return { entries: [], offset: from, size }; // no complete line yet
      const out: any[] = [];
      for (const l of buf.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
        if (!l) continue;
        try {
          out.push(JSON.parse(l));
        } catch {
          /* torn */
        }
      }
      return { entries: out, offset: from + lastNl + 1, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return none;
  }
}

/** Tokens in context for the latest request (what the next reply will re-read) + its model. */
export function contextSize(transcriptPath?: string): { tokens: number; model: string; lastReplyTs: number; oneHourCache: boolean } {
  const es = transcriptEntries(transcriptPath, 2 * 1024 * 1024);
  // Did any recent reply write the 1-hour cache tier? Then an idle gap under an hour keeps the cache warm.
  const oneHourCache = es.some((e) => e?.type === 'assistant' && (e.message?.usage?.cache_creation?.ephemeral_1h_input_tokens || 0) > 0);
  let pending = 0; // tool results / prompts added after the last reply (not in any usage yet)
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    const m = e?.message;
    if (e?.isSidechain) continue;
    if (e?.type === 'assistant' && m?.usage) {
      const u = m.usage;
      return {
        tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) + pending,
        model: m.model || '',
        lastReplyTs: Date.parse(e.timestamp) || 0,
        oneHourCache
      };
    }
    if (e?.type === 'user' && m?.content) pending += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  }
  return { tokens: pending, model: '', lastReplyTs: 0, oneHourCache };
}

/** Rough $ per reply at this context size (mostly cache reads) — shown to the user only. */
export function costPerReply(tokens: number, model: string): number {
  return (tokens * priceFor(model).input * CACHE_READ_MULT) / 1e6;
}

/** What an idle gap costs: the reply after the cache expired re-writes the whole context instead of reading it. */
export function coldCacheCost(tokens: number, model: string, oneHour: boolean): { cold: number; warm: number } {
  const p = priceFor(model).input;
  return { cold: (tokens * p * (oneHour ? CACHE_WRITE_1H_MULT : CACHE_WRITE_MULT)) / 1e6, warm: (tokens * p * CACHE_READ_MULT) / 1e6 };
}

function oneLine(s: string, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function assistantText(e: any): string {
  const c = e?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
}

function openTodos(es: any[]): string[] {
  for (let i = es.length - 1; i >= 0; i--) {
    const c = es[i]?.message?.content;
    if (es[i]?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (b?.type === 'tool_use' && /todo/i.test(b.name || '') && Array.isArray(b.input?.todos)) {
        return b.input.todos
          .filter((t: any) => t && t.status !== 'completed')
          .map((t: any) => `[${t.status || 'pending'}] ${oneLine(t.content || t.activeForm || t.title || '', 140)}`);
      }
    }
  }
  return [];
}

export function buildHandoff(sessionId: string, transcriptPath: string | undefined, cwd: string, maxTokens = 1200): Handoff | null {
  const buf = readBuffer(sessionId);
  const prompts = buf.filter((e) => e.t === 'prompt') as Array<{ t: 'prompt'; ts: number; text: string }>;
  const es = transcriptEntries(transcriptPath);
  const replies = es.filter((e) => e?.type === 'assistant' && !e.isSidechain).map(assistantText).filter((t) => t.trim());
  if (!prompts.length && !replies.length) return null;

  const edited = new Map<string, number>();
  const read = new Map<string, number>();
  for (const e of buf) {
    if (e.t !== 'file') continue;
    const rel = path.isAbsolute(e.path) ? path.relative(cwd, e.path) : e.path;
    if (!rel || rel.startsWith('..')) continue;
    const m = e.op === 'edit' ? edited : read;
    m.set(rel, (m.get(rel) || 0) + 1);
  }
  const cmds = (buf.filter((e) => e.t === 'cmd') as Array<{ cmd: string }>).map((c) => oneLine(c.cmd, 90));
  const ctx = contextSize(transcriptPath);
  const project = projectKey(cwd);

  const lines: string[] = [];
  const add = (l: string) => {
    if (estimateTokens(lines.join('\n') + '\n' + l) <= maxTokens) {
      lines.push(l);
      return true;
    }
    return false;
  };
  add(
    `[grugbrain handoff: continuing work from a previous session in ${path.basename(cwd)} (its context was ${Math.round(ctx.tokens / 1000)}k tokens; not loaded). ` +
      `Pick up from here; check files before assuming, and ask the user if something is unclear.]`
  );
  if (prompts[0]) add(`Goal: ${oneLine(prompts[0].text, 300)}`);
  const recent = prompts.slice(1).slice(-4);
  if (recent.length) {
    add('Latest requests:');
    for (const p of recent) add(`- ${oneLine(p.text, 220)}`);
  }
  const todos = openTodos(es);
  if (todos.length) {
    add('Open todos:');
    for (const t of todos.slice(0, 10)) add(`- ${t}`);
  }
  // Prefer the last substantive replies over one-line progress notes.
  const substantive = replies.filter((r) => r.trim().length >= 160);
  const last = (substantive.length ? substantive : replies).slice(-2);
  if (last.length) {
    add('Where it got to (last replies):');
    for (const r of last) add(`> ${oneLine(r, 700)}`);
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  if (edited.size) add(`Files changed: ${top(edited).slice(0, 15).join(', ')}`);
  if (read.size) add(`Files read: ${top(read).filter((f) => !edited.has(f)).slice(0, 12).join(', ')}`);
  if (cmds.length) add(`Recent commands: ${[...new Set(cmds.slice(-8))].join(' · ')}`);
  add('Need an exact detail from before (an error, a decision, a snippet)? Search the full earlier conversation with the grugbrain `history` tool instead of guessing.');

  return { ts: Date.now(), sessionId, project, contextTokens: ctx.tokens, text: lines.join('\n') };
}

export function saveHandoff(h: Handoff): void {
  writeJsonAtomic(file(h.project), h);
}

export function loadHandoff(project: string): Handoff | null {
  const r = readJson<Handoff>(file(project));
  return r.ok && r.value?.text ? r.value : null;
}

/** Handoff to inject into a new session: recent, from another session, not already used. */
export function takeHandoff(project: string, sessionId: string, maxAgeHours: number, afterCompaction = false): Handoff | null {
  const h = loadHandoff(project);
  if (!h || h.consumedBy) return null;
  // A new session takes another session's handoff; a compacted session takes its own.
  if (!afterCompaction && h.sessionId === sessionId) return null;
  if (afterCompaction && h.sessionId !== sessionId) return null;
  if (Date.now() - h.ts > maxAgeHours * 3600 * 1000) return null;
  saveHandoff({ ...h, consumedBy: sessionId });
  return h;
}
