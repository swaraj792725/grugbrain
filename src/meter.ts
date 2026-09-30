/**
 * Transcript metering: real per-reply token usage read from Claude Code's session transcript.
 * Works where the proxy can't see traffic (e.g. the Claude desktop app's Code tab, which manages
 * its own API connection). Called from the Stop / SessionEnd / PreCompact hooks.
 *
 * - Reads only the bytes appended since the last call (offset kept per session).
 * - A reply appears once per content block with identical usage: de-duplicated by message id.
 * - If the proxy already recorded calls in the same time window, nothing is recorded here,
 *   so the same traffic is never counted twice.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { loadConfig, userHome } from './config.js';
import { ensureDir, paths, readJson, writeJsonAtomic } from './config.js';
import { readRequests, recordRequest } from './stats.js';
import { Usage } from './tokens.js';

interface MeterState {
  offset: number;
  ids: string[];
  /** Context size of the previous main-chain reply in this transcript. */
  prevCtx?: number;
  /** Tokens auto-compaction removed so far (the chat would be this much bigger without it). */
  carry?: number;
}

/** Context a reply read: fresh + cached input. */
function ctxOf(u: Usage): number {
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
}

/**
 * Smaller-chat credit for one reply. A compaction is a big drop in context that starts near the
 * window grug set (so it is grug's auto-compaction, not a /compact you typed at a random size).
 * The chat would have stayed that much bigger, up to the size you typically run at.
 * Returns the tokens of context that reply did not have to re-read.
 */
export function ctxCut(st: { prevCtx?: number; carry?: number }, ctx: number, window: number, baseline: number): number {
  const prev = st.prevCtx || 0;
  if (window > 0 && prev >= 50000 && ctx <= prev * 0.6 && prev >= window * 0.5 && prev <= window * 1.35) {
    st.carry = (st.carry || 0) + (prev - ctx);
  }
  st.prevCtx = ctx;
  const carry = st.carry || 0;
  if (carry <= 0 || baseline <= 0) return 0;
  return Math.max(0, Math.min(ctx + carry, baseline) - ctx);
}

const MAX_READ = 16 * 1024 * 1024;

// Keyed by transcript path, so the Stop hook and the background scan share one offset per file.
const stateFile = (transcript: string) =>
  path.join(paths.home(), 'meter', `${createHash('sha1').update(path.resolve(transcript)).digest('hex').slice(0, 20)}.json`);

export interface MeterResult {
  replies: number;
  recorded: number;
  skippedProxy: number;
}

/** Meter a session transcript and the transcripts of the subagents it launched (separate files, same spend). */
export function meterTranscript(sessionId: string, transcriptPath: string | undefined, project?: string): MeterResult {
  const total = meterFile(sessionId, transcriptPath, project);
  if (!transcriptPath) return total;
  const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return total;
  }
  for (const f of files) {
    const r = meterFile(sessionId, path.join(dir, f), project);
    total.replies += r.replies;
    total.recorded += r.recorded;
    total.skippedProxy += r.skippedProxy;
  }
  return total;
}

function meterFile(_sessionId: string, transcriptPath: string | undefined, project?: string): MeterResult {
  const res: MeterResult = { replies: 0, recorded: 0, skippedProxy: 0 };
  if (!transcriptPath) return res;
  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return res;
  }
  const r = readJson<MeterState>(stateFile(transcriptPath));
  const st: MeterState = r.ok && r.value && typeof r.value.offset === 'number' ? r.value : { offset: 0, ids: [] };
  if (size < st.offset) st.offset = 0; // transcript rewritten
  if (size === st.offset) return res;

  const len = Math.min(size - st.offset, MAX_READ);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buf, 0, len, st.offset);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return res; // partial line only; wait for more
  const complete = text.slice(0, lastNl);

  const seen = new Set(st.ids);
  const replies = new Map<string, { model: string; usage: Usage; ts: number; side: boolean }>();
  for (const line of complete.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e?.message;
    if (e?.type !== 'assistant' || !m?.id || !m.usage || seen.has(m.id)) continue;
    replies.set(m.id, { model: m.model || '', usage: m.usage, ts: Date.parse(e.timestamp) || Date.now(), side: e.isSidechain === true });
  }
  st.offset += Buffer.byteLength(complete, 'utf8') + 1;
  res.replies = replies.size;

  if (replies.size) {
    const first = Math.min(...[...replies.values()].map((x) => x.ts));
    // Proxy already saw calls in this window? Then it counted this traffic; don't double count.
    const proxied = readRequests().some((q) => !q.tag && q.source !== 'transcript' && q.ts >= first - 60000);
    const cfg = loadConfig();
    const window = cfg.autoCompact.windowTokens;
    const baseline = cfg.savings.baselineContextTokens;
    const ordered = [...replies.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [id, rep] of ordered) {
      seen.add(id);
      const cut = rep.side ? 0 : ctxCut(st, ctxOf(rep.usage), window, baseline);
      if (proxied) {
        res.skippedProxy++;
        continue;
      }
      recordRequest({
        ts: rep.ts,
        model: rep.model,
        usage: {
          input_tokens: rep.usage.input_tokens,
          output_tokens: rep.usage.output_tokens,
          cache_read_input_tokens: rep.usage.cache_read_input_tokens,
          cache_creation_input_tokens: rep.usage.cache_creation_input_tokens,
          cache_creation: rep.usage.cache_creation
        },
        status: 200,
        trimmedTokens: 0,
        cacheBreakpointsAdded: 0,
        ...(cut > 0 && !proxied ? { ctxCutTokens: cut } : {}),
        project,
        source: 'transcript',
        ...(process.env.GRUG_TAG ? { tag: process.env.GRUG_TAG } : {})
      });
      res.recorded++;
    }
  }
  ensureDir(path.dirname(stateFile(transcriptPath)));
  writeJsonAtomic(stateFile(transcriptPath), { offset: st.offset, ids: [...seen].slice(-3000), prevCtx: st.prevCtx, carry: st.carry });
  return res;
}

/** Catch up on every Claude Code transcript touched recently (covers missed or timed-out hooks). */
export function meterRecent(maxAgeMs = 24 * 3600 * 1000): MeterResult {
  const total: MeterResult = { replies: 0, recorded: 0, skippedProxy: 0 };
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return total;
  }
  const cutoff = Date.now() - maxAgeMs;
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
        if (fs.statSync(full).mtimeMs < cutoff) continue;
      } catch {
        continue;
      }
      // Project label: last segment of the encoded project dir (e.g. -Users-me-code-app -> app).
      const r = meterTranscript('', full, d.split('-').filter(Boolean).pop());
      total.replies += r.replies;
      total.recorded += r.recorded;
      total.skippedProxy += r.skippedProxy;
    }
  }
  return total;
}

