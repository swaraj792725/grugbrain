/**
 * Conversation history on demand: search this project's earlier Claude Code conversations
 * (full transcripts on disk) and return only the matching excerpts. After auto-compaction or
 * /clear, Claude fetches exact details (an error, a decision, a snippet) instead of carrying
 * the whole old context in every request.
 *
 * Parsed transcripts are cached per file under ~/.grug/cache/history, keyed by size + mtime.
 * Transcripts are append-only, so a grown file is parsed from where the cache stopped.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { paths, userHome, writeJsonAtomic } from './config.js';
import { estimateTokens } from './tokens.js';
import { queryTerms, rankPrompt, Ranked } from './relevance.js';
import { archiveOnlyFiles } from './archive.js';

export function projectTranscriptDir(cwd: string): string {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  return path.join(root, path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-'));
}

export interface Item {
  ts: number;
  who: string;
  text: string;
}

interface CachedFile {
  v: 2;
  size: number;
  mtime: number;
  /** Byte offset up to which complete lines were parsed. */
  offset: number;
  items: Item[];
}

const CACHE_V = 2;
const MAX_TEXT = 3000;
const MAX_TOOL_TEXT = 1200;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 25;
/** `history` tool: live transcripts plus this many archived sessions whose transcript is gone. */
const DEEP_FILES = 300;
// Text grug itself injected, or harness chatter: never worth recalling.
const NOISE = /^\s*(\[grugbrain |<system-reminder>|<command-(name|message|args)>|<local-command-stdout>|Caveat: The messages below)/;

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) : s;
}

function blocksText(content: any, who: string, out: Item[], ts: number) {
  const push = (w: string, t: string, max: number) => {
    if (!t || t.length < 12 || NOISE.test(t)) return;
    out.push({ ts, who: w, text: clip(t, max) });
  };
  if (typeof content === 'string') return push(who, content, MAX_TEXT);
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && b.text) push(who, b.text, MAX_TEXT);
    else if (b.type === 'tool_use') push(`Claude → ${b.name}`, JSON.stringify(b.input || {}), MAX_TOOL_TEXT);
    else if (b.type === 'tool_result') {
      const c = b.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : '';
      push('tool result', t, MAX_TOOL_TEXT);
    }
  }
}

function parseLines(text: string, items: Item[]) {
  for (const l of text.split('\n')) {
    if (!l || l[0] !== '{') continue;
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.isSidechain || e.isMeta) continue;
    const ts = Date.parse(e.timestamp) || 0;
    if (e.type === 'user') blocksText(e.message?.content, 'you', items, ts);
    else if (e.type === 'assistant') blocksText(e.message?.content, 'Claude', items, ts);
  }
}

function readRange(file: string, from: number, to: number): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, to - from));
    fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function cachePath(file: string): string {
  const h = createHash('sha1').update(path.resolve(file)).digest('hex').slice(0, 16);
  return path.join(paths.cache(), 'history', `${h}.json`);
}

/**
 * Parsed items of one transcript, from cache when unchanged, parsing only appended bytes when grown.
 * `allowParse=false` returns null instead of doing any parsing (used when the time budget is spent).
 */
export function transcriptItems(file: string, allowParse = true): Item[] | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return [];
  }
  const cp = cachePath(file);
  let cached: CachedFile | null = null;
  try {
    const c = JSON.parse(fs.readFileSync(cp, 'utf8'));
    if (c && c.v === CACHE_V && Array.isArray(c.items)) cached = c;
  } catch {
    /* no cache yet */
  }
  if (cached && cached.size === st.size && cached.mtime === st.mtimeMs) return cached.items;
  if (!allowParse) return cached ? cached.items : null;
  try {
    const grown = !!cached && st.size > cached.size && cached.offset <= st.size;
    const items: Item[] = grown ? cached!.items : [];
    const from = grown ? cached!.offset : Math.max(0, st.size - MAX_BYTES);
    let text = readRange(file, from, st.size);
    if (from > 0 && !grown) text = text.slice(text.indexOf('\n') + 1); // started mid-line
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
    parseLines(complete, items);
    const offset = st.size - Buffer.byteLength(text.slice(lastNl + 1), 'utf8');
    try {
      writeJsonAtomic(cachePath(file), { v: CACHE_V, size: st.size, mtime: st.mtimeMs, offset, items } satisfies CachedFile);
    } catch {
      /* cache is best-effort */
    }
    return items;
  } catch {
    return cached ? cached.items : [];
  }
}

/** Newest transcripts of a project (most recent first). */
export function projectTranscripts(cwd: string, max = MAX_FILES, deep = false): string[] {
  const live = liveTranscripts(cwd, max);
  return deep ? [...live, ...archiveOnlyFiles(cwd, DEEP_FILES)] : live;
}

