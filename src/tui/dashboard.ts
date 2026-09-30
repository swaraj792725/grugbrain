/**
 * `grug dash`: live terminal dashboard (zero dependencies).
 * Tabs: 1 Overview · 2 Savings · 3 Activity · 4 Memory · 5 Advice.  Keys: 1-5/←→/tab, g graph, r refresh, q quit.
 * Animated: a live sync pulse, a braille donut of where the savings come from, a counting-up headline number.
 */

import { spawn } from 'node:child_process';
import { loadConfig, paths, VERSION } from '../config.js';
import { health } from '../install.js';
import { loadTune } from '../recalltune.js';
import { loadAdoption } from '../adoption.js';
import { loadMemory, projectName, score } from '../memory/store.js';
import { proxyHealth } from '../proxy/server.js';
import { Activity, readActivity, summarize, Summary, trafficCheck } from '../stats.js';
import { computeSavings, Savings } from '../savings.js';
import { bigText, boldFg, colorBar, donut, ease, fg, PALETTE, pulse, SPINNER } from './visual.js';
import { fmtTokens, fmtUsd, priceFor } from '../tokens.js';
import { cachedUpdate } from '../update.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const esc = (code: string) => (s: string | number) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = esc('1');
const dim = esc('2');
const green = esc('32');
const red = esc('31');
const yellow = esc('33');
const cyan = esc('36');
const orange = esc('38;5;208');
const inverse = esc('7');

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
function pad(s: string, n: number, right = false): string {
  const len = [...visible(s)].length;
  if (len >= n) return s;
  return right ? ' '.repeat(n - len) + s : s + ' '.repeat(n - len);
}
function bar(frac: number, width: number): string {
  const f = Math.max(0, Math.min(1, frac));
  const full = Math.round(f * width);
  return green('█'.repeat(full)) + dim('░'.repeat(width - full));
}
const SPARK = '▁▂▃▄▅▆▇█';
function spark(vals: number[]): string {
  const max = Math.max(...vals, 1e-9);
  return vals.map((v) => SPARK[Math.min(7, Math.floor((v / max) * 7.99))]).join('');
}
function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

interface Data {
  loadedAt: number;
  all: Summary;
  week: Summary;
  day: Summary;
  savings: Savings;
  acts: Activity[];
}

interface State {
  tab: number;
  proxyUp: boolean | null;
  proxyInfo: any;
  lastRender: number;
  /** Animation frame counter (draws ~8x/s) and cached data (reloaded every ~2s). */
  frame?: number;
  data?: Data;
  /** Headline percentage as currently shown (counts up to the real value). */
  shown?: number;
  /** Measured net savings when the dashboard opened, to show what grug saved while you watch. */
  baseNet?: number;
  /** Newest activity seen at the last reload, for the "just now" flash. */
  flash?: { text: string; until: number };
  seenTs?: number;
}

const TABS = ['Overview', 'Savings', 'Activity', 'Memory', 'Advice'];

function loadData(): Data {
  const now = Date.now();
  const week = summarize(now - 7 * DAY);
  return { loadedAt: now, all: summarize(0), week, day: summarize(now - DAY), savings: computeSavings(now - 7 * DAY, week), acts: readActivity(800).filter((a) => !a.tag) };
}
const dataOf = (st: State): Data => st.data || (st.data = loadData());
const DAY = 86400000;

function header(st: State, width: number): string[] {
  const h = health();
  const cfg = loadConfig();
  const ok = (b: boolean) => (b ? green('✓') : red('✗'));
  const proxy = st.proxyUp === null ? dim('…') : st.proxyUp ? green(`● up :${cfg.port}`) : red('● down');
  const upd = cachedUpdate();
  const live = st.frame === undefined ? dim('·') : green(SPINNER[st.frame % SPINNER.length]);
  const synced = st.data ? dim(`synced ${Math.max(0, Math.round((Date.now() - st.data.loadedAt) / 1000))}s ago`) : '';
  const problems = [
    st.proxyUp === false ? 'proxy' : '',
    h.hooks ? '' : 'hooks',
    h.codeMcp ? '' : 'tools',
    h.statusLine ? '' : 'status line'
  ].filter(Boolean);
  const status = problems.length ? red(`✗ needs attention: ${problems.join(', ')} (run: grug doctor --fix)`) : green('✓ grug is working');
  void proxy;
  void ok;
  const line1 = `${orange(bold(' 🪨 grugbrain'))} ${dim('v' + VERSION)} ${live} ${synced}${upd?.newer ? ' ' + yellow(`⬆ ${upd.latest} available (grug update)`) : ''}   ${status}   ${dim('short answers:')} ${cyan(cfg.terse)}`;
  const tabs = TABS.map((t, i) => (i === st.tab ? inverse(` ${i + 1} ${t} `) : dim(` ${i + 1} ${t} `))).join('');
  const clock = dim(new Date().toLocaleTimeString());
  return [line1, pad(tabs, width - visible(clock).length - 1) + clock, dim('─'.repeat(width))];
}

