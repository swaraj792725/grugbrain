/**
 * The background daemon (launchd / systemd keeps it alive):
 *  - runs the API proxy
 *  - runs memory maintenance at start and every 30 minutes
 */

import * as fs from 'node:fs';
import { ensureDir, loadConfig, paths } from './config.js';
import { maintain } from './memory/maintain.js';
import { proxyHealth, startProxy } from './proxy/server.js';

export async function runDaemon(): Promise<void> {
  const cfg = loadConfig();
  ensureDir(paths.home());

  const existing = await proxyHealth(cfg.port);
  if (existing?.name === 'grugbrain') {
    console.log(`grugbrain daemon already running on :${cfg.port}`);
    return;
  }

  const handle = await startProxy(cfg);
  fs.writeFileSync(paths.pid(), String(process.pid));
  console.log(`[${new Date().toISOString()}] grugbrain daemon up: proxy http://127.0.0.1:${handle.port} -> ${cfg.upstream}`);

  const tick = () => {
    try {
      const r = maintain({ quietMs: 10 * 60 * 1000 });
      if (r && r.ingested) console.log(`[${new Date().toISOString()}] memory: +${r.ingested} sessions, ${r.nodes} nodes`);
    } catch (err: any) {
      console.error('maintain failed:', err?.message);
    }
  };
  setTimeout(tick, 5000);
  const timer = setInterval(tick, 30 * 60 * 1000);

  const shutdown = async () => {
    clearInterval(timer);
    await handle.close();
    try {
      if (fs.readFileSync(paths.pid(), 'utf8') === String(process.pid)) fs.unlinkSync(paths.pid());
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => console.error('uncaught:', err));
  process.on('unhandledRejection', (err) => console.error('unhandled:', err));
}
