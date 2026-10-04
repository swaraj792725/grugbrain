#!/usr/bin/env node
/**
 * grug: command-line entry point for grugbrain.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, paths, setConfigValue, VERSION } from './config.js';
import { cavemanCompress } from './compress/caveman.js';
import { repoMap } from './compress/repomap.js';
import { skeletonize } from './compress/skeleton.js';
import { runDaemon } from './daemon.js';
import { readStdinJson, readStdinText, runHook, spawnDetached } from './hooks.js';
import { health, install, pluginDir, Step, uninstall } from './install.js';
import { runMcpServer } from './mcp.js';
import { buildBrief, recall } from './memory/brief.js';
import { maintain, withMemoryLock } from './memory/maintain.js';
import { addNote, loadMemory, projectKey, saveMemory } from './memory/store.js';
import { proxyHealth, startProxy } from './proxy/server.js';
import { advice, openPath, runDashboard } from './tui/dashboard.js';
import { trafficCheck } from './stats.js';

const argv = process.argv.slice(2).filter((a) => a !== '--from=grugbrain');
const flags = new Set(argv.filter((a) => a.startsWith('--')));
// Flags that take a value: `--dir path` must not leak `path` into the positional words.
const VALUE_FLAGS = new Set(['--dir', '--port', '--budget', '--model', '--runs', '--tasks', '--days']);
const pos = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && VALUE_FLAGS.has(argv[i - 1])));
const cmd = pos[0] || 'help';

const flagValue = (name: string): string | undefined => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

function printSteps(steps: Step[]) {
  for (const s of steps) console.log(`${s.ok ? '✅' : '⚠️ '} ${s.target.padEnd(16)} ${s.message}`);
}

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const HELP = `
🪨 grugbrain v${VERSION}: grug make Claude use few token.

  grug install [--no-proxy] [--no-desktop] [--no-code] [--no-service]
                                  one-time setup; then grug works alone forever
  grug dash [--once]              live TUI dashboard: what grug did, what it would do
  grug doctor [--fix]             check everything, say how to fix (--fix: remove broken leftovers of uninstalled tools)
  grug uninstall [--purge]        remove from Claude Code/Desktop (keeps memory unless --purge)

  grug graph [--no-open]          open the interactive memory graph
  grug vault                      rebuild + show the Obsidian-compatible memory vault
  grug brief [dir]                show what grug would tell Claude about a project
  grug recall <query> [--dir d]   search memory
  grug remember <text> [--dir d]  pin a note for a project
  grug context [transcript]       what fills the context of the current session (by kind and biggest items)
  grug slim [--apply | --undo] [--days 30] [--include-new]
                                  list unused plugin skills by name only (smaller context every reply; they still work)
  grug discover [--days 7]        which commands and MCP tools put the most output into context, and how much grug shortened
  grug maintain                   ingest + consolidate memory now (normally automatic)
  grug warm [dir] [--graph]       refresh code-graph + history caches for a project (normally automatic)

  grug map [dir] [--budget 1500]  ranked repo map under a token budget
  grug outline <file>             skeleton of a source file
  grug compress <text | ->        strip filler from text (stdin with -)

  grug bench [--model sonnet] [--runs 1] [--tasks a,b] [--compare key=value,...] --yes
                                  A/B real Claude Code runs: grug off vs on, graded (spends usage)
  grug update [--check]           install the newest GitHub release (--check: only look)

  grug config [path | get <k> | set <k> <v>]
  grug savings                    one-line spend/savings summary

  (internal) daemon · proxy · mcp · hook <event>
`;

async function main() {
  switch (cmd) {
    case 'install': {
      console.log('🪨 grug install. grug set up once, then grug work alone.\n');
      const steps = install({
        code: !flags.has('--no-code'),
        desktop: !flags.has('--no-desktop'),
        proxy: !flags.has('--no-proxy'),
        service: !flags.has('--no-service')
      });
      printSteps(steps);
      if (!steps[0].ok) process.exit(1);
      const cfg = loadConfig();
      if (!(await proxyHealth(cfg.port, 400))) spawnDetached(['daemon']);
      const up = await waitForProxy(cfg.port, 5000);
      console.log(`\n${up ? '✅' : '⚠️ '} proxy            ${up ? `running on http://127.0.0.1:${cfg.port}` : 'not answering yet: run `grug doctor`'}`);
      console.log('\nDone. Restart Claude Code / Claude Desktop once. Watch grug work: grug dash');
      break;
    }
    case 'uninstall':
      printSteps(uninstall(flags.has('--purge')));
      break;

    case 'status':
    case 'doctor': {
      const h = health();
      const cfg = loadConfig();
      const up = await proxyHealth(cfg.port);
      const ok = (b: boolean) => (b ? '✅' : '❌');
      console.log(`🪨 grugbrain v${VERSION}  (data: ${paths.home()})\n`);
      console.log(`${ok(h.appInstalled)} runtime copied to ${paths.app()}`);
      console.log(`${ok(h.nodeExists)} node binary still exists`);
      console.log(`${ok(h.hooks)} Claude Code hooks in ${h.settingsPath}`);
      console.log(`${ok(h.statusLine)} Claude Code status line (/clear and cache notices)`);
      if (cfg.appPlugin.enabled) {
        let dirs = '';
        try {
          dirs = JSON.parse(fs.readFileSync(h.settingsPath, 'utf8')).env?.CLAUDE_CODE_PLUGIN_DIRS || '';
        } catch {
          /* no settings */
        }
        console.log(`${ok(dirs.includes('grug-live') && fs.existsSync(pluginDir()))} grug-live band above the prompt (app plugin; needs a new session)`);
        let hb: any = {};
        try {
          hb = JSON.parse(fs.readFileSync(path.join(paths.home(), 'live-heartbeat.json'), 'utf8'));
        } catch {
          /* never loaded */
        }
        const ago = (t?: number) => (t ? `${Math.max(1, Math.round((Date.now() - t) / 60000))} min ago` : 'never');
        console.log(`   plugin loaded by Claude Code: ${ago(hb.sessionAt)}; band drawn: ${hb.renders ? `${ago(hb.renderAt)} (${hb.renders} pings)` : 'never'}`);
        if (!hb.sessionAt) console.log('   → never loaded: start a NEW session after install/update (existing ones keep the old plugin list)');
        else if (!hb.renders) console.log('   → loaded but never drawn: this Claude Code surface (the desktop Code tab may be one) does not render the band; use `grug dash` or the terminal `claude` to see it');
      }
      {
        const { loadSlimState } = await import('./slim.js');
        const st = loadSlimState();
        console.log(st.hidden.length ? `✅ skill list slimmed: ${st.hidden.length} unused plugin skill(s) listed by name only (grug slim --undo to restore)` : `ℹ️  skill list not slimmed: \`grug slim\` shows which unused plugin skills could be listed by name only`);
      }
      console.log(`${ok(h.proxyConfigured)} Claude Code ANTHROPIC_BASE_URL → proxy`);
      console.log(`${ok(!!up)} proxy answering on :${cfg.port}${up ? ` (up ${Math.round(up.uptimeMs / 60000)} min, ${up.served} requests)` : ''}`);
      {
        try {
          const { meterRecent } = await import('./meter.js');
          meterRecent(); // catch up on recent transcripts before judging
        } catch {
          /* best-effort */
        }
        const t = trafficCheck();
        if (t.requests > 0) console.log(`✅ ${t.requests} Claude API call(s) went through grug's proxy in the last 24h`);
        if (t.metered > 0)
          console.log(`✅ ${t.metered} Claude reply(ies) measured from session transcripts in the last 24h${t.requests === 0 ? ' (sessions that bypass the proxy, e.g. the Claude app Code tab)' : ''}`);
        if (h.proxyConfigured && t.sessions > 0 && t.requests === 0 && t.metered === 0)
          console.log(`❌ Claude Code ran ${t.sessions} session(s) in the last 24h but no usage reached grug (no proxied calls, nothing measured).\n   Update grug (grug update) and start a new session; if it persists, something else points Claude Code at another URL.`);
      }
      {
        const { readActivity } = await import('./stats.js');
        const week = readActivity(20000).filter((a) => !a.tag && a.ts > Date.now() - 7 * 86400000);
        const stat = (kind: string) => {
          const xs = week.filter((a) => a.kind === kind);
          return { n: xs.length, avg: xs.length ? Math.round(xs.reduce((s, a) => s + Math.abs(a.tokens || 0), 0) / xs.length) : 0 };
        };
        const r = stat('auto-recall');
        const g = stat('graph');
        const f = stat('facts');
        const on = (b: boolean) => (b ? '✅' : '➖');
        console.log(`${on(cfg.autoRecall.enabled)} auto-recall ${cfg.autoRecall.enabled ? `on (≤${cfg.autoRecall.maxTokens} tok): ${r.n} injection(s) in 7 days${r.n ? `, avg ${r.avg} tok` : ''}` : 'off (grug config set autoRecall.enabled true)'}`);
        console.log(`${on(cfg.graphContext.enabled)} graph context ${cfg.graphContext.enabled ? `on: ${g.n} code map(s)/hint(s) in 7 days${g.n ? `, avg ${g.avg} tok` : ''}` : 'off (grug config set graphContext.enabled true)'}`);
        {
          const { loadAdoption } = await import('./adoption.js');
          const a = loadAdoption();
          const total = a.grug + a.read + a.grep + a.glob;
          if (total >= 5)
            console.log(`ℹ️  navigation: grug tools ${a.grug}, Read ${a.read}, Grep ${a.grep}, Glob ${a.glob} (${Math.round((a.grug / total) * 100)}% grug); graph hints followed ${a.navShown ? Math.round((a.navFollowed / a.navShown) * 100) + '%' : 'n/a'} of ${a.navShown}`);
        }
        {
          const { hasTool } = await import('./media.js');
          const m = cfg.mediaGuard;
          const tools = ['pdftotext', 'ffmpeg', 'sips', 'magick'].map((x) => `${x} ${hasTool(x) || (x === 'magick' && hasTool('convert')) ? '✓' : '✗'}`).join('  ');
          const n = week.filter((a) => a.kind === 'media').length;
          console.log(
            `${m.enabled ? '✅' : '➖'} media guard ${m.enabled ? `on: ${n} action(s) in 7 days; shrink images over ${m.imageMaxEdge || 'never'}px, PDFs over ${m.pdfPages} pages go text-first` : 'off (grug config set mediaGuard.enabled true)'}`
          );
          console.log(`   optional helpers: ${tools}   (PNG shrinking works without any; PDF text needs pdftotext, video needs ffmpeg)`);
        }
        {
          const { loadTune } = await import('./recalltune.js');
          const tu = loadTune();
          if (tu.codeShown >= 1) console.log(`ℹ️  code hints used: ${Math.round((tu.codeHit / tu.codeShown) * 100)}% of recent hints (recall strictness ×${tu.strictness.toFixed(2)}, adjusts itself)`);
        }
        if (cfg.memory.enabled) console.log(`✅ memory capture: ${f.n} handoff(s) with durable facts in 7 days`);
      }
      console.log(`${ok(h.codeMcp)} Claude Code MCP server`);
      console.log(`${ok(h.desktopMcp)} Claude Desktop MCP server (${h.desktopPath})`);
      console.log(`${h.service !== 'none' ? '✅' : '➖'} background service: ${h.service}`);
      console.log(`${h.command === 'missing' ? '❌' : '✅'} \`grug\` command ${h.command === 'on-path' ? 'on PATH' : h.command === 'rc' ? 'added to shell startup (open a new terminal)' : 'not on PATH (re-run install)'}`);
      {
        const { checkForUpdate } = await import('./update.js');
        const u = await checkForUpdate();
        console.log(
          u.newer
            ? `⬆️  grugbrain ${u.latest} is available (you have ${u.current}) → run: grug update`
            : `✅ grugbrain up to date${u.latest ? ` (latest release ${u.latest})` : ''}${u.error ? ` (couldn't check GitHub: ${u.error})` : ''}`
        );
      }
      {
        const { brokenIntegrations, fixBrokenIntegrations } = await import('./install.js');
        const broken = brokenIntegrations();
        if (broken.length && flags.has('--fix')) printSteps(fixBrokenIntegrations());
        else if (broken.length) {
          console.log(`❌ ${broken.length} leftover(s) from an uninstalled tool (their program no longer exists; they error in every session):`);
          for (const b of broken) console.log(`   - ${b.label}: ${b.command.slice(0, 110)}`);
          console.log('   → remove them: grug doctor --fix   (backups kept in ~/.grug/backups)');
        } else console.log('✅ no broken hooks / MCP servers left by other tools');
      }
      const upOk = await reachable(cfg.upstream);
      console.log(`${upOk ? '✅' : '❌'} upstream ${cfg.upstream} ${upOk ? 'reachable' : 'NOT reachable (Claude Code requests will fail until it is up)'}`);
      console.log('');
      for (const a of advice(!!up)) console.log(`${a.level === 'fix' ? '🔧' : a.level === 'save' ? '💰' : 'ℹ️ '} ${a.text}${a.cmd ? `\n     → ${a.cmd}` : ''}`);
      break;
    }

    case 'dash':
    case 'dashboard':
    case 'tui':
      await runDashboard({ once: flags.has('--once') });
      break;

    case 'daemon':
      await runDaemon();
      break;

    case 'proxy': {
      const cfg = loadConfig();
      const port = Number(flagValue('port') || cfg.port);
      const h = await startProxy(cfg, port);
      console.log(`grugbrain proxy on http://127.0.0.1:${h.port} -> ${cfg.upstream}`);
      break;
    }

    case 'mcp':
    case 'server':
      runMcpServer();
      break;

    case 'hook': {
      let out: any = null;
      try {
        out = await runHook(pos[1] || '', await readStdinJson());
      } catch {
        out = null; // never break Claude Code
      }
      if (out) process.stdout.write(JSON.stringify(out));
      process.exit(0);
    }

    case 'statusline': {
      try {
        const { renderStatusLine } = await import('./statusline.js');
        process.stdout.write(renderStatusLine(await readStdinText()));
      } catch {
        /* never break the status line */
      }
      process.exit(0);
    }

    case 'live-ping': {
      try {
        const kind = process.argv[3] === 'render' ? 'render' : 'session';
        const f = path.join(paths.home(), 'live-heartbeat.json');
        let j: any = {};
        try {
          j = JSON.parse(fs.readFileSync(f, 'utf8'));
        } catch {
          /* first ping */
        }
        j[kind === 'render' ? 'renderAt' : 'sessionAt'] = Date.now();
        if (kind === 'render') j.renders = (j.renders || 0) + 1;
        fs.writeFileSync(f, JSON.stringify(j));
      } catch {
        /* best effort */
      }
      process.exit(0);
    }

    case 'app-status': {
      try {
        const { appStatus } = await import('./statusline.js');
        const { latestTranscript } = await import('./ctxbreak.js');
        process.stdout.write(JSON.stringify(appStatus(latestTranscript(process.cwd()) || undefined)));
      } catch {
        process.stdout.write('{}');
      }
      process.exit(0);
    }

    case 'maintain': {
      const r = maintain();
      if (!r) console.log('memory busy (another maintenance is running)');
      else if (!process.env.GRUG_QUIET)
        console.log(`memory: +${r.ingested} sessions · folded ${r.folded} · merged ${r.merged} · pruned ${r.pruned} · ${r.nodes} nodes\ngraph: ${r.graph}\nvault: ${r.vaultDir}`);
      break;
    }

    case 'context': {
      // What is filling this session's context? (latest transcript of the current project, or a path)
      const { analyzeTranscript, latestTranscript } = await import('./ctxbreak.js');
      const target = pos[1] && fs.existsSync(pos[1]) ? pos[1] : latestTranscript(flags.has('--all') ? undefined : process.cwd()) || latestTranscript();
      if (!target) throw new Error('no Claude Code transcript found (run inside a project, or pass a transcript path)');
      const b = analyzeTranscript(target);
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      console.log(`🪨 context of ${path.basename(target)}: ~${k(b.total)} tokens in ${b.messages} messages (estimate)\n`);
      for (const x of b.buckets.slice(0, 10)) console.log(`  ${String(Math.round((x.tokens / Math.max(1, b.total)) * 100)).padStart(3)}%  ${k(x.tokens).padStart(7)}  ${x.label} (${x.count})`);
      if (b.biggest.length) {
        console.log('\nbiggest single items:');
        for (const x of b.biggest) console.log(`  ${k(x.tokens).padStart(7)}  ${x.label}`);
      }
      console.log('\nfix: /clear between tasks; grug trims big command output and skips repeat reads/screenshots.');
      break;
    }

    case 'discover': {
      // Where tool output tokens go: biggest command groups first, with what grug already shortened.
      const { discover } = await import('./discover.js');
      const days = Math.max(1, Number(flagValue('--days')) || 7);
      const r = discover({ days });
      const k = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      console.log(`🪨 tool output in the last ${days} day(s): ~${k(r.totalTokens)} tokens from ${r.transcripts} transcript(s) (estimate: characters / 3.6)`);
      if (!r.rows.length) break;
      console.log(`\n${'command'.padEnd(36)}${'runs'.padStart(6)}${'tokens'.padStart(9)}${'biggest'.padStart(9)}  shortened by grug`);
      for (const x of r.rows)
        console.log(`${x.key.slice(0, 35).padEnd(36)}${String(x.runs).padStart(6)}${k(x.tokens).padStart(9)}${k(x.maxTokens).padStart(9)}  ${x.tokens ? Math.round((x.shortenedTokens / x.tokens) * 100) : 0}%`);
      console.log('\nEach result stays in the chat until compaction, so it is re-read on every later reply. File reads (sed, cat, grep) are content Claude asked for; big repeated runs of other commands are candidates for an output rule (open an issue with the command).');
      break;
    }
    case 'slim': {
      // Hide unused plugin skills from the per-reply skill listing (reversible).
      const { applySlim, planSlim, undoSlim } = await import('./slim.js');
      if (flags.has('--undo')) {
        const r = undoSlim();
        console.log(r.ok ? `✅ ${r.restored} skill(s) listed in full again. ${r.message}` : `❌ ${r.message}`);
        break;
      }
      const days = Math.max(7, Number(flagValue('--days')) || 30);
      const plan = planSlim({ days, minObservedDays: flags.has('--include-new') ? 0 : 7 });
      const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
      console.log(`🪨 skill listing: ${plan.listed} skills, ~${k(Math.round(plan.listingChars / 4))} tokens sent with every reply (${plan.transcripts} transcripts, ${plan.observedDays} day(s) of history)`);
      const usedNames = Object.entries(plan.used).sort((a, b) => b[1] - a[1]);
      if (usedNames.length) console.log(`  used in the last ${days} days: ${usedNames.slice(0, 12).map(([n, c]) => `${n} (${c})`).join(', ')}`);
      if (plan.alreadyHidden) console.log(`  already slimmed by grug: ${plan.alreadyHidden}`);
      if (plan.unhide.length) console.log(`  used again, description comes back: ${plan.unhide.join(', ')}`);
      if (!plan.hide.length) console.log('  nothing unused to slim (skills listed for under 7 days wait; --include-new skips the wait).');
      else {
        const byPlugin: Record<string, number> = {};
        for (const h of plan.hide) byPlugin[h.name.split(':')[0]] = (byPlugin[h.name.split(':')[0]] || 0) + 1;
        console.log(`  never used, can list by name only: ${plan.hide.length} skills (${Object.entries(byPlugin).map(([p, n]) => `${p} ${n}`).join(', ')})`);
        console.log(`  saves up to ~${k(plan.savedTokens)} tokens on every reply (estimate; Claude Code may use freed room to un-truncate the skills you do use)`);
      }
      if (!flags.has('--apply')) {
        if (plan.hide.length || plan.unhide.length) console.log('\nrun `grug slim --apply` to do it; `grug slim --undo` puts everything back. Slimmed skills still work (Claude sees the name; /name too).');
        break;
      }
      if (!plan.hide.length && !plan.unhide.length) break;
      const r = applySlim(plan);
      console.log(r.ok ? `✅ slimmed ${plan.hide.length}, restored ${plan.unhide.length}. ${r.message}` : `❌ ${r.message}`);
      break;
    }

    case 'warm': {
      // Background refresh started by SessionStart: code graph + parsed-history caches.
      const dir = path.resolve(pos[1] || process.cwd());
      const cfg = loadConfig();
      const { buildGraphIndex, isCodeProject } = await import('./graph.js');
      const { warmHistory } = await import('./history.js');
      let files = 0;
      if (cfg.graphContext.enabled && isCodeProject(dir)) files = buildGraphIndex(dir)?.files.length || 0;
      const items = cfg.autoRecall.enabled && !flags.has('--graph') ? warmHistory(dir) : 0;
      if (!process.env.GRUG_QUIET) console.log(`warm: ${files} files in code graph, ${items} history items cached for ${dir}`);
      break;
    }

    case 'graph': {
      const r = maintain();
      console.log(`memory graph: ${paths.graphHtml()}${r ? ` (${r.nodes} nodes)` : ''}`);
      if (!flags.has('--no-open')) openPath(paths.graphHtml());
      break;
    }

    case 'vault': {
      const r = maintain();
      console.log(`Obsidian vault: ${r?.vaultDir || path.join(loadConfig().memory.vaultDir, 'grugbrain')}`);
      console.log('Open it in Obsidian → "Open folder as vault". Grug rewrites it automatically; no upkeep needed.');
      console.log('Put it inside your own vault: grug config set memory.vaultDir ~/path/to/YourVault');
      break;
    }

    case 'brief': {
      const cfg = loadConfig();
      const dir = path.resolve(pos[1] || process.cwd());
      const b = buildBrief(loadMemory(), projectKey(dir), cfg.memory.briefTokens, cfg.memory.halfLifeDays);
      console.log(b.text ? `${b.text}\n\n(${b.tokens} tokens)` : 'No memory for this project yet.');
      break;
    }

    case 'recall': {
      const cfg = loadConfig();
      const dir = path.resolve(flagValue('dir') || process.cwd());
      const q = pos.slice(1).join(' ');
      const r = recall(loadMemory(), projectKey(dir), q, cfg.memory.recallTokens * 3, cfg.memory.halfLifeDays);
      console.log(r.text || 'Nothing relevant in memory.');
      break;
    }

    case 'remember': {
      const text = pos.slice(1).join(' ');
      if (!text) throw new Error('usage: grug remember <text>');
      const dir = path.resolve(flagValue('dir') || process.cwd());
      withMemoryLock(() => {
        const db = loadMemory();
        addNote(db, projectKey(dir), text, Date.now(), { pinned: true });
        saveMemory(db);
      });
      console.log(`📌 remembered for ${path.basename(dir)}`);
      break;
    }

    case 'map':
    case 'graphify': {
      const m = repoMap(pos[1] || '.', Number(flagValue('budget') || 1500));
      console.log(m.text);
      console.error(`(~${m.tokens} tokens for ${m.files.length} files)`);
      break;
    }

    case 'outline': {
      if (!pos[1]) throw new Error('usage: grug outline <file>');
      const r = skeletonize(fs.readFileSync(pos[1], 'utf8'), pos[1]);
      console.log(r.skeleton);
      console.error(`(~${r.originalTokens} → ~${r.skeletonTokens} tokens, ${r.percentSaved}% smaller)`);
      break;
    }

    case 'compress': {
      const input = pos[1] === '-' || (!pos[1] && !process.stdin.isTTY) ? await readAllStdin() : pos.slice(1).join(' ');
      if (!input) throw new Error('usage: grug compress <text>   (or pipe text with -)');
      const r = cavemanCompress(input);
      console.log(r.text);
      console.error(`(~${r.originalTokens} → ~${r.compressedTokens} tokens, ${r.percentSaved}% saved)`);
      break;
    }

    case 'config': {
      const sub = pos[1];
      if (sub === 'path') console.log(paths.config());
      else if (sub === 'set') {
        if (!pos[2] || pos[3] === undefined) throw new Error('usage: grug config set <key> <value>');
        setConfigValue(pos[2], pos.slice(3).join(' '));
        console.log(`set ${pos[2]} = ${pos.slice(3).join(' ')}`);
        if (/^(autoCompact|routing)\./.test(pos[2])) {
          const { applyTuningNow } = await import('./install.js');
          printSteps([applyTuningNow()]);
        }
      } else if (sub === 'get') {
        const v = pos[2].split('.').reduce((o: any, k) => (o ? o[k] : undefined), loadConfig());
        console.log(typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v));
      } else console.log(JSON.stringify(loadConfig(), null, 2));
      break;
    }

    case 'bench': {
      const { runBench, formatBench, TASKS } = await import('./bench.js');
      const model = flagValue('model') || 'sonnet';
      const runs = Number(flagValue('runs') || 1);
      const ids = (flagValue('tasks') || '').split(',').filter(Boolean);
      const compare = flagValue('compare') || undefined;
      if (compare) {
        // Check the overrides before spending usage: GRUG_SET ignores bad ones silently.
        const { assignConfigValue } = await import('./config.js');
        const probe = loadConfig();
        for (const pair of compare.split(',')) {
          const i = pair.indexOf('=');
          if (i <= 0) throw new Error(`--compare wants key=value pairs, got "${pair}"`);
          assignConfigValue(probe, pair.slice(0, i).trim(), pair.slice(i + 1));
        }
      }
      const n = (ids.length || TASKS.length) * runs * 2;
      if (!flags.has('--yes')) {
        console.log(`grug bench runs ${n} real Claude Code sessions (model: ${model}). That spends real usage (roughly $0.05–0.40 per session).`);
        console.log(`Tasks: ${TASKS.map((t) => `${t.id} (${t.exercises})`).join(', ')}`);
        console.log('Re-run with --yes to start.');
        break;
      }
      console.log(`🪨 grug bench: ${n} sessions, model ${model}${compare ? `, grug vs grug with ${compare}` : ''}\n`);
      const { results, file } = await runBench({ model, runs, taskIds: ids, compare, log: (l) => console.log(l) });
      console.log('\n' + formatBench(results, compare));
      console.log(`\nreport: ${file}`);
      break;
    }

    case 'update': {
      const { checkForUpdate, installRelease } = await import('./update.js');
      const info = await checkForUpdate(true);
      if (info.error) console.log(`Could not check GitHub: ${info.error}`);
      console.log(`installed: ${info.current}   latest release: ${info.latest ?? 'unknown'}${info.url ? `  (${info.url})` : ''}`);
      if (!info.newer) {
        console.log('Grug up to date.');
        break;
      }
      if (flags.has('--check')) {
        console.log(`Update available. Run: grug update`);
        break;
      }
      console.log(`Updating ${info.current} → ${info.latest} …\n`);
      process.exit(installRelease(info));
    }

    case 'savings': {
      const { callTool } = await import('./mcp.js');
      console.log(callTool('savings', {}));
      break;
    }

    case 'version':
    case '--version':
    case '-v': {
      console.log(VERSION);
      if (flags.has('--check')) {
        const { checkForUpdate } = await import('./update.js');
        const u = await checkForUpdate(true);
        console.log(u.newer ? `newer release: ${u.latest} (run: grug update)` : `latest release: ${u.latest ?? 'unknown'}`);
      }
      break;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${cmd}\n${HELP}`);
      process.exit(1);
  }
}

function reachable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const u = new URL(url);
      const mod = u.protocol === 'http:' ? require('node:http') : require('node:https');
      const req = mod.request({ hostname: u.hostname, port: u.port || undefined, path: u.pathname || '/', method: 'HEAD', timeout: 3000 }, (res: any) => {
        res.resume();
        resolve(true); // any HTTP answer means the gateway is up
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

async function waitForProxy(port: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await proxyHealth(port, 400)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

main().catch((err) => {
  console.error(`grug error: ${err?.message || err}`);
  process.exit(1);
});
