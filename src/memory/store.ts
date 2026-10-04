/**
 * Memory graph: projects, sessions, files, topics, notes, digests.
 *
 * Why it never piles up:
 *  - Every node's score decays (half-life, default 14 days) unless it keeps getting used.
 *  - Sessions older than `foldAfterDays` are folded into one monthly digest per project.
 *  - Near-duplicate notes are merged; each project is capped at `maxNodesPerProject`.
 *  - What gets injected into Claude is chosen by score under a fixed token budget,
 *    so the context cost per session is flat no matter how much history exists.
 *
 * Capture is automatic via Claude Code hooks writing to ~/.grug/sessions/<id>.jsonl.
 * Ingest is idempotent: re-ingesting a session rebuilds its node from its buffer.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { ensureDir, GrugConfig, paths, readJson, writeJsonAtomic } from '../config.js';

export type NodeType = 'project' | 'session' | 'file' | 'topic' | 'note' | 'digest';

export interface MemNode {
  id: string;
  type: NodeType;
  label: string;
  project: string;
  created: number;
  updated: number;
  weight: number;
  touches: number;
  data?: any;
}

export interface MemEdge {
  a: string;
  b: string;
  w: number;
}

export interface MemoryDB {
  version: 1;
  nodes: Record<string, MemNode>;
  edges: Record<string, MemEdge>;
}

export type BufferEvent =
  | { t: 'start'; ts: number; cwd: string; source?: string }
  | { t: 'prompt'; ts: number; text: string }
  | { t: 'file'; ts: number; path: string; op: 'read' | 'edit'; ranged?: boolean }
  | { t: 'cmd'; ts: number; cmd: string }
  | { t: 'assistant'; ts: number; text: string }
  | { t: 'injected'; ts: number; ids: string[] }
  | { t: 'read'; ts: number; path: string; key: string; mtime: number; size: number }
  | { t: 'skip'; ts: number; key: string }
  | { t: 'compact'; ts: number }
  | { t: 'alert'; ts: number; level: number }
  | { t: 'idle'; ts: number; since: number }
  | { t: 'shot'; ts: number; key: string; tokens: number }
  | { t: 'mcp'; ts: number; name: string; ro: boolean }
  | { t: 'img'; ts: number; tokens: number; src: string }
  | { t: 'guided'; ts: number }
  | { t: 'use'; ts: number; k: 'grug' | 'read' | 'grep' | 'glob' }
  | { t: 'nav'; ts: number; key: string; files: string[] }
  | { t: 'verify'; ts: number; sig: string; ok: boolean | null; ms: number; fp?: string }
  | { t: 'adopted'; ts: number }
  | { t: 'boundary'; ts: number; prompts: number }
  | { t: 'shrunk'; ts: number; key: string }
  | { t: 'imgalert'; ts: number; level: number }
  | { t: 'facts'; ts: number; items: Array<{ kind: string; text: string; ts: number }>; offset?: number; failed?: string[] }
  | { t: 'factscan'; ts: number; offset: number; failed: string[] }
  | { t: 'recall'; ts: number; keys: string[]; tokens: number; files?: string[] }
  | { t: 'scored'; ts: number }
  | { t: 'nudge'; ts: number; k: 'batch' }
  | { t: 'end'; ts: number; reason?: string };

const DAY = 86400000;
const MAX_FACTS_PER_PROJECT = 60;

// ---------- persistence ----------

export function loadMemory(): MemoryDB {
  const r = readJson<MemoryDB>(paths.memory());
  if (r.ok && r.value && (r.value as any).nodes) return r.value;
  return { version: 1, nodes: {}, edges: {} };
}

export function saveMemory(db: MemoryDB): void {
  writeJsonAtomic(paths.memory(), db);
}

export function projectKey(cwd: string): string {
  const base = path.basename(path.resolve(cwd)) || 'root';
  const h = createHash('sha1').update(path.resolve(cwd)).digest('hex').slice(0, 6);
  return `${base}~${h}`;
}

export function projectName(key: string): string {
  return key.split('~')[0];
}

function sessionFile(id: string): string {
  return path.join(paths.sessions(), `${id.replace(/[^\w.-]/g, '_')}.jsonl`);
}

export function appendBuffer(sessionId: string, ev: BufferEvent): void {
  try {
    ensureDir(paths.sessions());
    fs.appendFileSync(sessionFile(sessionId), JSON.stringify(ev) + '\n', 'utf8');
  } catch {
    /* never break the hook */
  }
}

