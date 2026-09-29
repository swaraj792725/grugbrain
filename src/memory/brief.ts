/**
 * Turns the memory graph into small, budgeted context:
 *  - brief(): injected once at session start (what happened here before).
 *  - recall(): injected per prompt, only when something clearly relevant exists.
 */

import { estimateTokens } from '../tokens.js';
import { keywords, MemNode, MemoryDB, neighbors, projectName, projectNodes, score, similarity } from './store.js';

function ago(ts: number, now = Date.now()): string {
  const m = Math.round((now - ts) / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

class Budget {
  lines: string[] = [];
  used = 0;
  constructor(private max: number) {}
  add(line: string): boolean {
    const t = estimateTokens(line) + 1;
    if (this.used + t > this.max) return false;
    this.lines.push(line);
    this.used += t;
    return true;
  }
}

export interface Brief {
  text: string;
  tokens: number;
  ids: string[];
}

export function buildBrief(db: MemoryDB, project: string, budgetTokens: number, halfLife: number, now = Date.now()): Brief {
  const nodes = projectNodes(db, project);
  const sessions = nodes.filter((n) => n.type === 'session').sort((a, b) => b.updated - a.updated);
  const digests = nodes.filter((n) => n.type === 'digest');
  if (!sessions.length && !digests.length && !nodes.some((n) => n.type === 'note')) return { text: '', tokens: 0, ids: [] };
  const ids: string[] = [];
  const b = new Budget(budgetTokens);
  const totalSessions = sessions.length + digests.reduce((s, d) => s + (d.data?.sessions || 0), 0);
  b.add(`[grugbrain memory: ${projectName(project)}, ${totalSessions} past session(s). Auto-maintained; trust but verify against the code.]`);

  const notes = nodes
    .filter((n) => n.type === 'note')
    .sort((a, c) => score(c, halfLife, now) - score(a, halfLife, now));
  const files = nodes
    .filter((n) => n.type === 'file')
    .sort((a, c) => score(c, halfLife, now) - score(a, halfLife, now));

  const last = sessions[0];
  if (last?.data?.outcome) {
    b.add(`Last session (${ago(last.updated, now)}): "${last.label}"`);
    b.add(`  ended with: ${last.data.outcome}`);
    ids.push(last.id);
  }
  const pinned = notes.filter((n) => n.data?.pinned);
  const other = notes.filter((n) => !n.data?.pinned);
  if (pinned.length || other.length) b.add('Remembered:');
  for (const n of [...pinned, ...other].slice(0, 12)) {
    if (!b.add(`- ${n.label}`)) break;
    ids.push(n.id);
  }
  if (files.length) {
    const hot = files.slice(0, 10).map((f) => f.label);
    b.add(`Hot files: ${hot.join(', ')}`);
  }
  if (sessions.length > 1) {
    b.add('Recent sessions:');
    for (const s of sessions.slice(1, 6)) {
      if (!b.add(`- ${ago(s.updated, now)}: ${s.label}`)) break;
      ids.push(s.id);
    }
  }
  const text = b.lines.join('\n');
  return { text, tokens: b.used, ids };
}

export function recall(
  db: MemoryDB,
  project: string,
  prompt: string,
  budgetTokens: number,
  halfLife: number,
  exclude: Set<string> = new Set(),
  now = Date.now()
): Brief {
  const kws = keywords(prompt, 8);
  if (!kws.length) return { text: '', tokens: 0, ids: [] };
  const kwText = kws.join(' ');
  const scored: Array<{ n: MemNode; s: number }> = [];
  for (const n of projectNodes(db, project)) {
    if (exclude.has(n.id) || n.type === 'project') continue;
    let rel = 0;
    const hay = (n.label + ' ' + (n.data?.outcome || '') + ' ' + (n.data?.prompts || []).join(' ')).toLowerCase();
    for (const k of kws) if (hay.includes(k.toLowerCase())) rel += 1;
    if (n.type === 'topic' && kws.includes(n.label)) rel += 1;
    rel += similarity(kwText, hay) * 2;
    if (rel < 1.5) continue;
    scored.push({ n, s: rel * (1 + score(n, halfLife, now)) });
  }
  if (!scored.length) return { text: '', tokens: 0, ids: [] };
  scored.sort((a, c) => c.s - a.s);
  const b = new Budget(budgetTokens);
  b.add('[grugbrain recall: related memory]');
  const ids: string[] = [];
  for (const { n } of scored.slice(0, 6)) {
    let line = '';
    if (n.type === 'note') line = `- note: ${n.label}`;
    else if (n.type === 'session') line = `- ${ago(n.updated, now)} session "${n.label}"${n.data?.outcome ? ` → ${n.data.outcome.slice(0, 140)}` : ''}`;
    else if (n.type === 'digest') line = `- ${n.label}: ${(n.data?.highlights || []).slice(0, 3).join('; ')}`;
    else if (n.type === 'topic') {
      const rel = neighbors(db, n.id)
        .filter((x) => x.node.type === 'file')
        .sort((a, c) => c.w - a.w)
        .slice(0, 5)
        .map((x) => x.node.label);
      if (!rel.length) continue;
      line = `- "${n.label}" usually involves: ${rel.join(', ')}`;
    } else if (n.type === 'file') line = `- file ${n.label} (touched ${n.touches}×)`;
    if (!line || !b.add(line)) continue;
    ids.push(n.id);
  }
  if (!ids.length) return { text: '', tokens: 0, ids: [] };
  return { text: b.lines.join('\n'), tokens: b.used, ids };
}
