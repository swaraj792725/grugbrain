/**
 * Append-only event logs that feed the dashboard.
 *  - events.jsonl: one line per proxied API request (real usage numbers).
 *  - activity.jsonl: one line per thing grug did (trimmed output, blocked read, memory brief, ...).
 */

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { ensureDir, paths } from './config.js';
import { cacheSavingsOf, CACHE_READ_MULT, costOf, priceFor, Usage } from './tokens.js';

const MAX_LOG_BYTES = 8 * 1024 * 1024;

export interface RequestEvent {
  ts: number;
  model: string;
  usage: Usage;
  status: number;
  /** Tokens removed from the request by grug transforms (estimate). */
  trimmedTokens: number;
  cacheBreakpointsAdded: number;
  fallback?: boolean;
  project?: string;
  /** Set for synthetic traffic (e.g. `grug bench`); excluded from dashboard totals. */
  tag?: string;
  /** Context tokens auto-compaction kept out of this reply versus the no-compaction baseline (derived from real context drops). */
  ctxCutTokens?: number;
  /** 'transcript' = measured from the session transcript (proxy not in the path). */
  source?: 'proxy' | 'transcript';
}

export type ActivityKind =
  | 'trim'
  | 'dedupe'
  | 'cache'
  | 'read-guard'
  | 'reread'
  | 'testsum'
  | 'cmdrules'
  | 'json'
  | 'cache-miss'
  | 'bench'
  | 'update'
  | 'context-alert'
  | 'idle-alert'
  | 'media'
  | 'nav'
  | 'task-shift'
  | 'history'
  | 'handoff'
  | 'subagent'
  | 'brief'
  | 'recall'
  | 'auto-recall'
  | 'graph'
  | 'facts'
  | 'remember'
  | 'consolidate'
  | 'outline'
  | 'fallback'
  | 'install'
  | 'error';

export interface Activity {
  ts: number;
  kind: ActivityKind;
  msg: string;
  /** Estimated tokens saved (positive) or spent (negative, e.g. a memory brief). */
  tokens?: number;
  project?: string;
  tag?: string;
}

function appendLine(file: string, obj: unknown): void {
  try {
    ensureDir(paths.home());
    try {
      if (fs.statSync(file).size > MAX_LOG_BYTES) fs.renameSync(file, file + '.1');
    } catch {
      /* no file yet */
    }
    fs.appendFileSync(file, JSON.stringify(obj) + '\n', 'utf8');
  } catch {
    // Stats must never break the caller.
  }
}

export function recordRequest(ev: RequestEvent): void {
  appendLine(paths.events(), ev);
}

export function recordActivity(a: Omit<Activity, 'ts'> & { ts?: number }): void {
  const tag = process.env.GRUG_TAG;
  appendLine(paths.activity(), { ts: Date.now(), ...a, ...(tag && a.kind !== 'bench' ? { tag } : {}) });
}

function readLines<T>(file: string, limit = 50000): T[] {
  const out: T[] = [];
  for (const f of [file + '.1', file]) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip torn line */
      }
    }
  }
  return out.slice(-limit);
}

export function readRequests(): RequestEvent[] {
  return readLines<RequestEvent>(paths.events());
}

export function readActivity(limit = 5000): Activity[] {
  return readLines<Activity>(paths.activity(), limit);
}

export interface Summary {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  cacheSavedUsd: number;
  /** Cache savings on requests where grug added the breakpoints (client had none). */
  grugCacheSavedUsd: number;
  /** Trimmed/deduped tokens valued once at the request's input price (estimate). */
  trimSavedUsd: number;
  /** Smaller chat from auto-compaction: tokens not re-read, and their cache-read price. */
  ctxCutTokens: number;
  ctxCutUsd: number;
  cacheHitRate: number;
  trimmedTokens: number;
  savedByKind: Record<string, number>;
  countByKind: Record<string, number>;
  byModel: Record<string, { requests: number; costUsd: number }>;
  byDay: Array<{ day: string; costUsd: number; savedUsd: number; requests: number }>;
  fallbacks: number;
}