function sideBySide(left: string[], right: string[], gap: number): string[] {
  const lw = Math.max(...left.map((l) => [...visible(l)].length), 0);
  const n = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(pad(left[i] || '', lw + gap) + (right[i] || ''));
  return out;
}

const money = (n: number) => fmtUsd(n);

/** Hero: the headline percentage (counts up), the donut of where it comes from, and a live sync strip. */
/** Percent with enough digits that a small but real saving does not read as 0. */
function pctText(v: number): string {
  return v >= 9.95 ? `${Math.round(v)}%` : v >= 0.995 ? `${v.toFixed(2)}%` : v >= 0.0005 ? `${v.toFixed(3)}%` : v > 0 ? '<0.001%' : '0%';
}

function hero(st: State, width: number): string[] {
  const d = dataOf(st);
  const sv = d.savings;
  const target = sv.pct * 100;
  const shown = st.shown === undefined ? target : st.shown;
  const digits = shown >= 9.95 ? String(Math.round(shown)) : shown >= 0.995 ? shown.toFixed(2) : shown >= 0.0005 ? shown.toFixed(3) : shown > 0 ? '0.000' : '0';
  const big = bigText(digits + '%').map((l) => boldFg(sv.pct > 0 ? 120 : 245)(l));
  const sinceOpen = st.baseNet === undefined ? 0 : sv.netUsd - st.baseNet;
  const day24 = computeSavings(Date.now() - DAY, d.day);
  const left: string[] = [
    bold('GRUG SAVED') + dim('  (measured, last 7 days)'),
    '',
    ...big,
    '',
    `${bold(money(sv.netUsd))} ${dim('kept in your pocket, out of')} ${money(sv.spendUsd + sv.netUsd)} ${dim('you would have paid')}`,
    `${colorBar(sv.pct, 28, 120)} ${dim('share of your bill')}`,
    `${dim('Last 24 hours:')} ${bold(money(day24.netUsd))} ${dim(`(${pctText(day24.pct * 100)})`)}   ${sinceOpen >= 0.0001 ? boldFg(120)(`▲ +${money(sinceOpen)} while you watched`) : dim('live: nothing new since you opened this')}`,
    dim('Only counts text grug really cut out of your chats, priced at your model.'),
    ...(sv.pct > 0 && sv.pct < 0.01 ? [dim('Small on purpose: most of your bill is Claude re-reading a long chat. /clear between tasks is the big lever.')] : [])
  ];
  if (sv.costUsd > 0) left.push(dim(`Already subtracted: ${money(sv.costUsd)} that grug's own notes cost.`));
  if (sv.estimatedUsd > 0.005) left.push(dim(`Not counted (estimates): about ${money(sv.estimatedUsd)} more from handoffs and cache.`));
  const sorted = [...sv.parts].sort((a, b) => b.usd - a.usd);
  const parts = sorted.filter((p) => p.measured);
  const modeled = sorted.filter((p) => !p.measured && p.usd > 0.005);
  const sweep = st.frame === undefined ? -1 : (st.frame % 48) / 48;
  const slices = parts.map((p, i) => ({ value: p.usd, color: PALETTE[i % PALETTE.length] }));
  const ring = donut(slices, 22, 11, sweep);
  const totalUsd = parts.reduce((n, p) => n + p.usd, 0) || 1;
  const legend = parts.slice(0, 8).map((p, i) => `${fg(PALETTE[i % PALETTE.length])('●')} ${pad(p.label, 28)}${pad(Math.round((p.usd / totalUsd) * 100) + '%', 5, true)} ${dim(pad(money(p.usd), 8, true))}`);
  if (!parts.length) legend.push(dim('nothing measured yet: use Claude Code and this fills in'));
  if (modeled.length) {
    legend.push('', dim('Estimates, not in the number:'));
    for (const p of modeled) legend.push(dim(`○ ${pad(p.label, 28)}${pad('≈', 5, true)} ${pad(money(p.usd), 8, true)}`));
  }
  const right = sideBySide(ring, [bold('WHERE IT CAME FROM'), '', ...legend], 2);
  return width >= 112 ? sideBySide(left, right, 4) : [...left, '', ...right];
}

