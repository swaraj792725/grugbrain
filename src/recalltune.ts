/**
 * Did the recall help? A code hint counts as used when Claude then reads or edits the hinted file
 * in the same session (built-in tools or grug's outline/read_symbol/read_lines). Scored at
 * PreCompact/SessionEnd, kept in ~/.grug/recall-tune.json, and used to tune how strict the
 * relevance gate is: hints that are mostly ignored raise the bar (less noise in context), hints
 * that are mostly used lower it. Bounded, slow-moving, and shown in `grug dash` / `grug doctor`.
 */

import * as path from 'node:path';
import { paths, readJson, writeJsonAtomic } from './config.js';
import { appendBuffer, readBuffer } from './memory/store.js';

export interface RecallTune {
  /** Recalls that carried code hints, and how many of those had a hinted file used afterwards (decayed). */
  codeShown: number;
  codeHit: number;
  /** Multiplier on the relevance bar for code hints and earlier-session excerpts (1 = default). */
  strictness: number;
}

export const STRICT_MIN = 0.8;
export const STRICT_MAX = 1.6;
const MIN_SAMPLE = 10;
const WINDOW = 60;

const file = () => path.join(paths.home(), 'recall-tune.json');
/** v2: shell reads count as hint use. Older files were scored without them (biased strict), so they start over. */
const TUNE_VERSION = 2;

export function loadTune(): RecallTune {
  const r = readJson<Partial<RecallTune> & { v?: number }>(file());
  const v = r.ok && r.value?.v === TUNE_VERSION ? r.value : {};
  const num = (x: any, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d);
  return {
    codeShown: num(v.codeShown, 0),
    codeHit: num(v.codeHit, 0),
    strictness: Math.min(STRICT_MAX, Math.max(STRICT_MIN, num(v.strictness, 1)))
  };
}

/** New strictness after a sample: steps of 0.1, only with enough evidence, clamped. */
export function nextStrictness(t: RecallTune): number {
  if (t.codeShown < MIN_SAMPLE) return t.strictness;
  const rate = t.codeHit / t.codeShown;
  let s = t.strictness;
  if (rate < 0.2) s += 0.1;
  else if (rate > 0.5) s -= 0.1;
  return Math.round(Math.min(STRICT_MAX, Math.max(STRICT_MIN, s)) * 100) / 100;
}

/** Score this session's recalls that have not been scored yet; returns {shown, hit} for them. */
export function scoreRecalls(sessionId: string, cwd: string): { shown: number; hit: number } {
  const events = readBuffer(sessionId);
  let scoredTo = 0;
  for (const e of events) if (e.t === 'scored') scoredTo = Math.max(scoredTo, e.ts);
  const root = path.resolve(cwd);
  const touched = events.filter((e) => e.t === 'file').map((e: any) => ({ ts: e.ts as number, rel: path.isAbsolute(e.path) ? path.relative(root, e.path) : e.path }));
  let shown = 0;
  let hit = 0;
  let last = scoredTo;
  for (const e of events) {
    if (e.t !== 'recall' || e.ts <= scoredTo || !e.files?.length) continue;
    shown++;
    last = Math.max(last, e.ts);
    if (touched.some((t) => t.ts >= e.ts && e.files!.includes(t.rel))) hit++;
  }
  if (!shown) return { shown, hit };
  const t = loadTune();
  t.codeShown += shown;
  t.codeHit += hit;
  if (t.codeShown > WINDOW) {
    t.codeShown /= 2; // keep the evidence recent
    t.codeHit /= 2;
  }
  t.strictness = nextStrictness(t);
  writeJsonAtomic(file(), { ...t, v: TUNE_VERSION });
  appendBuffer(sessionId, { t: 'scored', ts: last });
  return { shown, hit };
}