function liveTranscripts(cwd: string, max: number): string[] {
  const dir = projectTranscriptDir(cwd);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const p = path.join(dir, f);
        let m = 0;
        try {
          m = fs.statSync(p).mtimeMs;
        } catch {
          /* vanished */
        }
        return { p, m };
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, max)
      .map((x) => x.p);
  } catch {
    return [];
  }
}

/** Parse (or refresh) every recent transcript of a project into the cache. Used in the background. */
export function warmHistory(cwd: string): number {
  let n = 0;
  for (const f of projectTranscripts(cwd)) n += transcriptItems(f)?.length || 0;
  return n;
}

export interface HistoryHit extends Ranked {
  item: Item;
  file: string;
}

export interface HistoryOptions {
  /** Stop parsing uncached transcripts after this many ms (cached ones are always used). */
  budgetMs?: number;
  /** Skip this transcript (the current session: it is already in context)... */
  excludeFile?: string;
  /** ...except items older than this (what auto-compaction removed from context). */
  excludeFileBefore?: number;
  /** Also search the full archive (every past session, even after Claude Code deleted its transcript). For the on-demand `history` tool, not hooks. */
  deep?: boolean;
}

const DECISION = /\b(decided|decision|we chose|chose to|going with|settled on|root cause|caused by|the fix|fixed by|because|workaround|must not|never|always|convention)\b/i;

/** Rank earlier conversation items for a query. */
export function historyHits(cwd: string, query: string, opts: HistoryOptions = {}): { hits: HistoryHit[]; terms: string[]; files: number; partial: boolean } {
  const terms = queryTerms(query);
  const files = projectTranscripts(cwd, opts.deep ? 100 : MAX_FILES, !!opts.deep);
  if (!terms.length || !files.length) return { hits: [], terms, files: files.length, partial: false };
  const deadline = opts.budgetMs ? Date.now() + opts.budgetMs : 0;
  const all: Array<{ item: Item; file: string }> = [];
  let partial = false;
  const excl = opts.excludeFile ? path.resolve(opts.excludeFile) : '';
  for (const f of files) {
    const isCurrent = excl && path.resolve(f) === excl;
    if (isCurrent && !opts.excludeFileBefore) continue;
    const items = transcriptItems(f, !deadline || Date.now() < deadline);
    if (!items) {
      partial = true;
      continue;
    }
    for (const item of items) {
      if (isCurrent && !(item.ts && item.ts < opts.excludeFileBefore!)) continue;
      all.push({ item, file: f });
    }
  }
  const docs = all.map((x) => x.item.text.toLowerCase());
  const now = Date.now();
  const weights = all.map(({ item }) => {
    let w = item.who === 'you' ? 1.35 : item.who === 'Claude' ? 1 : item.who === 'tool result' ? 0.6 : 0.5;
    if (item.who !== 'tool result' && DECISION.test(item.text)) w *= 1.25;
    const ageDays = item.ts ? Math.max(0, now - item.ts) / 86400000 : 30;
    return w * (1 + 0.15 * Math.exp(-ageDays / 7));
  });
  const hits = rankPrompt(docs, query, weights).map((r) => ({ ...r, item: all[r.index].item, file: all[r.index].file }));
  return { hits, terms, files: files.length, partial };
}

export function ago(ts: number): string {
  if (!ts) return '?';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  if (m < 2880) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

/** A readable excerpt of `len` chars around the best match. */
export function excerpt(h: HistoryHit, len = 600): string {
  const start = Math.max(0, h.pos - Math.round(len / 3));
  const body = h.item.text.slice(start, start + len).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${start + len < h.item.text.length ? '…' : ''}`;
}

export function searchHistory(cwd: string, query: string, maxTokens = 2500, maxResults = 10): string {
  if (!fs.existsSync(projectTranscriptDir(cwd)) && !archiveOnlyFiles(cwd, 1).length) return `No earlier Claude Code conversations found for ${cwd}.`;
  const { hits, terms } = historyHits(cwd, query, { deep: true });
  if (!terms.length) return 'Give a more specific query (a filename, error text, function name or topic).';
  if (!hits.length) return `Nothing in this project's earlier conversations matches "${query}".`;

  const lines = [`[grugbrain history: best matches for "${query}" in earlier conversations of this project]`];
  const seen = new Set<string>();
  for (const h of hits) {
    if (lines.length > maxResults) break;
    const ex = excerpt(h);
    const key = ex.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const line = `- ${ago(h.item.ts)} · ${h.item.who}: ${ex}`;
    if (estimateTokens(lines.join('\n') + line) > maxTokens) break;
    lines.push(line);
  }
  return lines.join('\n');
}