/** The live strip: pulse of the last 30 minutes, the sync status, and a flash for the newest thing grug did. */
function liveStrip(st: State, width: number): string[] {
  const d = dataOf(st);
  const now = Date.now();
  const buckets = new Array(30).fill(0);
  for (const a of d.acts) {
    const m = Math.floor((now - a.ts) / 60000);
    if (m >= 0 && m < 30) buckets[29 - m]++;
  }
  const last = d.acts[d.acts.length - 1];
  const f = st.frame ?? 0;
  const spin = fg(120)(SPINNER[f % SPINNER.length]);
  const L = [`${spin} ${bold('LIVE')}  ${pulse(buckets, f)}  ${dim('grug actions per minute, last 30 min')}   ${dim(last ? `last: ${ago(last.ts)} ago` : 'waiting for Claude')}`];
  if (st.flash && st.flash.until > now) L.push(`  ${boldFg(120)('✦ just now:')} ${st.flash.text.slice(0, width - 16)}`);
  else if (last) L.push(dim(`  ${last.kind}: ${last.msg}`.slice(0, width - 4)));
  return L;
}

/** Three plain-language lines: what drives the bill, whether the cache works, and the single best thing to do. */
function plainWords(d: Data): string[] {
  const { week, savings } = d;
  const L = [bold('IN PLAIN WORDS')];
  if (!week.requests) return [...L, dim('  Not enough use yet. Work with Claude for a while and this explains your bill.')];
  const ctx = (week.inputTokens + week.cacheReadTokens + week.cacheWriteTokens) / week.requests;
  L.push(`  ${dim('•')} Claude re-reads the whole chat on every reply. Yours averaged ${bold(fmtTokens(ctx))} of text, about ${bold(fmtUsd(week.costUsd / week.requests))} a reply.`);
  L.push(ctx > 200000
    ? `  ${yellow('•')} ${yellow('That is big.')} The best saving is yours: type ${bold('/clear')} when you switch to a new task.`
    : `  ${green('•')} Chat sizes look healthy. Keep using ${bold('/clear')} between unrelated tasks.`);
  L.push(week.cacheHitRate >= 0.9
    ? `  ${green('•')} Claude's cache is working: ${Math.round(week.cacheHitRate * 100)}% of the re-reading is billed at a big discount.`
    : `  ${yellow('•')} The cache is only ${Math.round(week.cacheHitRate * 100)}% effective, so re-reading costs more. See the Advice tab.`);
  const top = [...savings.parts].sort((a, b) => b.usd - a.usd)[0];
  if (top && top.usd > 0) L.push(`  ${green('•')} Grug's biggest help this week: ${bold(top.label.toLowerCase())}.`);
  return L;
}

