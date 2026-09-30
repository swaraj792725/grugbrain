/**
 * `grug dash`: live terminal dashboard (zero dependencies).
 * Tabs: 1 Overview · 2 Activity · 3 Memory · 4 Advice.  Keys: 1-4/←→/tab, g graph, r refresh, q quit.
 */

import { spawn } from 'node:child_process';
import { loadConfig, paths, VERSION } from '../config.js';
import { health } from '../install.js';
import { loadTune } from '../recalltune.js';
import { loadAdoption } from '../adoption.js';
import { loadMemory, projectName, score } from '../memory/store.js';
import { proxyHealth } from '../proxy/server.js';
import { readActivity, summarize, Summary, trafficCheck } from '../stats.js';
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

interface State {
  tab: number;
  proxyUp: boolean | null;
  proxyInfo: any;
  lastRender: number;
}

const TABS = ['Overview', 'Activity', 'Memory', 'Advice'];
const DAY = 86400000;

function header(st: State, width: number): string[] {
  const h = health();
  const cfg = loadConfig();
  const ok = (b: boolean) => (b ? green('✓') : red('✗'));
  const proxy = st.proxyUp === null ? dim('…') : st.proxyUp ? green(`● up :${cfg.port}`) : red('● down');
  const upd = cachedUpdate();
  const line1 = `${orange(bold(' 🪨 grugbrain'))} ${dim('v' + VERSION)}${upd?.newer ? ' ' + yellow(`⬆ ${upd.latest}`) : ''}   proxy ${proxy}  hooks ${ok(h.hooks)}  code-mcp ${ok(h.codeMcp)}  desktop ${ok(h.desktopMcp)}  terse ${cyan(cfg.terse)}`;
  const tabs = TABS.map((t, i) => (i === st.tab ? inverse(` ${i + 1} ${t} `) : dim(` ${i + 1} ${t} `))).join('');
  const clock = dim(new Date().toLocaleTimeString());
  return [line1, pad(tabs, width - visible(clock).length - 1) + clock, dim('─'.repeat(width))];
}

