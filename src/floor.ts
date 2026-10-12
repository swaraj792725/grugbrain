/**
 * Start floor: how big a session's context is on its first reply, and on the first reply after
 * each compaction. Compaction cannot go below it, so an auto-compact window too close to it makes
 * Claude Code compact again right away ("Autocompact is thrashing", then "context window is full").
 *
 * Measured 2026-10-06 (desktop Code tab): the first request of a session (or of a reopened one)
 * carries every tool definition in full, ~95-110k more than later requests. seamless-assist-ai
 * started at 175-181k; with a 200k window (compaction near ~170k) every compaction refilled at once.
 *
 * Reads only the bytes appended since the last call, like meter.ts. State: ~/.grug/floor.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GrugConfig, ensureDir, paths, readJson, userHome, writeJsonAtomic } from './config.js';
import { toolSearchForcedSince } from './toolsearch.js';
import { CACHE_READ_MULT, CACHE_WRITE_1H_MULT, CACHE_WRITE_MULT, priceFor } from './tokens.js';

/** Room kept between the start floor and the window: Claude Code compacts ~30k below the window, plus a few turns of growth. */
export const FLOOR_MARGIN = 80000;
const KEEP_MS = 14 * 86400000;
const MAX_READ = 16 * 1024 * 1024;
const MAX_WINDOW = 1000000;
/** A lean request lists ~49 tools (the rest deferred); one with tool search off lists ~200. */
const FULL_TOOLS = 100;
/** Claude Code compacts this far below the window (13k buffer + 20k output reserve; measured: a 260k window topped out at ~227k). */
export const COMPACT_BELOW = 33000;
const DAY = 86400000;

/** Per-day sums for the auto window: [replies, growth steps, growth tokens, compactions, context after compaction,
 * cache write after compaction, summary chars, 1h-tier write tokens, 5m-tier write tokens]. */
type Agg = number[];
const AGG_LEN = 9;

interface FileState {
  offset: number;
  /** The next main-chain reply starts a session or follows a compaction. */
  pending: boolean;
  project: string;
  at: number;
  samples: { ts: number; ctx: number }[];
  /** Times Claude Code stopped with "Autocompact is thrashing". */
  thrash: number[];
  /** Requests that inlined every tool schema (tool search off: prompt_snapshot with > FULL_TOOLS tools). */
  full?: number[];
  /** Context of the last main-chain reply (0 after a compaction: growth is not counted across it). */
  last?: number;
  lastId?: string;
  /** The next main-chain reply is the first after a compaction. */
  post?: boolean;
  model?: string;
  agg?: Record<string, Agg>;
}

interface FloorDb {
  files: Record<string, FileState>;
  /** Highest per-project start floor (p90) in the last 14 days. */
  tokens: number;
  project: string;
}

export interface ProjectFloor {
  project: string;
  floor: number;
  samples: number;
  thrash: number;
  /** Requests in 14 days that carried every tool schema (see toolsearch.ts). */
  full: number;
}

const dbFile = () => path.join(paths.home(), 'floor.json');

function loadDb(): FloorDb {
  const r = readJson<FloorDb>(dbFile());
  return r.ok && r.value && typeof r.value.files === 'object' ? r.value : { files: {}, tokens: 0, project: '' };
}

const p90 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.ceil(s.length * 0.9) - 1)];
};

/**
 * Start of the data that still describes this setup: 14 days back, or the moment tool search was forced
 * on (the managed file's mtime) if later. Before it, sessions that carried every tool schema started
 * ~100k higher and compacted in loops; that cannot happen again, so it must not size the window.
 */
export function dataSince(now = Date.now()): number {
  return Math.max(now - KEEP_MS, toolSearchForcedSince());
}

/** Whole days covered by dataSince(), for labels. */
export function dataDays(now = Date.now()): number {
  return Math.max(1, Math.round((now - dataSince(now)) / DAY));
}

/** Per project: p90 of start contexts and thrash stops since dataSince(), biggest first. */
export function projectFloors(db: FloorDb = loadDb(), now = Date.now(), since = dataSince(now)): ProjectFloor[] {
  const by = new Map<string, { ctx: number[]; thrash: number; full: number }>();
  for (const f of Object.values(db.files)) {
    const p = by.get(f.project) || { ctx: [], thrash: 0, full: 0 };
    p.ctx.push(...f.samples.filter((s) => s.ts > since).map((s) => s.ctx));
    p.thrash += f.thrash.filter((t) => t > since).length;
    p.full += (f.full || []).filter((t) => t > since).length;
    by.set(f.project, p);
  }
  return [...by.entries()]
    .filter(([, p]) => p.ctx.length)
    .map(([project, p]) => ({ project, floor: p90(p.ctx), samples: p.ctx.length, thrash: p.thrash, full: p.full }))
    .sort((a, b) => b.floor - a.floor);
}