function overview(st: State, width: number): string[] {
  const d = dataOf(st);
  const now = Date.now();
  const { all, week, day } = d;
  const col = (s: string) => pad(s, 15, true);
  const row = (label: string, f: (s: Summary) => string) => `  ${pad(label, 38)}${col(f(day))}${col(f(week))}${col(f(all))}`;
  const L: string[] = [...hero(st, width), '', ...liveStrip(st, width), ''];
  L.push(...plainWords(d));
  L.push('');
  L.push(bold('YOUR USAGE') + dim('  measured from your real Claude sessions'));
  L.push(dim(`  ${pad('', 38)}${col('last 24 hours')}${col('last 7 days')}${col('all time')}`));
  L.push(row('Replies Claude wrote', (s) => s.requests.toLocaleString()));
  L.push(row('What you paid (at API prices)', (s) => fmtUsd(s.costUsd)));
  L.push(row('Text Claude read / wrote (tokens)', (s) => `${fmtTokens(s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens)}/${fmtTokens(s.outputTokens)}`));
  L.push(row('Cost of one reply', (s) => (s.requests ? fmtUsd(s.costUsd / s.requests) : '—')));
  L.push(row('Chat size re-read every reply', (s) => (s.requests ? fmtTokens((s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens) / s.requests) : '—')));
  L.push(row('Saved by Claude\'s built-in cache', (s) => green(fmtUsd(s.cacheSavedUsd))));
  L.push(`  ${pad('Cache working? (7 days)', 38)}${bar(week.cacheHitRate, 24)} ${Math.round(week.cacheHitRate * 100)}%${dim('  higher is better')}`);
  L.push('');
  const days: number[] = [];
  const saved: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const dd = new Date(now - i * DAY).toISOString().slice(0, 10);
    const hit = all.byDay.find((x) => x.day === dd);
    days.push(hit?.costUsd || 0);
    saved.push(hit?.savedUsd || 0);
  }
  L.push(`${bold('LAST 14 DAYS')}  what you paid ${cyan(spark(days))}   saved by cache ${green(spark(saved))}`);
  const monthly = (week.costUsd / 7) * 30;
  const without = ((week.costUsd + d.savings.netUsd) / 7) * 30;
  L.push(`${bold('IF THIS CONTINUES')}  about ${bold(fmtUsd(monthly))} a month` + (d.savings.netUsd > 0 ? `, instead of about ${fmtUsd(without)} without grug (${green('saves ' + fmtUsd(without - monthly))})` : ''));
  const bench = latestBench();
  if (bench) {
    const on = bench.results.filter((r: any) => r.arm === 'on');
    const off = bench.results.filter((r: any) => r.arm === 'off');
    const sum = (xs: any[], f: (r: any) => number) => xs.reduce((a, r) => a + f(r), 0);
    const oc = sum(off, (r) => r.costUsd);
    const pct = oc > 0 ? Math.round((1 - sum(on, (r) => r.costUsd) / oc) * 100) : 0;
    L.push(`${bold('LAST BENCH')}  (${bench.model}, ${ago(bench.ts)} ago) quality ${green(`${sum(on, (r) => +r.pass)}/${on.length}`)} vs baseline ${sum(off, (r) => +r.pass)}/${off.length} · cost ${pct >= 0 ? green(`-${pct}%`) : red(`+${-pct}%`)}`);
  }
  if (!all.requests) {
    L.push('');
    L.push(yellow('  No API traffic recorded yet. Grug sees requests from Claude Code once the proxy is running'));
    L.push(yellow('  (the Claude Desktop chat tab does not expose its API calls; there grug helps via MCP tools + memory).'));
  }
  return L.map((l) => l.slice(0, width * 4));
}