export function readBuffer(sessionId: string): BufferEvent[] {
  let text = '';
  try {
    text = fs.readFileSync(sessionFile(sessionId), 'utf8');
  } catch {
    return [];
  }
  const out: BufferEvent[] = [];
  for (const l of text.split('\n')) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* torn line */
    }
  }
  return out;
}

// ---------- graph helpers ----------

function edgeKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function link(db: MemoryDB, a: string, b: string, w = 1) {
  const k = edgeKey(a, b);
  const e = db.edges[k];
  if (e) e.w += w;
  else db.edges[k] = { a, b, w };
}

function upsert(db: MemoryDB, n: Omit<MemNode, 'created' | 'updated' | 'weight' | 'touches'> & Partial<MemNode>, ts: number): MemNode {
  const cur = db.nodes[n.id];
  if (cur) {
    cur.updated = Math.max(cur.updated, ts);
    if (n.label) cur.label = n.label;
    if (n.data) cur.data = { ...cur.data, ...n.data };
    return cur;
  }
  const node: MemNode = { weight: 1, touches: 0, created: ts, updated: ts, ...n } as MemNode;
  db.nodes[n.id] = node;
  return node;
}

function removeNode(db: MemoryDB, id: string) {
  delete db.nodes[id];
  for (const [k, e] of Object.entries(db.edges)) if (e.a === id || e.b === id) delete db.edges[k];
}

export function neighbors(db: MemoryDB, id: string): Array<{ node: MemNode; w: number }> {
  const out: Array<{ node: MemNode; w: number }> = [];
  for (const e of Object.values(db.edges)) {
    const other = e.a === id ? e.b : e.b === id ? e.a : null;
    if (other && db.nodes[other]) out.push({ node: db.nodes[other], w: e.w });
  }
  return out;
}

export function score(n: MemNode, halfLifeDays: number, now = Date.now()): number {
  if (n.type === 'project') return Infinity;
  const age = Math.max(0, now - n.updated) / DAY;
  const pinned = n.data?.pinned ? 3 : 0;
  return (n.weight + pinned + Math.log1p(n.touches)) * Math.pow(0.5, age / halfLifeDays);
}

// ---------- text heuristics ----------

const STOP = new Set(
  ('the a an and or but if then else for to of in on at by with from into onto over under this that these those it its is are was were be been being ' +
    'do does did done can could should would will shall may might must have has had not no yes you your we our i me my they them their he she ' +
    'what which who whom when where why how all any each few more most other some such only own same so than too very just also now here there ' +
    'please make sure want need like use using used file files code let lets get got add fix show tell help thing things work working way new one two ' +
    'never always again still really directly broken issue problem error errors check look see try trying think know able into about after before then because while there their')
    .split(' ')
);

export function keywords(text: string, max = 5): string[] {
  const counts = new Map<string, number>();
  const idents = text.match(/[A-Za-z_][A-Za-z0-9_]*(?:[A-Z][a-z0-9]+)+|[a-z]+_[a-z0-9_]+/g) || [];
  for (const w of idents) counts.set(w, (counts.get(w) || 0) + 2);
  for (const w of text.toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) || []) {
    if (STOP.has(w)) continue;
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max).map(([w]) => w);
}

const NOTE_RE = /\b(root cause|the fix|fixed by|fixed it|decided|decision|we chose|chose to|because|note that|important|gotcha|workaround|caveat|todo|must not|never|always|convention)\b/i;

