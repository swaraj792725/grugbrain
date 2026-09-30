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
import { readActivity } from './stats.js';

const useColor = !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = c('2');
const yellow = c('33');
const red = c('31');
const green = c('32');
const orange = c('38;5;208');
const cyan = c('36');
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

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
  /** Hide the `saved ~N%` tag: the panel row shows it as a bar instead. */
  noSaved?: boolean;
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
  if (!o.noSaved && o.savedPct !== undefined && o.savedPct > 0) parts.push(green(`saved ~${Math.round(o.savedPct * 100)}%`));
  return `${orange('🪨')} ${parts.join(dim(' │ '))}`;
}

export interface SavedNow {
  pct: number;
  netUsd: number;
  spendUsd: number;
  last?: { ts: number; msg: string };
}

export function cachedSaved(now: number): SavedNow | undefined {
  const file = path.join(paths.cache(), 'statusline.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (now - j.ts < 60000 && typeof j.netUsd === 'number') return j;
  } catch {
    /* recompute */
  }
  try {
    const sv = computeSavings(now - 7 * 86400000);
    const v: SavedNow & { ts: number } = { ts: now, pct: sv.pct, netUsd: sv.netUsd, spendUsd: sv.spendUsd };
    ensureDir(paths.cache());
    fs.writeFileSync(file, JSON.stringify(v));
    return v;
  } catch {
    return undefined;
  }
}

/** Latest grug action in the last 45 s (cheap: tail of the activity log). */
export function lastAction(now: number): { ts: number; msg: string } | undefined {
  try {
    const a = readActivity(20).filter((x) => now - x.ts < 45000).pop();
    return a ? { ts: a.ts, msg: a.msg || a.kind } : undefined;
  } catch {
    return undefined;
  }
}

/** Smooth bar with eighth-block resolution so a few percent still shows as a sliver. */
export function barCells(frac: number, width: number): string {
  const eighths = Math.round(Math.max(0, Math.min(1, frac)) * width * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  const partial = part ? '▏▎▍▌▋▊▉'[part - 1] : '';
  return '█'.repeat(full) + partial + ' '.repeat(Math.max(0, width - full - (partial ? 1 : 0)));
}

/** Colored bar: filled part in `col`, the rest as dim shade. */
function colored(frac: number, width: number, col: (s: string) => string): string {
  const cells = barCells(frac, width);
  const filled = cells.replace(/ +$/, '');
  return col(filled) + dim('░'.repeat(cells.length - filled.length));
}

/** Pure: the second row. Moving pulse when a reply is being produced, calm dots when idle. */
export function composePanel(o: {
  now: number;
  active: boolean;
  savedPct?: number;
  netUsd?: number;
  tokens: number;
  limit: number;
  recent?: { ts: number; msg: string };
}): string {
  const f = Math.floor(o.now / 1000);
  const pulse = o.active
    ? Array.from({ length: 8 }, (_, i) => ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'][(f + i * 3) % 8]).join('')
    : dim('········');
  const state = o.active ? cyan(`${SPIN[f % SPIN.length]} working`) : dim('○ idle');
  const parts = [`${state} ${o.active ? cyan(pulse) : pulse}`];
  const pct = o.savedPct ?? 0;
  parts.push(`${dim('saved')} ${colored(pct, 10, green)} ${green(`~${Math.round(pct * 100)}%`)}${o.netUsd && o.netUsd >= 0.01 ? dim(` (${usd(o.netUsd)}/7d)`) : ''}`);
  if (o.tokens > 0 && o.limit > 0) {
    const fr = o.tokens / o.limit;
    const col = fr >= 1.2 ? red : fr >= 1 ? yellow : green;
    parts.push(`${dim('ctx')} ${colored(Math.min(1, fr), 8, col)} ${col(`${Math.round(fr * 100)}%`)}${dim(' of limit')}`);
  }
  if (o.recent) parts.push(yellow(`✦ ${o.recent.msg.slice(0, 60)}`));
  return parts.join(dim(' │ '));
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
  let panel = '';
  const saved = cachedSaved(now);
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
      savedPct: saved?.pct,
      noSaved: cfg.statusLine.panel
    });
    if (cfg.statusLine.panel) {
      let mtime = 0;
      try {
        if (input.transcript_path) mtime = fs.statSync(input.transcript_path).mtimeMs;
      } catch {
        /* no transcript yet */
      }
      const limit = cfg.autoCompact.windowTokens > 0 ? cfg.autoCompact.windowTokens * 0.8 : Math.max(10000, cfg.contextAlert.firstTokens);
      panel = composePanel({
        now,
        active: now - mtime < 6000,
        savedPct: saved?.pct,
        netUsd: saved?.netUsd,
        tokens: cs.tokens,
        limit,
        recent: lastAction(now)
      });
    }
  } catch {
    line = '';
  }
  return [[own, line].filter(Boolean).join('  '), panel].filter(Boolean).join('\n');
}

