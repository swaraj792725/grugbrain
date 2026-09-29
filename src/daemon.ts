/**
 * The background daemon (launchd / systemd keeps it alive):
 *  - runs the API proxy
 *  - runs memory maintenance at start and every 30 minutes
 */

import * as fs from 'node:fs';
import { ensureDir, loadConfig, paths } from './config.js';
import { maintain } from './memory/maintain.js';
import { proxyHealth, startProxy } from './proxy/server.js';
import { cachedUpdate, checkForUpdate } from './update.js';
import { recordActivity } from './stats.js';

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
  const updateTick = async () => {
    if (!loadConfig().updateCheck) return;
    const before = cachedUpdate();
    const info = await checkForUpdate();
    if (info.newer && before?.latest !== info.latest) recordActivity({ kind: 'update', msg: `grugbrain ${info.latest} is available (installed ${info.current}). Run: grug update` });
  };
  setTimeout(() => updateTick().catch(() => {}), 15000);
  const updTimer = setInterval(() => updateTick().catch(() => {}), 6 * 3600 * 1000);
  setTimeout(tick, 5000);
  const timer = setInterval(tick, 30 * 60 * 1000);

  const shutdown = async () => {
    clearInterval(timer);
    clearInterval(updTimer);
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
