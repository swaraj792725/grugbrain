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
import { readStdinJson, runHook, spawnDetached } from './hooks.js';
import { health, install, Step, uninstall } from './install.js';
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
const VALUE_FLAGS = new Set(['--dir', '--port', '--budget', '--model', '--runs', '--tasks']);
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
  grug maintain                   ingest + consolidate memory now (normally automatic)
  grug warm [dir] [--graph]       refresh code-graph + history caches for a project (normally automatic)

  grug map [dir] [--budget 1500]  ranked repo map under a token budget
  grug outline <file>             skeleton of a source file
  grug compress <text | ->        strip filler from text (stdin with -)

  grug bench [--model sonnet] [--runs 1] [--tasks a,b] --yes
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

    case 'maintain': {
      const r = maintain();
      if (!r) console.log('memory busy (another maintenance is running)');
      else if (!process.env.GRUG_QUIET)
        console.log(`memory: +${r.ingested} sessions · folded ${r.folded} · merged ${r.merged} · pruned ${r.pruned} · ${r.nodes} nodes\ngraph: ${r.graph}\nvault: ${r.vaultDir}`);
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
      const n = (ids.length || TASKS.length) * runs * 2;
      if (!flags.has('--yes')) {
        console.log(`grug bench runs ${n} real Claude Code sessions (model: ${model}). That spends real usage (roughly $0.05–0.40 per session).`);
        console.log(`Tasks: ${TASKS.map((t) => `${t.id} (${t.exercises})`).join(', ')}`);
        console.log('Re-run with --yes to start.');
        break;
      }
      console.log(`🪨 grug bench: ${n} sessions, model ${model}\n`);
      const { results, file } = await runBench({ model, runs, taskIds: ids, log: (l) => console.log(l) });
      console.log('\n' + formatBench(results));
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
