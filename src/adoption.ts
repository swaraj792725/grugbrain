/**
 * Does Claude actually use the graph and memory tools, or just Read/Grep? Counted per session from
 * PostToolUse events and folded into ~/.grug/adoption.json when a session ends or compacts, plus
 * how often a graph-first hint was followed by a ranged read of the hinted file.
 */

import * as path from 'node:path';
import { paths, readJson, writeJsonAtomic } from './config.js';
import { appendBuffer, readBuffer } from './memory/store.js';

export interface Adoption {
  grug: number;
  read: number;
  grep: number;
  glob: number;
  navShown: number;
  navFollowed: number;
}

const file = () => path.join(paths.home(), 'adoption.json');
const WINDOW = 400; // keep the numbers recent: halve when the tool counts pass this

export function loadAdoption(): Adoption {
  const r = readJson<Partial<Adoption>>(file());
  const v = r.ok ? r.value : {};
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
  return { grug: n(v.grug), read: n(v.read), grep: n(v.grep), glob: n(v.glob), navShown: n(v.navShown), navFollowed: n(v.navFollowed) };
}

/** Fold the not-yet-counted events of one session into the running totals. */
export function scoreAdoption(sessionId: string, cwd: string): Adoption {
  const events = readBuffer(sessionId);
  let from = 0;
  events.forEach((e, i) => {
    if (e.t === 'adopted') from = i + 1;
  });
  const fresh = events.slice(from);
  const a = loadAdoption();
  let any = false;
  const root = path.resolve(cwd);
  fresh.forEach((e, i) => {
    if (e.t === 'use') {
      a[e.k]++;
      any = true;
    } else if (e.t === 'nav') {
      a.navShown++;
      any = true;
      // followed = a ranged read (or grug outline/read_symbol/read_lines) of a hinted file afterwards
      const hinted = new Set(e.files);
      const followed = fresh.slice(i + 1).some((x) => x.t === 'file' && x.ranged && hinted.has(path.isAbsolute(x.path) ? path.relative(root, x.path) : x.path));
      if (followed) a.navFollowed++;
    }
  });
  if (!any) return a;
  if (a.grug + a.read + a.grep + a.glob > WINDOW) for (const k of Object.keys(a) as Array<keyof Adoption>) a[k] = Math.round(a[k] / 2);
  writeJsonAtomic(file(), a);
  appendBuffer(sessionId, { t: 'adopted', ts: Date.now() });
  return a;
}
