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
import { projectKey, readBuffer, similarity } from './memory/store.js';
import { isTrivialPrompt } from './relevance.js';
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
type ContextSize = { tokens: number; model: string; lastReplyTs: number; oneHourCache: boolean };
let sizeMemo: { key: string; value: ContextSize } | null = null;

export function contextSize(transcriptPath?: string): ContextSize {
  // Several prompt-time checks ask for the same transcript: read it once per change.
  let key = '';
  try {
    if (transcriptPath) {
      const st = fs.statSync(transcriptPath);
      key = `${transcriptPath}|${st.mtimeMs}|${st.size}`;
    }
  } catch {
    /* no transcript */
  }
  if (key && sizeMemo?.key === key) return sizeMemo.value;
  const value = computeContextSize(transcriptPath);
  if (key) sizeMemo = { key, value };
  return value;
}

function computeContextSize(transcriptPath?: string): ContextSize {
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

const CHECK_CMD = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)|npx\s+(?:vitest|jest|tsc|eslint)|vitest|jest|pytest|tox|ruff|mypy|cargo\s+(?:test|build|clippy)|go\s+(?:test|build|vet)|tsc|make|gradle|mvn|dotnet\s+(?:test|build))\b/;
const FAIL_OUT = /\b(exit code [1-9]|command failed|npm ERR!|FAILED|FAIL\b|error TS\d+|Traceback \(most recent|panic:|\d+ failed)/;
const PASS_LINE = /\b(\d+\s+(?:passed|passing)|Tests?\s+.*passed|test result: ok|build succeeded|0 errors|All checks passed|ok\s+\S+\s+[\d.]+s)\b/i;

function resultText(c: any): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n');
}

/** Where the work stands: the last test/build/lint command and whether it passed (by output, not by claim). */
export function lastCheck(es: any[]): string | null {
  const pending = new Map<string, string>();
  let last: { cmd: string; ok: boolean; line: string } | null = null;
  for (const e of es) {
    if (!e || e.isSidechain) continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (e.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') {
        const cmd = b.input.command.replace(/^\s*cd\s+[^&;]+&&\s*/, '').trim();
        if (cmd.length <= 140 && !cmd.includes('\n') && CHECK_CMD.test(cmd)) pending.set(b.id, cmd);
      } else if (e.type === 'user' && b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
        const cmd = pending.get(b.tool_use_id)!;
        pending.delete(b.tool_use_id);
        const out = resultText(b.content);
        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
        const bad = b.is_error === true || FAIL_OUT.test(out.replace(/\b0 failed\b/gi, ''));
        const line = bad ? lines.find((l) => FAIL_OUT.test(l)) || lines[0] || '' : lines.find((l) => PASS_LINE.test(l)) || '';
        last = { cmd, ok: !bad, line: oneLine(line, 110) };
      }
    }
  }
  if (!last) return null;
  return `Last check: \`${oneLine(last.cmd, 70)}\` → ${last.ok ? 'passed' : 'FAILED'}${last.line ? ` (${last.line})` : ''}`;
}

const CORRECTION = /^(?:no[,.!]?\s|nope|wrong|that'?s not|not like that|don'?t|do not|stop|never|always|instead|actually|i said|i meant|from now on|please don'?t)/i;
const SUBSTANTIVE = 25;

interface Block {
  pri: number;
  order: number;
  lines: string[];
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

  const header =
    `[grugbrain handoff: continuing work from a previous session in ${path.basename(cwd)} (its context was ${Math.round(ctx.tokens / 1000)}k tokens; not loaded). ` +
    `Pick up from here; check files before assuming, and ask the user if something is unclear.]`;
  const footer = 'Need an exact detail from before (an error, a decision, a snippet)? Search the full earlier conversation with the grugbrain `history` tool instead of guessing.';

  // The current task is the latest substantive request, not the first message (which may be long gone).
  const substantive = prompts.filter((p) => !isTrivialPrompt(p.text) && p.text.trim().length >= SUBSTANTIVE);
  const current = substantive[substantive.length - 1] || prompts[prompts.length - 1];
  const first = prompts[0];
  const facts = buf.flatMap((e) => (e.t === 'facts' ? e.items || [] : []));
  const factLines = (kinds: string[], n: number) => {
    const seen: string[] = [];
    for (const f of facts.slice().reverse()) {
      if (!kinds.includes(f.kind) || seen.some((x) => similarity(x, f.text) >= 0.6)) continue;
      seen.push(f.text);
      if (seen.length >= n) break;
    }
    return seen.reverse();
  };
  const prefs = factLines(['preference'], 4);
  for (const p of prompts.slice(-12)) {
    const t = p.text.trim().split(/\n/)[0];
    if (t.length >= 15 && t.length <= 200 && CORRECTION.test(t) && !t.endsWith('?') && !prefs.some((x) => similarity(x, t) >= 0.5)) prefs.push(`User: ${oneLine(t, 180)}`);
  }

  const blocks: Block[] = [];
  const block = (pri: number, order: number, lines: string[]) => lines.length && blocks.push({ pri, order, lines });
  if (current) block(1, 1, [`Goal: ${oneLine(current.text, 320)}`]);
  if (first && current && first !== current && !isTrivialPrompt(first.text)) block(8, 2, [`Started with: ${oneLine(first.text, 140)}`]);
  block(2, 3, prefs.length ? ['Rules from the user (keep following them):', ...prefs.slice(-5).map((x) => `- ${oneLine(x, 180)}`)] : []);
  const todos = openTodos(es);
  block(3, 4, todos.length ? ['Open todos:', ...todos.slice(0, 10).map((t) => `- ${t}`)] : []);
  const check = lastCheck(es);
  block(3, 5, check ? [check] : []);
  // Prefer the last substantive replies over one-line progress notes; the newest gets the most room.
  const subst = replies.filter((r) => r.trim().length >= 160);
  const last = (subst.length ? subst : replies).slice(-2);
  block(4, 6, last.length ? ['Where it got to (last replies):', ...last.map((r, i) => `> ${oneLine(r, i === last.length - 1 ? 700 : 350)}`)] : []);
  const dec = factLines(['decision', 'cause'], 4);
  block(5, 7, dec.length ? ['Decisions and causes so far:', ...dec.map((x) => `- ${oneLine(x, 200)}`)] : []);
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  block(6, 8, edited.size ? [`Files changed: ${top(edited).slice(0, 15).join(', ')}`] : []);
  const recent = substantive.filter((p) => p !== current).slice(-3);
  block(7, 9, recent.length ? ['Earlier requests:', ...recent.map((p) => `- ${oneLine(p.text, 200)}`)] : []);
  block(9, 10, cmds.length ? [`Recent commands: ${[...new Set(cmds.slice(-8))].join(' · ')}`] : []);
  const readOnly = top(read).filter((f) => !edited.has(f));
  block(10, 11, readOnly.length ? [`Files read: ${readOnly.slice(0, 12).join(', ')}`] : []);

  // Fill by priority within the budget (a block that does not fit is skipped; smaller ones below may), then show in reading order.
  let used = estimateTokens(header + '\n' + footer);
  const chosen: Block[] = [];
  for (const b of blocks.sort((x, y) => x.pri - y.pri || x.order - y.order)) {
    const cost = estimateTokens(b.lines.join('\n') + '\n');
    if (used + cost > maxTokens) continue;
    used += cost;
    chosen.push(b);
  }
  chosen.sort((x, y) => x.order - y.order);
  const lines = [header, ...chosen.flatMap((b) => b.lines), footer];
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
