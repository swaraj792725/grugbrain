/**
 * `grug statusline`: the line Claude Code shows under the input box. It reads the session JSON
 * Claude Code pipes in and answers "what should the user do now to spend less": when to /clear,
 * when the prompt cache is about to expire, plus a rotating user-side tip when nothing is urgent.
 * Fast and side-effect free; any failure prints nothing so the status line never breaks.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, loadConfig, paths } from './config.js';
import { coldCacheCost, contextSize, costPerReply } from './handoff.js';
import { computeSavings } from './savings.js';

const useColor = !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const yellow = c('33');
const red = c('31');
const green = c('32');
const orange = c('38;5;208');

const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const usd = (n: number) => (n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);

export const TIPS = [
  'Tip: /clear between unrelated tasks; fresh context is cheaper per reply',
  'Tip: /model sonnet for routine edits and search, ~half the price',
  'Tip: use @path instead of pasting long logs or code',
  'Tip: Esc Esc rewinds a wrong turn instead of arguing with it',
  'Tip: /compact before a long break keeps a summary, drops the bulk',
  'Tip: ask for an outline or one symbol first, not the whole big file'
];

export interface LineInput {
  transcript_path?: string;
  model?: { id?: string; display_name?: string } | string;
}

/** Pure: build the notice from numbers so it can be tested. */
export function composeLine(o: {
  tokens: number;
  model: string;
  idleMs: number;
  oneHour: boolean;
  windowTokens: number;
  firstTokens: number;
  tips: boolean;
  now: number;
  savedPct?: number;
}): string {
  const parts: string[] = [];
  const base = o.tokens > 0 ? `ctx ${k(o.tokens)} · ${usd(costPerReply(o.tokens, o.model))}/reply` : '';
  const ttl = (o.oneHour ? 60 : 5) * 60000;
  const { cold, warm } = coldCacheCost(o.tokens, o.model, o.oneHour);
  const big = o.tokens >= 30000;
  const limit = o.windowTokens > 0 ? o.windowTokens * 0.8 : o.firstTokens;
  let alert = '';
  if (big && o.idleMs > ttl && cold - warm >= 0.05) {
    alert = red(`⏱ cache cold: next reply re-writes ${k(o.tokens)} (~${usd(cold)} vs ${usd(warm)}). New task? /clear first`);
  } else if (big && o.idleMs > ttl - 60000 && o.idleMs <= ttl) {
    alert = yellow(`⏱ cache expires in ${Math.max(1, Math.round((ttl - o.idleMs) / 1000))}s; idle longer = ${usd(cold)} next reply`);
  } else if (o.tokens >= limit * 1.2) {
    alert = red(`⚠ ${k(o.tokens)} context: /clear when this task is done (grug hands the work over, ~1k tokens)`);
  } else if (o.tokens >= limit) {
    alert = yellow(`⚠ context growing: /clear at the end of this task`);
  }
  if (base) parts.push(alert ? base : dim(base));
  if (alert) parts.push(alert);
  else if (o.tips) {
    const tips = TIPS.filter((t) => !(t.includes('/model sonnet') && /sonnet|haiku/i.test(o.model)));
    parts.push(dim(tips[Math.floor(o.now / 25000) % tips.length]));
  }
  if (o.savedPct !== undefined && o.savedPct > 0) parts.push(green(`saved ~${Math.round(o.savedPct * 100)}%`));
  return `${orange('🪨')} ${parts.join(dim(' │ '))}`;
}

function cachedSavedPct(now: number): number | undefined {
  const file = path.join(paths.cache(), 'statusline.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (now - j.ts < 60000) return j.pct;
  } catch {
    /* recompute */
  }
  try {
    const pct = computeSavings(now - 7 * 86400000).pct;
    ensureDir(paths.cache());
    fs.writeFileSync(file, JSON.stringify({ ts: now, pct }));
    return pct;
  } catch {
    return undefined;
  }
}

export function renderStatusLine(raw: string, now = Date.now()): string {
  const cfg = loadConfig();
  if (!cfg.statusLine.enabled) return '';
  let input: LineInput = {};
  try {
    input = JSON.parse(raw || '{}');
  } catch {
    /* no input */
  }
  let own = '';
  if (cfg.statusLine.wrap) {
    const r = spawnSync(cfg.statusLine.wrap, { input: raw, shell: true, encoding: 'utf8', timeout: 1500 });
    own = (r.stdout || '').split('\n')[0].trim();
  }
  let line = '';
  try {
    const cs = contextSize(input.transcript_path);
    const modelId = typeof input.model === 'string' ? input.model : input.model?.id || cs.model;
    line = composeLine({
      tokens: cs.tokens,
      model: cs.model || modelId || '',
      idleMs: cs.lastReplyTs ? now - cs.lastReplyTs : 0,
      oneHour: cs.oneHourCache,
      windowTokens: cfg.autoCompact.windowTokens,
      firstTokens: Math.max(10000, cfg.contextAlert.firstTokens),
      tips: cfg.statusLine.tips,
      now,
      savedPct: cachedSavedPct(now)
    });
  } catch {
    line = '';
  }
  return [own, line].filter(Boolean).join('  ');
}