/** Every thing grug does, grouped, with bars against the biggest source. Shows the newest features too. */
function savingsView(st: State, width: number): string[] {
  const d = dataOf(st);
  const { all } = d;
  const L: string[] = [];
  const sv = d.savings;
  const parts = [...sv.parts].sort((a, b) => b.usd - a.usd);
  const maxUsd = Math.max(...parts.map((p) => p.usd), 1e-9);
  L.push(bold('WHERE THE SAVINGS COME FROM') + dim('  last 7 days, estimate: tokens kept out of context priced once at your main model\'s input rate'));
  parts.forEach((p, i) => L.push(`  ${fg(PALETTE[i % PALETTE.length])('●')} ${pad(p.label, 28)}${colorBar(p.usd / maxUsd, 24, PALETTE[i % PALETTE.length])} ${pad(money(p.usd), 9, true)} ${dim(p.count ? p.count + '×' : '')}`));
  if (!parts.length) L.push(dim('  nothing yet'));
  L.push(dim(`  net ${money(sv.netUsd)} = ${money(sv.savedUsd)} saved − ${money(sv.costUsd)} grug's own additions (briefs, recalls, code hints)`));
  L.push('');
  L.push(bold('WHAT GRUG DID') + dim('  all time (token counts are estimates)'));
  const k = (kind: string) => all.countByKind[kind] || 0;
  const t = (kind: string) => all.savedByKind[kind] || 0;
  const did = (label: string, tokens: number, count: number, extra = '') =>
    `  ${pad(label, 34)}${pad(tokens ? (tokens > 0 ? green('~' + fmtTokens(tokens) + ' tok') : yellow(fmtTokens(tokens) + ' tok')) : dim('—'), 16)}${dim(count + '×')} ${dim(extra)}`;
  L.push(bold('  output') );
  L.push(did('install/build noise dropped', t('cmdrules'), k('cmdrules'), 'npm pip cargo go apt docker git make; errors always kept'));
  L.push(did('summarized test output', t('testsum'), k('testsum'), 'failures kept, passing noise dropped'));
  L.push(did('compacted big JSON results', t('json'), k('json'), 'first items in full, one line per rest; also MCP tools'));
  L.push(did('trimmed long tool output', all.trimmedTokens + t('trim'), k('trim'), all.trimSavedUsd > 0 ? `≈ ${fmtUsd(all.trimSavedUsd)} of input; full original always kept on disk` : 'full original always kept on disk'));
  L.push(did('deduped repeated tool results', 0, k('dedupe')));
  L.push(bold('  reads and media'));
  L.push(did('redirected huge full-file reads', t('read-guard'), k('read-guard')));
  L.push(did('skipped unchanged re-reads', t('reread'), k('reread')));
  L.push(did('outlines instead of full files', t('outline'), k('outline')));
  L.push(did('media: repeats skipped/shrunk', t('media'), k('media'), 'screenshots, images, PDF text, video sheets'));
  L.push(bold('  cache and context'));
  L.push(did('prompt-cache breakpoints added', 0, k('cache')));
  L.push(did('cache misses diagnosed (cost)', t('cache-miss'), k('cache-miss'), 'see Advice for culprits'));
  L.push(did('handoffs to a fresh session', t('handoff'), k('handoff'), 'old context not re-read'));
  L.push(did('notices to you (/clear, cache)', 0, k('context-alert') + k('idle-alert') + k('task-shift'), 'context alerts, idle cache, new task'));
  L.push(bold('  memory and navigation'));
  L.push(did('memory briefs + recalls (cost)', t('brief') + t('recall'), k('brief') + k('recall'), 'context carried over instead of re-exploring'));
  const avg = (kind: string) => (k(kind) ? `avg ${Math.round(Math.abs(t(kind)) / k(kind))} tok` : '');
  L.push(did('auto-recall injections (cost)', t('auto-recall'), k('auto-recall'), [avg('auto-recall'), 'only when something clearly matches'].filter(Boolean).join(', ')));
  L.push(did('graph context: maps + code hints', t('graph'), k('graph'), [avg('graph'), 'find the symbol, skip the full read'].filter(Boolean).join(', ')));
  {
    const tu = loadTune();
    const rate = tu.codeShown >= 1 ? `${Math.round((tu.codeHit / tu.codeShown) * 100)}% of code hints then used` : 'no data yet';
    L.push(did('recall usefulness', 0, Math.round(tu.codeShown), `${rate}, strictness ×${tu.strictness.toFixed(2)} (self-tuning)`));
  }
  {
    const a = loadAdoption();
    const total = a.grug + a.read + a.grep + a.glob;
    L.push(did('graph-first hints', 0, k('nav'), a.navShown ? `${Math.round((a.navFollowed / a.navShown) * 100)}% followed by a ranged read; grug tools ${a.grug} vs Read/Grep/Glob ${total - a.grug}` : 'no data yet'));
  }
  L.push(did('durable facts captured', 0, k('facts'), 'decisions, root causes, preferences, commands'));
  L.push(did('notes remembered / consolidated', 0, k('remember') + k('consolidate')));
  L.push(did('safety fallbacks (sent original)', 0, all.fallbacks));
  L.push('');
  const cfg = loadConfig();
  const h = health();
  L.push(bold('IN THE CLAUDE APP'));
  L.push(`  status line under the input box   ${h.statusLine ? green('on') : yellow('off')}  ${dim(h.statusLine ? 'shows context size, $/reply, when to /clear, cache timer, tips' + (cfg.statusLine.wrap ? ' (your own status line runs inside it)' : '') : 'grug install turns it on; grug config set statusLine.enabled true')}`);
  L.push(`  /clear and cache-expiry notices   ${cfg.contextAlert.enabled ? green('on') : yellow('off')}  ${dim('also shown in the chat when a limit is crossed')}`);
  return L.map((l) => l.slice(0, width * 4));
}

function activity(height: number): string[] {
  const acts = readActivity(500).filter((a) => !a.tag).slice(-Math.max(5, height)).reverse();
  if (!acts.length) return [dim('  Nothing yet. Grug waits for Claude to do something.')];
  const color: Record<string, (s: string) => string> = {
    trim: green, cmdrules: green, json: green, dedupe: green, cache: green, 'read-guard': green, outline: green, reread: green, testsum: green, 'cache-miss': yellow, bench: orange, update: yellow, brief: cyan, recall: cyan, remember: cyan,
    consolidate: cyan, fallback: yellow, error: red, install: orange, handoff: green, 'context-alert': yellow, 'idle-alert': yellow, nav: cyan, 'task-shift': yellow, media: green,
    'auto-recall': cyan, graph: cyan, facts: cyan
  };
  return acts.map((a) => {
    const c = color[a.kind] || ((s: string) => s);
    const tok = a.tokens ? (a.tokens > 0 ? green(` +${fmtTokens(a.tokens)}`) : yellow(` ${fmtTokens(a.tokens)}`)) : '';
    return `  ${dim(pad(ago(a.ts), 4, true))}  ${c(pad(a.kind, 13))} ${a.project ? dim(`[${a.project}] `) : ''}${a.msg}${tok}`;
  });
}

