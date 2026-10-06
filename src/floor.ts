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

/** Room kept between the start floor and the window: Claude Code compacts ~30k below the window, plus a few turns of growth. */
export const FLOOR_MARGIN = 80000;
const KEEP_MS = 14 * 86400000;
const MAX_READ = 16 * 1024 * 1024;
const MAX_WINDOW = 1000000;
/** A lean request lists ~49 tools (the rest deferred); one with tool search off lists ~200. */
const FULL_TOOLS = 100;

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

/** Per project: p90 of start contexts and thrash stops in the last 14 days, biggest first. */
export function projectFloors(db: FloorDb = loadDb(), now = Date.now()): ProjectFloor[] {
  const by = new Map<string, { ctx: number[]; thrash: number; full: number }>();
  for (const f of Object.values(db.files)) {
    const p = by.get(f.project) || { ctx: [], thrash: 0, full: 0 };
    p.ctx.push(...f.samples.filter((s) => s.ts > now - KEEP_MS).map((s) => s.ctx));
    p.thrash += f.thrash.filter((t) => t > now - KEEP_MS).length;
    p.full += (f.full || []).filter((t) => t > now - KEEP_MS).length;
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
  if (size < st.offset) Object.assign(st, { offset: 0, pending: true, samples: [], thrash: [], full: [] }); // rewritten
  db.files[file] = st;
  if (size === st.offset) return;
  // A first look at a big old transcript: its tail is enough (recent compactions are what matter).
  if (st.offset === 0 && size > MAX_READ) st.offset = size - MAX_READ;
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
    if (!boundary && !thrash && !snapshot && !line.includes('"usage"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!st.project && typeof e?.cwd === 'string') st.project = path.basename(e.cwd);
    const ts = Date.parse(e?.timestamp) || Date.now();
    if (e?.type === 'attachment' && e.attachment?.type === 'prompt_snapshot') {
      if (!e.isSidechain && Array.isArray(e.attachment.tools) && e.attachment.tools.length > FULL_TOOLS) (st.full ||= []).push(ts);
      continue;
    }
    if (e?.type === 'system' && e.subtype === 'compact_boundary') {
      st.pending = true;
      continue;
    }
    if (e?.type !== 'assistant' || e.isSidechain) continue;
    if (thrash && e.isApiErrorMessage) {
      st.thrash.push(ts);
      continue;
    }
    const u = e.message?.usage;
    const ctx = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0;
    if (!st.pending || ctx <= 0) continue;
    st.samples.push({ ts, ctx });
    st.pending = false;
  }
  const cut = Date.now() - KEEP_MS;
  st.samples = st.samples.filter((s) => s.ts > cut).slice(-200);
  st.thrash = st.thrash.filter((t) => t > cut).slice(-50);
  st.full = (st.full || []).filter((t) => t > cut).slice(-200);
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

/**
 * The window grug writes: the configured one, raised to floor + FLOOR_MARGIN (rounded up to 10k)
 * when sessions start too close to it. 0 (Claude Code's default) is left alone.
 */
export function effectiveWindow(cfg: GrugConfig): { window: number; configured: number; floor: number; project: string; raised: boolean } {
  const configured = cfg.autoCompact.windowTokens;
  const f = measuredFloor();
  if (configured <= 0 || !cfg.autoCompact.guard || !f.tokens) return { window: configured, configured, floor: f.tokens, project: f.project, raised: false };
  const need = Math.min(MAX_WINDOW, Math.ceil((f.tokens + FLOOR_MARGIN) / 10000) * 10000);
  return { window: Math.max(configured, need), configured, floor: f.tokens, project: f.project, raised: need > configured };
}