/** Plain-text bar (no colour codes: hook messages are not ANSI-rendered). */
function plainBar(frac: number, width: number): string {
  const cells = barCells(frac, width);
  const filled = cells.replace(/ +$/, '');
  return filled + '░'.repeat(cells.length - filled.length);
}

/** Pure: the one-line grug summary shown to the user in apps that draw no status line. */
export function composeAppLine(o: {
  savedPct?: number;
  netUsd?: number;
  tokens: number;
  limit: number;
  recent?: string;
}): string {
  const parts = ['🪨 grug'];
  if (o.savedPct !== undefined) {
    const pct = Math.round(o.savedPct * 100);
    parts.push(`saved ${plainBar(o.savedPct, 10)} ~${pct}% (7d overall${o.netUsd && o.netUsd >= 0.01 ? `, ${usd(o.netUsd)}` : ''})`);
  }
  if (o.tokens > 0 && o.limit > 0) {
    const fr = o.tokens / o.limit;
    const pct = Math.round(fr * 100);
    parts.push(`context ${plainBar(Math.min(1, fr), 8)} ${pct}% of /clear limit (${k(o.tokens)})${fr >= 1 ? ' ⚠ /clear soon' : ''}`);
  }
  if (o.recent) parts.push(`last: ${o.recent.slice(0, 50)}`);
  return parts.join(' │ ');
}

/** The app summary for now, or undefined when there is nothing worth showing. */
export function appSummaryLine(transcriptPath: string | undefined, now = Date.now()): string | undefined {
  try {
    const cfg = loadConfig();
    const saved = cachedSaved(now);
    const cs = contextSize(transcriptPath);
    const limit = cfg.autoCompact.windowTokens > 0 ? cfg.autoCompact.windowTokens * 0.8 : Math.max(10000, cfg.contextAlert.firstTokens);
    const recent = lastAction(now)?.msg;
    if (!(saved && saved.pct > 0) && !cs.tokens) return '🪨 grug │ on and watching │ nothing saved yet this week, it fills in as you work';
    return composeAppLine({ savedPct: saved?.pct, netUsd: saved?.netUsd, tokens: cs.tokens, limit, recent });
  } catch {
    return undefined;
  }
}

export interface AppStatus {
  savedPct?: number;
  netUsd?: number;
  tokens: number;
  limit: number;
  idleMs: number;
  recent?: string;
  /** User-only notices: context size, cold cache. */
  alerts: string[];
}

/** Machine-readable status for the grug-live app plugin (same numbers as the status line). */
export function appStatus(transcriptPath: string | undefined, now = Date.now()): AppStatus {
  const cfg = loadConfig();
  const saved = cachedSaved(now);
  const cs = contextSize(transcriptPath);
  const limit = cfg.autoCompact.windowTokens > 0 ? cfg.autoCompact.windowTokens * 0.8 : Math.max(10000, cfg.contextAlert.firstTokens);
  const idleMs = cs.lastReplyTs ? now - cs.lastReplyTs : 0;
  const alerts: string[] = [];
  if (cs.tokens >= limit) alerts.push(`context is ${k(cs.tokens)}: /clear soon (grug restores a handoff)`);
  if (idleMs > (cs.oneHourCache ? 3600000 : 300000) && cs.tokens > 0) alerts.push('cache expired while idle: next reply re-reads the context at full price');
  return { savedPct: saved?.pct, netUsd: saved?.netUsd, tokens: cs.tokens, limit, idleMs, recent: lastAction(now)?.msg, alerts };
}