function memory(width: number): string[] {
  const cfg = loadConfig();
  const db = loadMemory();
  const nodes = Object.values(db.nodes);
  const L: string[] = [];
  const projects = nodes.filter((n) => n.type === 'project');
  L.push(`${bold('MEMORY GRAPH')}  ${nodes.length} nodes · ${Object.keys(db.edges).length} links · ${projects.length} projects   ${dim('press g to open graph')}`);
  L.push(dim(`  graph: ${paths.graphHtml()}`));
  L.push(dim(`  vault: ${cfg.memory.vaultDir}/grugbrain  (open as Obsidian vault)`));
  L.push(dim(`  budget: ${cfg.memory.briefTokens} tok/session brief, ${cfg.memory.recallTokens} tok/recall · decay half-life ${cfg.memory.halfLifeDays}d · fold after ${cfg.memory.foldAfterDays}d`));
  L.push('');
  L.push(dim(`  ${pad('project', 24)}${pad('sessions', 10, true)}${pad('digests', 9, true)}${pad('notes', 7, true)}${pad('files', 7, true)}${pad('topics', 8, true)}   last active`));
  const rows = projects
    .map((p) => {
      const mine = nodes.filter((n) => n.project === p.project);
      const c = (t: string) => mine.filter((n) => n.type === t).length;
      return { p, c, last: Math.max(...mine.map((n) => n.updated)) };
    })
    .sort((a, b) => b.last - a.last);
  for (const { p, c, last } of rows.slice(0, 12))
    L.push(`  ${pad(projectName(p.project).slice(0, 22), 24)}${pad(String(c('session')), 10, true)}${pad(String(c('digest')), 9, true)}${pad(String(c('note')), 7, true)}${pad(String(c('file')), 7, true)}${pad(String(c('topic')), 8, true)}   ${ago(last)} ago`);
  if (!rows.length) L.push(dim('  Empty. Memory fills itself as you use Claude Code; nothing to do.'));
  const notes = nodes
    .filter((n) => n.type === 'note')
    .sort((a, b) => score(b, cfg.memory.halfLifeDays) - score(a, cfg.memory.halfLifeDays))
    .slice(0, 8);
  if (notes.length) {
    L.push('');
    L.push(bold('TOP NOTES'));
    for (const n of notes) L.push(`  ${n.data?.pinned ? '📌' : '• '} ${dim('[' + projectName(n.project) + ']')} ${n.label.slice(0, width - 30)}`);
  }
  return L;
}

function latestBench(): any | null {
  try {
    const dir = path.join(paths.home(), 'bench');
    const f = fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort().pop();
    if (!f) return null;
    const full = path.join(dir, f);
    const j = JSON.parse(fs.readFileSync(full, 'utf8'));
    return { ...j, ts: fs.statSync(full).mtimeMs };
  } catch {
    return null;
  }
}

export interface Advice {
  level: 'fix' | 'save' | 'info';
  text: string;
  cmd?: string;
}

