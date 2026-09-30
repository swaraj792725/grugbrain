/**
 * Convention recall at edit time. Memory is normally surfaced when a prompt matches; but a rule like
 * "config.ts changes need the validator updated" matters at the moment Claude edits config.ts, even if the
 * prompt never named it. Before an Edit/Write, surface the stored notes that name that file (or its folder),
 * once per session each, 2 at most. Silent when memory has nothing about the file.
 */

import * as path from 'node:path';
import { GrugConfig, paths } from './config.js';
import { MemNode, appendBuffer, loadMemory, projectKey, projectNodes, readBuffer } from './memory/store.js';
import { recordActivity } from './stats.js';
import { estimateTokens } from './tokens.js';

const KINDS = new Set(['decision', 'cause', 'preference', 'rule', 'fix']);
const GENERIC_DIRS = new Set(['src', 'lib', 'app', 'test', 'tests', 'dist', 'build', 'index', 'main', 'utils', 'common']);

/** Names that identify a file in prose: its base name (config) and its file name (config.ts). */
export function fileNeedles(file: string, cwd: string): string[] {
  const rel = path.relative(cwd, file).split(path.sep).join('/');
  const base = path.posix.basename(rel);
  const stem = base.replace(/\.[^.]+$/, '');
  const dir = path.posix.basename(path.posix.dirname(rel));
  const out = [base.toLowerCase()];
  if (stem.length >= 5 && !GENERIC_DIRS.has(stem.toLowerCase())) out.push(stem.toLowerCase());
  if (dir.length >= 5 && dir !== '.' && !GENERIC_DIRS.has(dir.toLowerCase())) out.push(`${dir.toLowerCase()}/`);
  return out;
}

function matches(n: MemNode, needles: string[]): boolean {
  const text = n.label.toLowerCase();
  return needles.some((nd) => new RegExp(`(^|[^a-z0-9_])${nd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(text));
}

export function conventionHint(cfg: GrugConfig, sid: string, cwd: string, file: string, now: number): string | null {
  if (!cfg.quality.conventions || !cfg.memory.enabled || !file) return null;
  const abs = path.resolve(file);
  if (!abs.startsWith(path.resolve(cwd) + path.sep)) return null;
  const needles = fileNeedles(abs, path.resolve(cwd));
  const db = loadMemory();
  const project = projectKey(cwd);
  const global = projectKey(path.join(paths.home(), 'global'));
  const pool = [...projectNodes(db, project), ...(global !== project ? projectNodes(db, global) : [])].filter(
    (n) => n.type === 'note' && (n.data?.pinned || KINDS.has(String(n.data?.kind || ''))) && matches(n, needles)
  );
  if (!pool.length) return null;
  const done = new Set<string>();
  for (const e of readBuffer(sid)) {
    if (e.t === 'compact') done.clear();
    else if (e.t === 'injected') e.ids.forEach((i) => done.add(i));
  }
  const fresh = pool
    .filter((n) => !done.has(n.id))
    .sort((a, b) => b.updated - a.updated)
    .slice(0, 2);
  if (!fresh.length) return null;
  const lines = fresh.map((n) => `- ${n.label.replace(/\s+/g, ' ').slice(0, 220)}`);
  const text = `[grugbrain: notes about ${path.basename(abs)} from earlier work; verify before relying]\n${lines.join('\n')}`;
  appendBuffer(sid, { t: 'injected', ts: now, ids: fresh.map((n) => n.id) });
  recordActivity({ kind: 'convention', msg: `Surfaced ${fresh.length} stored note(s) before editing ${path.basename(abs)}`, tokens: -estimateTokens(text), project: path.basename(cwd) });
  return text;
}