export function extractNotes(text: string, max = 3): string[] {
  const out: string[] = [];
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/`/g, '');
  for (const raw of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/^[\s\-*#>\d.)]+/, '').trim();
    if (s.length < 30 || s.length > 240) continue;
    if (!NOTE_RE.test(s)) continue;
    if (/^(let me|i'll|i will|now i|next,? i)/i.test(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

function words(s: string): Set<string> {
  return new Set(s.toLowerCase().match(/[a-z0-9]+/g) || []);
}

export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------- ingest ----------

export function addNote(db: MemoryDB, project: string, text: string, ts = Date.now(), opts: { pinned?: boolean; from?: string; kind?: string; auto?: boolean } = {}): MemNode {
  // Merge into an existing similar note instead of piling up.
  for (const n of Object.values(db.nodes)) {
    if (n.type === 'note' && n.project === project && similarity(n.label, text) >= 0.6) {
      // Count each source session once, so re-ingesting a session never inflates a note.
      const sources: string[] = n.data?.sources || [];
      if (!opts.from || !sources.includes(opts.from)) {
        n.touches++;
        n.updated = Math.max(n.updated, ts);
        if (opts.from) n.data = { ...n.data, sources: [...sources, opts.from].slice(-20) };
      }
      if (text.length > n.label.length) n.label = text;
      if (opts.pinned && !n.data?.pinned) n.data = { ...n.data, pinned: true, ...(opts.auto ? { auto: true } : {}) };
      if (opts.kind && !n.data?.kind) n.data = { ...n.data, kind: opts.kind };
      if (opts.from) link(db, n.id, opts.from);
      return n;
    }
  }
  const id = `note:${project}:${createHash('sha1').update(text).digest('hex').slice(0, 10)}`;
  const node = upsert(
    db,
    {
      id,
      type: 'note',
      label: text,
      project,
      weight: opts.pinned ? 3 : opts.kind === 'preference' ? 2.2 : 1.5,
      data: { pinned: !!opts.pinned, ...(opts.pinned && opts.auto ? { auto: true } : {}), sources: opts.from ? [opts.from] : [], ...(opts.kind ? { kind: opts.kind } : {}) }
    },
    ts
  );
  link(db, node.id, `project:${project}`);
  if (opts.from) link(db, node.id, opts.from);
  for (const k of keywords(text, 2)) {
    const tid = `topic:${project}:${k}`;
    if (db.nodes[tid]) link(db, node.id, tid);
  }
  return node;
}

export function ingestSession(db: MemoryDB, sessionId: string, events = readBuffer(sessionId)): MemNode | null {
  const start = events.find((e) => e.t === 'start') as Extract<BufferEvent, { t: 'start' }> | undefined;
  const cwd = start?.cwd;
  if (!cwd) return null;
  const project = projectKey(cwd);
  const prompts = events.filter((e) => e.t === 'prompt') as Array<Extract<BufferEvent, { t: 'prompt' }>>;
  const fileEvs = events.filter((e) => e.t === 'file') as Array<Extract<BufferEvent, { t: 'file' }>>;
  const cmds = events.filter((e) => e.t === 'cmd').length;
  const lastAssistant = [...events].reverse().find((e) => e.t === 'assistant') as Extract<BufferEvent, { t: 'assistant' }> | undefined;
  if (!prompts.length && !fileEvs.length) return null;

  const t0 = start!.ts;
  const t1 = Math.max(...events.map((e) => e.ts));
  const pid = `project:${project}`;
  upsert(db, { id: pid, type: 'project', label: projectName(project), project, data: { path: cwd } }, t1);

  const sid = `session:${sessionId}`;
  // Idempotent: drop this session's old edges before relinking.
  for (const [k, e] of Object.entries(db.edges)) if (e.a === sid || e.b === sid) delete db.edges[k];
  const label = oneLine(prompts[0]?.text || `worked on ${fileEvs[0]?.path}`, 70);
  const session = upsert(
    db,
    {
      id: sid,
      type: 'session',
      label,
      project,
      data: {
        started: t0,
        ended: t1,
        prompts: prompts.slice(0, 4).map((p) => oneLine(p.text, 160)),
        promptCount: prompts.length,
        commands: cmds,
        outcome: lastAssistant ? oneLine(lastAssistant.text, 280) : ''
      }
    },
    t1
  );
  session.touches = prompts.length;
  session.weight = 1 + Math.min(3, prompts.length / 4);
  link(db, sid, pid);

  const fileCounts = new Map<string, { n: number; edits: number; ts: number }>();
  for (const f of fileEvs) {
    const rel = path.isAbsolute(f.path) ? path.relative(cwd, f.path) : f.path;
    if (!rel || rel.startsWith('..')) continue;
    const c = fileCounts.get(rel) || { n: 0, edits: 0, ts: 0 };
    c.n++;
    if (f.op === 'edit') c.edits++;
    c.ts = Math.max(c.ts, f.ts);
    fileCounts.set(rel, c);
  }
  for (const [rel, c] of fileCounts) {
    const fid = `file:${project}:${rel}`;
    upsert(db, { id: fid, type: 'file', label: rel, project }, c.ts);
    link(db, sid, fid, c.n + c.edits * 2);
    link(db, fid, pid, 0);
  }

  const REMEMBER_RE = /^\s*(?:remember|note|grug remember)\s*[:,-]?\s+/i;
  const topicText = prompts
    .filter((p) => !REMEMBER_RE.test(p.text))
    .map((p) => p.text)
    .join('\n');
  for (const k of keywords(topicText, 5)) {
    const tid = `topic:${project}:${k}`;
    upsert(db, { id: tid, type: 'topic', label: k, project }, t1);
    link(db, sid, tid);
    link(db, tid, pid, 0);
  }

  for (const p of prompts) {
    const m = p.text.match(/^\s*(?:remember|note|grug remember)\s*[:,-]?\s+(.{8,400})/i);
    if (m) addNote(db, project, m[1].trim(), p.ts, { pinned: true, from: sid });
  }
  if (lastAssistant) for (const n of extractNotes(lastAssistant.text)) addNote(db, project, n, lastAssistant.ts, { from: sid });
  // Durable facts picked from the transcript at handoff time (decisions, root causes, preferences, commands).
  for (const ev of events)
    if (ev.t === 'facts')
      for (const f of ev.items || [])
        if (f?.text) addNote(db, project, String(f.text).slice(0, 400), f.ts || ev.ts, { from: sid, kind: f.kind, ...(isStandingRule(f) ? { pinned: true, auto: true } : {}) });
  capAutoPins(db, project);

  recomputeTouches(db, project);
  session.data.ingestedAt = Date.now();
  return session;
}

/** A standing instruction from the user ("never merge until I say", "always use pnpm"), not a one-off request. */
const STANDING_RULE = /^(?:User preference:\s*)?(?:please\s+)?(?:always|never|from now on|don'?t|do not|no more|stop|make sure (?:to|you)|prefer)\b/i;
export function isStandingRule(f: { kind?: string; text?: string }): boolean {
  return f.kind === 'preference' && STANDING_RULE.test(String(f.text || '')) && String(f.text).length >= 25;
}

/** Auto-pinned rules never decay or fold, so keep their number small (the brief budget stays fixed). Manual pins are untouched. */
export const MAX_AUTO_PINS = 6;
export function capAutoPins(db: MemoryDB, project: string): void {
  const auto = Object.values(db.nodes)
    .filter((n) => n.type === 'note' && n.project === project && n.data?.pinned && n.data?.auto)
    .sort((a, b) => b.updated - a.updated);
  for (const n of auto.slice(MAX_AUTO_PINS)) n.data = { ...n.data, pinned: false, auto: false };
}

/** touches for files/topics are derived from edges, so re-ingesting never double counts. */
function recomputeTouches(db: MemoryDB, project: string) {
  const deg = new Map<string, number>();
  for (const e of Object.values(db.edges)) {
    for (const [x, y] of [[e.a, e.b], [e.b, e.a]]) {
      const n = db.nodes[x];
      const o = db.nodes[y];
      if (!n || !o || n.project !== project) continue;
      if ((n.type === 'file' || n.type === 'topic') && (o.type === 'session' || o.type === 'digest' || o.type === 'note'))
        deg.set(x, (deg.get(x) || 0) + e.w);
    }
  }
  for (const n of Object.values(db.nodes)) {
    if (n.project === project && (n.type === 'file' || n.type === 'topic')) {
      n.touches = deg.get(n.id) || 0;
      // last time any linked session touched it
      let last = n.updated;
      for (const { node } of neighbors(db, n.id)) if (node.type === 'session') last = Math.max(last, node.updated);
      n.updated = last;
    }
  }
}

// ---------- consolidation ----------

export interface ConsolidateReport {
  folded: number;
  merged: number;
  pruned: number;
  nodes: number;
}

export function consolidate(db: MemoryDB, cfg: GrugConfig['memory'], now = Date.now()): ConsolidateReport {
  const rep: ConsolidateReport = { folded: 0, merged: 0, pruned: 0, nodes: 0 };
  const projects = new Set(Object.values(db.nodes).map((n) => n.project));

  for (const project of projects) {
    // 1. Fold old sessions into monthly digests.
    for (const s of Object.values(db.nodes)) {
      if (s.type !== 'session' || s.project !== project) continue;
      if (now - s.updated < cfg.foldAfterDays * DAY) continue;
      const month = new Date(s.data?.started || s.updated).toISOString().slice(0, 7);
      const did = `digest:${project}:${month}`;
      const d = upsert(
        db,
        { id: did, type: 'digest', label: `${projectName(project)} ${month}`, project, data: { sessions: 0, prompts: 0, highlights: [] } },
        s.updated
      );
      d.data.sessions = (d.data.sessions || 0) + 1;
      d.data.prompts = (d.data.prompts || 0) + (s.data?.promptCount || 0);
      const hl: string[] = d.data.highlights || [];
      if (hl.length < 12) hl.push(s.label);
      d.data.highlights = hl;
      d.weight = Math.min(5, 1 + d.data.sessions / 5);
      d.touches += s.touches;
      for (const { node, w } of neighbors(db, s.id)) if (node.id !== did) link(db, did, node.id, w);
      removeNode(db, s.id);
      try {
        fs.unlinkSync(sessionFile(s.id.slice('session:'.length)));
      } catch {
        /* already gone */
      }
      rep.folded++;
    }

    // 2. Merge near-duplicate notes.
    const notes = Object.values(db.nodes).filter((n) => n.type === 'note' && n.project === project);
    for (let i = 0; i < notes.length; i++) {
      const a = notes[i];
      if (!db.nodes[a.id]) continue;
      for (let j = i + 1; j < notes.length; j++) {
        const b = notes[j];
        if (!db.nodes[b.id] || similarity(a.label, b.label) < 0.6) continue;
        a.touches += b.touches + 1;
        a.weight = Math.max(a.weight, b.weight);
        a.updated = Math.max(a.updated, b.updated);
        if (b.data?.pinned) a.data = { ...a.data, pinned: true };
        if (b.label.length > a.label.length) a.label = b.label;
        for (const { node, w } of neighbors(db, b.id)) if (node.id !== a.id) link(db, a.id, node.id, w);
        removeNode(db, b.id);
        rep.merged++;
      }
    }

    // 3. Auto-captured facts get their own cap, so they never crowd out sessions and files.
    const facts = Object.values(db.nodes)
      .filter((n) => n.type === 'note' && n.project === project && n.data?.kind && !n.data?.pinned)
      .sort((x, y) => score(y, cfg.halfLifeDays, now) - score(x, cfg.halfLifeDays, now));
    for (const n of facts.slice(MAX_FACTS_PER_PROJECT)) {
      removeNode(db, n.id);
      rep.pruned++;
    }

    // 4. Cap node count by score (projects, digests and pinned notes are kept).
    recomputeTouches(db, project);
    const prunable = Object.values(db.nodes)
      .filter((n) => n.project === project && n.type !== 'project' && n.type !== 'digest' && !n.data?.pinned)
      .sort((x, y) => score(x, cfg.halfLifeDays, now) - score(y, cfg.halfLifeDays, now));
    const total = Object.values(db.nodes).filter((n) => n.project === project).length;
    let excess = total - cfg.maxNodesPerProject;
    for (const n of prunable) {
      if (excess <= 0) break;
      if (n.type === 'session' && now - n.updated < 2 * DAY) continue;
      removeNode(db, n.id);
      excess--;
      rep.pruned++;
    }
    // Forget stale, unused trivia even under the cap.
    for (const n of Object.values(db.nodes)) {
      if (n.project !== project || (n.type !== 'topic' && n.type !== 'file')) continue;
      if (score(n, cfg.halfLifeDays, now) < 0.05) {
        removeNode(db, n.id);
        rep.pruned++;
      }
    }
  }
  for (const [k, e] of Object.entries(db.edges)) if (!db.nodes[e.a] || !db.nodes[e.b]) delete db.edges[k];
  rep.nodes = Object.keys(db.nodes).length;
  return rep;
}

/** Ingest every session buffer that changed since its last ingest (catches missed SessionEnd). */
export function ingestPending(db: MemoryDB, quietMs = 0): number {
  let n = 0;
  let files: string[] = [];
  try {
    files = fs.readdirSync(paths.sessions()).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const f of files) {
    const id = f.replace(/\.jsonl$/, '');
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(paths.sessions(), f)).mtimeMs;
    } catch {
      continue;
    }
    if (now - mtime < quietMs) continue;
    const node = db.nodes[`session:${id}`];
    if (node && (node.data?.ingestedAt || 0) >= mtime) continue;
    if (ingestSession(db, id)) n++;
    else if (now - mtime > 7 * DAY) {
      try {
        fs.unlinkSync(path.join(paths.sessions(), f));
      } catch {
        /* ignore */
      }
    }
  }
  return n;
}

export function projectNodes(db: MemoryDB, project: string): MemNode[] {
  return Object.values(db.nodes).filter((n) => n.project === project);
}