export function advice(proxyUp: boolean | null): Advice[] {
  const cfg = loadConfig();
  const h = health();
  const week = summarize(Date.now() - 7 * DAY);
  const out: Advice[] = [];
  if (!h.hooks) out.push({ level: 'fix', text: 'Claude Code hooks are not installed; memory and read-guard are idle.', cmd: 'npx github:swaraj792725/grugbrain install' });
  else if (!h.appInstalled) out.push({ level: 'fix', text: `Hooks are installed but the runtime at ${paths.app()} is missing.`, cmd: 'npx github:swaraj792725/grugbrain install' });
  if (h.appInstalled && !h.nodeExists) out.push({ level: 'fix', text: 'The Node binary grug was installed with is gone (nvm/brew upgrade?).', cmd: 'npx github:swaraj792725/grugbrain install' });
  if (h.proxyConfigured && proxyUp === false)
    out.push({ level: 'fix', text: 'Claude Code points at the proxy but it is not running. Claude Code requests will fail until it is up.', cmd: 'grug daemon &   # or: grug install' });
  const traffic = trafficCheck();
  if (h.proxyConfigured && traffic.sessions > 0 && traffic.requests === 0 && traffic.metered === 0)
    out.push({ level: 'fix', text: `Claude Code ran ${traffic.sessions} session(s) today but no API calls reached grug's proxy: something else (another proxy tool?) sets its base URL. Measured stats stay at 0 until fixed.`, cmd: 'in Claude Code: /status (look at the base URL)' });
  if (!h.proxyConfigured && cfg.proxy.enabled) out.push({ level: 'info', text: 'Proxy not wired into Claude Code, so measured stats and in-flight trimming are off.', cmd: 'grug install' });
  if (week.requests >= 20 && week.cacheHitRate < 0.5)
    out.push({ level: 'save', text: `Cache hit rate only ${Math.round(week.cacheHitRate * 100)}% this week. Something changes the prompt prefix each turn (timestamps, reordered tools, switching models).` });
  const opus = Object.entries(week.byModel).filter(([m]) => /opus|fable|mythos/.test(m));
  const opusCost = opus.reduce((s, [, v]) => s + v.costUsd, 0);
  if (week.costUsd > 0 && opusCost / week.costUsd > 0.6) {
    const ratio = priceFor('claude-sonnet-5-5').input / priceFor(opus[0][0]).input;
    const est = opusCost * 0.3 * (1 - ratio);
    out.push({
      level: 'save',
      text: `${Math.round((opusCost / week.costUsd) * 100)}% of spend is top-tier models. Moving ~30% of that work (subagents, simple edits, search) to Sonnet 5.5 / Haiku 4.5 would save ≈ ${fmtUsd(est)}/week.`,
      cmd: 'in Claude Code: /model sonnet for routine work'
    });
  }
  const avgCtx = week.requests ? (week.inputTokens + week.cacheReadTokens + week.cacheWriteTokens) / week.requests : 0;
  if (week.requests >= 20 && avgCtx > 150000) {
    const perReply = week.costUsd / week.requests;
    out.push({
      level: 'save',
      text: `Average context is ${fmtTokens(avgCtx)} tokens per reply (${fmtUsd(perReply)}/reply). Every reply re-reads it. Cost scales with context: halving it roughly halves the bill (≈ ${fmtUsd(week.costUsd / 2)}/week here).`,
      cmd: 'grug auto-compacts at the autoCompact window and restores a handoff; cut deeper: grug config set autoCompact.windowTokens 120000'
    });
  }
  const outShare = week.outputTokens / Math.max(1, week.inputTokens + week.outputTokens);
  if (cfg.terse === 'off' && week.outputTokens > 0)
    out.push({ level: 'save', text: `Terse output is off; output tokens cost ~5x input. ${Math.round(outShare * 100)}% of fresh tokens are output.`, cmd: 'grug config set terse lite' });
  else if (cfg.terse === 'lite' && outShare > 0.35)
    out.push({ level: 'save', text: `Output is ${Math.round(outShare * 100)}% of fresh tokens. Caveman mode cuts prose further (code untouched).`, cmd: 'grug config set terse full' });
  if (!cfg.readGuard.enabled) out.push({ level: 'save', text: 'Read-guard is off; huge files get read whole.', cmd: 'grug config set readGuard.enabled true' });
  if (!cfg.memory.enabled) out.push({ level: 'save', text: 'Memory is off; every session re-explores the project from zero.', cmd: 'grug config set memory.enabled true' });
  const misses = readActivity(5000).filter((a) => a.kind === 'cache-miss' && !a.tag && a.ts > Date.now() - 7 * DAY);
  if (misses.length) {
    const byCulprit = new Map<string, { n: number; tok: number; example: string }>();
    for (const m of misses) {
      const c = (m.msg.match(/\(([\w-]+)\)/) || [])[1] || 'unknown';
      const e = byCulprit.get(c) || { n: 0, tok: 0, example: m.msg };
      e.n++;
      e.tok += -(m.tokens || 0);
      byCulprit.set(c, e);
    }
    const top = [...byCulprit.entries()].sort((a, b) => b[1].tok - a[1].tok)[0];
    out.push({ level: 'save', text: `${misses.length} avoidable cache miss(es) this week re-wrote ~${fmtTokens(top[1].tok)} tokens; top cause "${top[0]}": ${top[1].example.replace(/^Cache miss \([\w-]+\): /, '').slice(0, 160)}` });
  }
  const upd = cachedUpdate();
  if (upd?.newer) out.push({ level: 'info', text: `grugbrain ${upd.latest} is available (you have ${upd.current}).`, cmd: 'grug update' });
  if (week.fallbacks > 0) out.push({ level: 'info', text: `${week.fallbacks} request(s) were rejected after optimization and resent untouched (no impact on you). If it keeps happening: grug config set proxy.dedupeReads false` });
  if (!out.length) out.push({ level: 'info', text: 'Nothing to fix. Grug happy. Grug keep working.' });
  return out;
}