export function summarize(sinceMs = 0): Summary {
  const reqs = readRequests().filter((r) => r.ts >= sinceMs && !r.tag);
  const acts = readActivity(50000).filter((a) => a.ts >= sinceMs && !a.tag);
  const s: Summary = {
    requests: reqs.length,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    cacheSavedUsd: 0,
    grugCacheSavedUsd: 0,
    trimSavedUsd: 0,
    ctxCutTokens: 0,
    ctxCutUsd: 0,
    cacheHitRate: 0,
    trimmedTokens: 0,
    savedByKind: {},
    countByKind: {},
    byModel: {},
    byDay: [],
    fallbacks: 0
  };
  const days = new Map<string, { costUsd: number; savedUsd: number; requests: number }>();
  for (const r of reqs) {
    const u = r.usage || {};
    s.inputTokens += u.input_tokens || 0;
    s.outputTokens += u.output_tokens || 0;
    s.cacheReadTokens += u.cache_read_input_tokens || 0;
    s.cacheWriteTokens += u.cache_creation_input_tokens || 0;
    const cost = costOf(r.model, u);
    const saved = cacheSavingsOf(r.model, u);
    s.costUsd += cost;
    s.cacheSavedUsd += saved;
    s.trimmedTokens += r.trimmedTokens || 0;
    if (r.cacheBreakpointsAdded > 0) s.grugCacheSavedUsd += saved;
    s.trimSavedUsd += ((r.trimmedTokens || 0) * priceFor(r.model).input) / 1e6;
    if (r.ctxCutTokens) {
      s.ctxCutTokens += r.ctxCutTokens;
      s.ctxCutUsd += (r.ctxCutTokens * priceFor(r.model).input * CACHE_READ_MULT) / 1e6;
    }
    if (r.fallback) s.fallbacks++;
    const m = (s.byModel[r.model || 'unknown'] ||= { requests: 0, costUsd: 0 });
    m.requests++;
    m.costUsd += cost;
    const day = new Date(r.ts).toISOString().slice(0, 10);
    const d = days.get(day) || { costUsd: 0, savedUsd: 0, requests: 0 };
    d.costUsd += cost;
    d.savedUsd += saved;
    d.requests++;
    days.set(day, d);
  }
  const totalIn = s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens;
  s.cacheHitRate = totalIn > 0 ? s.cacheReadTokens / totalIn : 0;
  for (const a of acts) {
    s.countByKind[a.kind] = (s.countByKind[a.kind] || 0) + 1;
    if (a.tokens) s.savedByKind[a.kind] = (s.savedByKind[a.kind] || 0) + a.tokens;
  }
  s.byDay = [...days.entries()].sort().map(([day, v]) => ({ day, ...v }));
  return s;
}

/**
 * Is Claude Code's traffic actually reaching the proxy? Hook sessions leave a buffer file per
 * session; proxied API calls land in events.jsonl. Sessions but zero calls = something else
 * (another proxy tool, an app-level setting) points Claude Code elsewhere.
 */
export function trafficCheck(sinceMs = Date.now() - 24 * 3600 * 1000): { sessions: number; requests: number; metered: number } {
  let sessions = 0;
  try {
    for (const f of fs.readdirSync(paths.sessions())) {
      try {
        if (fs.statSync(nodePath.join(paths.sessions(), f)).mtimeMs >= sinceMs) sessions++;
      } catch {
        /* vanished */
      }
    }
  } catch {
    /* no sessions yet */
  }
  const reqs = readRequests().filter((r) => r.ts >= sinceMs && !r.tag);
  const metered = reqs.filter((r) => r.source === 'transcript').length;
  return { sessions, requests: reqs.length - metered, metered };
}
