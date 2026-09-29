/**
 * One maintenance pass: ingest pending sessions -> consolidate -> export vault -> render graph.
 * Runs after every session end (detached) and every 30 min in the daemon. Guarded by a lock
 * file so concurrent hooks/daemon never clobber memory.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, loadConfig, paths } from '../config.js';
import { recordActivity } from '../stats.js';
import { writeGraphHtml } from './graphhtml.js';
import { consolidate, ingestPending, loadMemory, MemoryDB, saveMemory } from './store.js';
import { exportVault } from './vault.js';

const LOCK_STALE_MS = 60000;

export function withMemoryLock<T>(fn: () => T): T | null {
  ensureDir(paths.home());
  const lock = path.join(paths.home(), 'memory.lock');
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      try {
        return fn();
      } finally {
        try {
          fs.unlinkSync(lock);
        } catch {
          /* ignore */
        }
      }
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock);
      } catch {
        /* raced */
      }
      const until = Date.now() + 50;
      while (Date.now() < until) {
        /* brief spin: hooks are short-lived, no event loop to yield to */
      }
    }
  }
  return null;
}

export interface MaintainResult {
  ingested: number;
  folded: number;
  merged: number;
  pruned: number;
  nodes: number;
  vaultDir: string;
  graph: string;
}

export function maintain(opts: { quietMs?: number } = {}): MaintainResult | null {
  const cfg = loadConfig();
  return withMemoryLock(() => {
    const db: MemoryDB = loadMemory();
    const ingested = ingestPending(db, opts.quietMs ?? 0);
    const rep = consolidate(db, cfg.memory);
    saveMemory(db);
    let vaultDir = '';
    try {
      vaultDir = exportVault(db, cfg.memory.vaultDir, cfg.memory.halfLifeDays).dir;
    } catch {
      /* vault is best-effort */
    }
    try {
      writeGraphHtml(db, paths.graphHtml(), cfg.memory.halfLifeDays);
    } catch {
      /* best-effort */
    }
    if (ingested || rep.folded || rep.merged || rep.pruned) {
      recordActivity({
        kind: 'consolidate',
        msg: `Memory: +${ingested} session(s), folded ${rep.folded}, merged ${rep.merged}, pruned ${rep.pruned} → ${rep.nodes} nodes`
      });
    }
    return { ingested, ...rep, vaultDir, graph: paths.graphHtml() };
  });
}