function adviceView(st: State): string[] {
  const L: string[] = [bold('WHAT GRUG WOULD DO NEXT') + dim('  (things grug cannot change on its own, ranked)'), ''];
  for (const a of advice(st.proxyUp)) {
    const tag = a.level === 'fix' ? red('[fix] ') : a.level === 'save' ? green('[save]') : cyan('[info]');
    L.push(`  ${tag} ${a.text}`);
    if (a.cmd) L.push(`         ${dim('→')} ${cyan(a.cmd)}`);
  }
  return L;
}

export function renderOnce(st: State, width = process.stdout.columns || 100, height = process.stdout.rows || 40): string {
  const w = Math.max(60, Math.min(140, width));
  let body: string[];
  if (st.tab === 0) body = overview(st, w);
  else if (st.tab === 1) body = savingsView(st, w);
  else if (st.tab === 2) body = activity(height - 6);
  else if (st.tab === 3) body = memory(w);
  else body = adviceView(st);
  const footer = dim('  1-5/←→ switch · g open memory graph · r refresh · q quit');
  return [...header(st, w), ...body, '', footer].join('\n');
}

export function openPath(p: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', p] : [p];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* no opener */
  }
}

export async function runDashboard(opts: { once?: boolean } = {}): Promise<void> {
  const cfg = loadConfig();
  try {
    (await import('../meter.js')).meterRecent();
  } catch {
    /* best-effort */
  }
  const st: State = { tab: 0, proxyUp: null, proxyInfo: null, lastRender: 0 };
  const probe = async () => {
    st.proxyInfo = await proxyHealth(cfg.port);
    st.proxyUp = !!st.proxyInfo;
  };
  await probe();
  if (opts.once || !process.stdout.isTTY || !process.stdin.isTTY) {
    for (st.tab = 0; st.tab < TABS.length; st.tab++) console.log(renderOnce(st) + '\n');
    return;
  }
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l');
  st.frame = 0;
  const reload = () => {
    const prevTs = st.seenTs;
    st.data = loadData();
    const newest = st.data.acts[st.data.acts.length - 1];
    if (newest && prevTs !== undefined && newest.ts > prevTs) st.flash = { text: `${newest.kind}: ${newest.msg}`, until: Date.now() + 4000 };
    if (newest) st.seenTs = newest.ts;
    else if (st.seenTs === undefined) st.seenTs = 0;
  };
  reload();
  st.baseNet = st.data?.savings.netUsd;
  st.shown = 0; // the headline counts up from 0 on open
  // One write per frame, line by line with erase-to-end, so nothing flickers.
  const draw = () => {
    st.shown = ease(st.shown ?? 0, st.data ? st.data.savings.pct * 100 : 0);
    out.write('\x1b[H' + renderOnce(st).split('\n').map((l) => l + '\x1b[K').join('\n') + '\x1b[J');
  };
  const cleanup = () => {
    out.write('\x1b[?25h\x1b[?1049l');
    process.stdin.setRawMode(false);
    process.exit(0);
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', async (key: string) => {
    if (key === 'q' || key === '\u0003' || key === '\u001b') return cleanup();
    if (key >= '1' && key <= String(TABS.length)) st.tab = Number(key) - 1;
    else if (key === '\t' || key === '\u001b[C') st.tab = (st.tab + 1) % TABS.length;
    else if (key === '\u001b[D') st.tab = (st.tab + TABS.length - 1) % TABS.length;
    else if (key === 'g') {
      const { maintain } = await import('../memory/maintain.js');
      maintain();
      openPath(paths.graphHtml());
    } else if (key === 'r') {
      await probe();
      reload();
    }
    out.write('\x1b[2J');
    draw();
  });
  out.on('resize', () => {
    out.write('\x1b[2J');
    draw();
  });
  out.write('\x1b[2J');
  draw();
  // Animation: ~8 frames a second (spinner, donut sweep, count-up); data reloads every 2 s.
  setInterval(() => {
    st.frame = (st.frame ?? 0) + 1;
    draw();
  }, 120);
  setInterval(async () => {
    await probe();
    reload();
  }, 2000);
}