function scanFile(db: FloorDb, file: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return;
  }
  const st: FileState = db.files[file] || { offset: 0, pending: true, project: '', at: 0, samples: [], thrash: [] };
  // Rewritten, or scanned by a grug before the auto-window stats (v2.30): read it again from the start.
  if (size < st.offset || !st.agg) Object.assign(st, { offset: 0, pending: true, samples: [], thrash: [], full: [], last: 0, post: false, agg: {} });
  db.files[file] = st;
  if (size === st.offset) return;
  // A first look at a big old transcript: its tail is enough (recent compactions are what matter).
  // Starting mid-session, the first reply seen is not a start: wait for the next compaction.
  if (st.offset === 0 && size > MAX_READ) Object.assign(st, { offset: size - MAX_READ, pending: false, post: false, last: 0 });
  const len = Math.min(size - st.offset, MAX_READ);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, len, st.offset);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return;
  const complete = text.slice(0, lastNl);
  st.offset += Buffer.byteLength(complete, 'utf8') + 1;
  st.at = Date.now();
  for (const line of complete.split('\n')) {
    const boundary = line.includes('"compact_boundary"');
    const thrash = line.includes('Autocompact is thrashing');
    const snapshot = line.includes('"prompt_snapshot"');
    const summary = line.includes('"isCompactSummary"');
    if (!boundary && !thrash && !snapshot && !summary && !line.includes('"usage"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!st.project && typeof e?.cwd === 'string') st.project = path.basename(e.cwd);
    const ts = Date.parse(e?.timestamp) || Date.now();
    const day = String(Math.floor(ts / DAY));
    const agg = () => ((st.agg ||= {})[day] ||= new Array(AGG_LEN).fill(0));
    if (e?.type === 'attachment' && e.attachment?.type === 'prompt_snapshot') {
      if (!e.isSidechain && Array.isArray(e.attachment.tools) && e.attachment.tools.length > FULL_TOOLS) {
        (st.full ||= []).push(ts);
      }
      continue;
    }
    if (e?.type === 'system' && e.subtype === 'compact_boundary') {
      st.pending = true;
      st.post = true;
      st.last = 0;
      agg()[3]++;
      continue;
    }
    if (e?.type === 'user' && e.isCompactSummary && !e.isSidechain) {
      const c = e.message?.content;
      agg()[6] += typeof c === 'string' ? c.length : Array.isArray(c) ? c.reduce((n: number, b: any) => n + String(b?.text || '').length, 0) : 0;
      continue;
    }
    if (e?.type !== 'assistant' || e.isSidechain) continue;
    if (thrash && e.isApiErrorMessage) {
      st.thrash.push(ts);
      continue;
    }
    const u = e.message?.usage;
    const ctx = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;
    // One reply can span several transcript lines with the same message id and usage.
    if (ctx > 0 && e.message?.id !== st.lastId) {
      st.lastId = e.message?.id;
      const a = agg();
      a[0]++;
      if (st.last) {
        a[1]++;
        a[2] += Math.max(0, ctx - st.last);
      }
      if (st.post) {
        a[4] += ctx;
        a[5] += u.cache_creation_input_tokens || 0;
        st.post = false;
      }
      a[7] += u.cache_creation?.ephemeral_1h_input_tokens || 0;
      a[8] += u.cache_creation?.ephemeral_5m_input_tokens || 0;
      st.last = ctx;
      if (typeof e.message?.model === 'string' && !e.message.model.startsWith('<')) st.model = e.message.model;
    }
    if (!st.pending || ctx <= 0) continue;
    st.samples.push({ ts, ctx });
    st.pending = false;
  }
  const cut = Date.now() - KEEP_MS;
  st.samples = st.samples.filter((s) => s.ts > cut).slice(-200);
  st.thrash = st.thrash.filter((t) => t > cut).slice(-50);
  st.full = (st.full || []).filter((t) => t > cut).slice(-200);
  for (const d of Object.keys(st.agg || {})) if (Number(d) < Math.floor(cut / DAY)) delete st.agg![d];
  if (!st.project) st.project = path.basename(path.dirname(file));
}

function transcriptsSince(cutoff: number): string[] {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  const out: string[] = [];
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      const full = path.join(root, d, f);
      try {
        if (fs.statSync(full).mtimeMs >= cutoff) out.push(full);
      } catch {
        /* gone */
      }
    }
  }
  return out;
}

/**
 * Read new bytes of the given transcripts (default: every one touched in the last 14 days) and
 * recompute the floor. `changed` = the highest project floor moved.
 */
export function updateFloor(files?: (string | undefined)[], now = Date.now()): { tokens: number; project: string; changed: boolean } {
  const db = loadDb();
  const list = files ? files.filter((f): f is string => !!f) : transcriptsSince(now - KEEP_MS);
  for (const f of list) {
    try {
      scanFile(db, f);
    } catch {
      /* one bad file must not stop the rest */
    }
  }
  for (const [f, st] of Object.entries(db.files)) if (st.at < now - KEEP_MS && !list.includes(f)) delete db.files[f];
  const top = projectFloors(db, now)[0];
  const tokens = top?.floor || 0;
  const changed = tokens !== db.tokens;
  db.tokens = tokens;
  db.project = top?.project || '';
  ensureDir(paths.home());
  writeJsonAtomic(dbFile(), db);
  return { tokens, project: db.project, changed };
}