function overview(width: number): string[] {
  const now = Date.now();
  const all = summarize(0);
  const week = summarize(now - 7 * DAY);
  const day = summarize(now - DAY);
  const col = (s: string) => pad(s, 15, true);
  const row = (label: string, f: (s: Summary) => string) => `  ${pad(label, 30)}${col(f(day))}${col(f(week))}${col(f(all))}`;
  const L: string[] = [];
  L.push(bold('MEASURED') + dim('  real token usage (proxy + session transcripts)'));
  L.push(dim(`  ${pad('', 30)}${col('24h')}${col('7 days')}${col('all time')}`));
  L.push(row('requests', (s) => s.requests.toLocaleString()));
  L.push(row('spend', (s) => fmtUsd(s.costUsd)));
  L.push(row('input / output tokens', (s) => `${fmtTokens(s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens)}/${fmtTokens(s.outputTokens)}`));
  L.push(row('cost per reply', (s) => (s.requests ? fmtUsd(s.costUsd / s.requests) : '—')));
  L.push(row('avg context per reply', (s) => (s.requests ? fmtTokens((s.inputTokens + s.cacheReadTokens + s.cacheWriteTokens) / s.requests) : '—')));
  L.push(row('saved by prompt cache (all)', (s) => green(fmtUsd(s.cacheSavedUsd))));
  L.push(row('  …where grug added the cache', (s) => green(fmtUsd(s.grugCacheSavedUsd))));
  L.push(`  ${pad('cache hit rate (7d)', 30)}${bar(week.cacheHitRate, 24)} ${Math.round(week.cacheHitRate * 100)}%`);
  L.push('');
  L.push(bold('WHAT GRUG DID') + dim('  (token counts here are estimates)'));
  const k = (kind: string) => all.countByKind[kind] || 0;
  const t = (kind: string) => all.savedByKind[kind] || 0;
  const did = (label: string, tokens: number, count: number, extra = '') =>
    `  ${pad(label, 34)}${pad(tokens ? (tokens > 0 ? green('~' + fmtTokens(tokens) + ' tok') : yellow(fmtTokens(tokens) + ' tok')) : dim('—'), 16)}${dim(count + '×')} ${dim(extra)}`;
  L.push(did('trimmed long tool output', all.trimmedTokens + t('trim'), k('trim'), all.trimSavedUsd > 0 ? `≈ ${fmtUsd(all.trimSavedUsd)} of input` : ''));
  L.push(did('deduped repeated tool results', 0, k('dedupe')));
  L.push(did('summarized test/build output', t('testsum'), k('testsum'), 'failures kept, passing noise dropped'));
  L.push(did('redirected huge full-file reads', t('read-guard'), k('read-guard')));
  L.push(did('skipped unchanged re-reads', t('reread'), k('reread')));
  L.push(did('cache misses diagnosed (cost)', t('cache-miss'), k('cache-miss'), 'see Advice for culprits'));
  L.push(did('media: repeats skipped/shrunk', t('media'), k('media'), 'screenshots, images, PDF text, video sheets'));
  L.push(did('outlines instead of full files', t('outline'), k('outline')));
  L.push(did('prompt-cache breakpoints added', 0, k('cache')));
  L.push(did('handoffs to a fresh session', t('handoff'), k('handoff'), 'old context not re-read'));
  L.push(did('context-size alerts', 0, k('context-alert')));
  L.push(did('cache-expiry notices (cold replies)', 0, k('idle-alert'), 'told you before a big idle session re-wrote its cache'));
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
  L.push(did('new-task /clear suggestions', 0, k('task-shift'), 'big context + unrelated prompt'));
  L.push(did('durable facts captured', 0, k('facts'), 'decisions, root causes, preferences, commands'));
  L.push(did('notes remembered', 0, k('remember')));
  L.push(did('memory consolidations', 0, k('consolidate')));
  L.push(did('safety fallbacks (sent original)', 0, all.fallbacks));
  L.push('');
  const days: number[] = [];
  const saved: number[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY).toISOString().slice(0, 10);
    const hit = all.byDay.find((x) => x.day === d);
    days.push(hit?.costUsd || 0);
    saved.push(hit?.savedUsd || 0);
  }
  L.push(`${bold('14-DAY')}  spend ${cyan(spark(days))}   cache-saved ${green(spark(saved))}`);
  const monthly = (week.costUsd / 7) * 30;
  const without = ((week.costUsd + week.grugCacheSavedUsd + week.trimSavedUsd) / 7) * 30;
  L.push(
    `${bold('PROJECTION')}  at 7-day pace: ${bold(fmtUsd(monthly))}/mo` +
      (without > monthly ? `, without grug's changes ≈ ${fmtUsd(without)}/mo (${green('-' + fmtUsd(without - monthly))})` : '')
  );
  const bench = latestBench();
  if (bench) {
    const on = bench.results.filter((r: any) => r.arm === 'on');
    const off = bench.results.filter((r: any) => r.arm === 'off');
    const sum = (xs: any[], f: (r: any) => number) => xs.reduce((a, r) => a + f(r), 0);
    const oc = sum(off, (r) => r.costUsd);
    const saved = oc > 0 ? Math.round((1 - sum(on, (r) => r.costUsd) / oc) * 100) : 0;
    L.push(
      `${bold('LAST BENCH')}  (${bench.model}, ${ago(bench.ts)} ago) quality ${green(`${sum(on, (r) => +r.pass)}/${on.length}`)} vs baseline ${sum(off, (r) => +r.pass)}/${off.length} · cost ${saved >= 0 ? green(`-${saved}%`) : red(`+${-saved}%`)}`
    );
  }
  if (!all.requests) {
    L.push('');
    L.push(yellow('  No API traffic recorded yet. Grug sees requests from Claude Code once the proxy is running'));
    L.push(yellow('  (the Claude Desktop chat tab does not expose its API calls; there grug helps via MCP tools + memory).'));
  }
  return L.map((l) => l.slice(0, width * 3));
}

function activity(height: number): string[] {
  const acts = readActivity(500).filter((a) => !a.tag).slice(-Math.max(5, height)).reverse();
  if (!acts.length) return [dim('  Nothing yet. Grug waits for Claude to do something.')];
  const color: Record<string, (s: string) => string> = {
    trim: green, dedupe: green, cache: green, 'read-guard': green, outline: green, reread: green, testsum: green, 'cache-miss': yellow, bench: orange, update: yellow, brief: cyan, recall: cyan, remember: cyan,
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
  if (st.tab === 0) body = overview(w);
  else if (st.tab === 1) body = activity(height - 6);
  else if (st.tab === 2) body = memory(w);
  else body = adviceView(st);
  const footer = dim('  1-4/←→ switch · g open memory graph · r refresh · q quit');
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
    for (st.tab = 0; st.tab < 4; st.tab++) console.log(renderOnce(st) + '\n');
    return;
  }
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l');
  const draw = () => out.write('\x1b[H\x1b[2J' + renderOnce(st));
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
    if (key >= '1' && key <= '4') st.tab = Number(key) - 1;
    else if (key === '\t' || key === '\u001b[C') st.tab = (st.tab + 1) % 4;
    else if (key === '\u001b[D') st.tab = (st.tab + 3) % 4;
    else if (key === 'g') {
      const { maintain } = await import('../memory/maintain.js');
      maintain();
      openPath(paths.graphHtml());
    } else if (key === 'r') await probe();
    draw();
  });
  out.on('resize', draw);
  draw();
  setInterval(async () => {
    await probe();
    draw();
  }, 2000);
}