/** The highest start floor measured, without reading transcripts. */
export function measuredFloor(): { tokens: number; project: string } {
  const db = loadDb();
  return { tokens: db.tokens || 0, project: db.project || '' };
}

/** The smallest window that leaves FLOOR_MARGIN above a start floor, rounded up to 10k. */
export function floorNeed(floor: number): number {
  return Math.min(MAX_WINDOW, Math.ceil((floor + FLOOR_MARGIN) / 10000) * 10000);
}

export interface AutoWindow {
  /** Cheapest window under the model, rounded to 10k (before the floor guard). */
  best: number;
  /** Average context right after a compaction (the bottom of the sawtooth). */
  base: number;
  /** Average context growth per main-chain reply. */
  growth: number;
  /** One compaction in input-token units: cache re-write after it + the summary call (reads the context, writes the summary). */
  compactUnits: number;
  replies: number;
  compactions: number;
  /** Days of data the sums cover. */
  days: number;
  model: string;
  /** Context reads + compactions per reply, in input-token units, at window w. */
  unitsPerReply: (w: number) => number;
  /** $ per input token of the main model. */
  inputUsd: number;
}

const MIN_COMPACTIONS = 3;
const MIN_STEPS = 200;

/**
 * Pick the window from how the context really moves. Between compactions it climbs from `base` to
 * window - COMPACT_BELOW, so every reply reads ~(base + top) / 2 from the cache (0.1x input price)
 * and every compaction costs a re-write (1h tier: 2x) plus a summary call. Bigger window: dearer
 * reads, rarer compactions. Per reply: 0.1 * (base + gap / 2) + compaction * growth / gap.
 * Checked on 6 days of one user's transcripts: the model gives ~151k average context at 260k, measured 153k.
 * Pooled over projects: Claude Code takes one window for all of them. null until there is enough data.
 */
export function autoWindowModel(db: FloorDb = loadDb(), now = Date.now()): AutoWindow | null {
  const sum = new Array(AGG_LEN).fill(0);
  let model = '';
  let modelAt = 0;
  // Whole days after dataSince() (the day it falls in mixes both setups).
  const from = Math.ceil(dataSince(now) / DAY);
  for (const f of Object.values(db.files)) {
    for (const [d, a] of Object.entries(f.agg || {})) if (Number(d) >= from) for (let i = 0; i < AGG_LEN; i++) sum[i] += a[i] || 0;
    if (f.model && f.at > modelAt) [model, modelAt] = [f.model, f.at];
  }
  const [replies, steps, grow, compactions, afterCtx, rewrite, summaryChars, w1h, w5m] = sum;
  if (compactions < MIN_COMPACTIONS || steps < MIN_STEPS || !grow) return null;
  const base = afterCtx / compactions;
  const growth = grow / steps;
  const writeMult = w1h + w5m ? (w1h * CACHE_WRITE_1H_MULT + w5m * CACHE_WRITE_MULT) / (w1h + w5m) : CACHE_WRITE_1H_MULT;
  const price = priceFor(model);
  const outMult = price.output / price.input;
  const fixed = writeMult * (rewrite / compactions) + outMult * (summaryChars / compactions / 4);
  const unitsPerReply = (w: number) => {
    const top = w - COMPACT_BELOW;
    const gap = top - base;
    if (gap < 10000) return Infinity;
    return CACHE_READ_MULT * (base + gap / 2) + ((fixed + CACHE_READ_MULT * top) * growth) / gap;
  };
  let best = 0;
  for (let w = 100000; w <= MAX_WINDOW; w += 10000) if (!best || unitsPerReply(w) < unitsPerReply(best)) best = w;
  return {
    best,
    base,
    growth,
    compactUnits: fixed + CACHE_READ_MULT * (best - COMPACT_BELOW),
    replies,
    compactions,
    days: Math.max(1, (now - from * DAY) / DAY),
    model,
    unitsPerReply,
    inputUsd: price.input / 1e6
  };
}

/**
 * The window grug writes: the configured one (or, with autoCompact.auto, the cheapest one for how the
 * context really grows), raised to floor + FLOOR_MARGIN (rounded up to 10k) when sessions start too
 * close to it. 0 (Claude Code's default) is left alone.
 */
export function effectiveWindow(cfg: GrugConfig): {
  window: number;
  configured: number;
  floor: number;
  project: string;
  raised: boolean;
  auto: AutoWindow | null;
} {
  const configured = cfg.autoCompact.windowTokens;
  const db = loadDb();
  const f = { tokens: db.tokens || 0, project: db.project || '' };
  if (configured <= 0) return { window: configured, configured, floor: f.tokens, project: f.project, raised: false, auto: null };
  const auto = cfg.autoCompact.auto ? autoWindowModel(db) : null;
  const want = auto ? auto.best : configured;
  if (!cfg.autoCompact.guard || !f.tokens) return { window: want, configured, floor: f.tokens, project: f.project, raised: false, auto };
  const need = floorNeed(f.tokens);
  return { window: Math.max(want, need), configured, floor: f.tokens, project: f.project, raised: need > want, auto };
}
