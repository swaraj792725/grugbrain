/**
 * Chat <-> Code bridge: a mailbox under ~/.grug/bridge that the Claude desktop chat (through grug's MCP server)
 * and Code sessions (through the grug-live plugin and the Stop hook) both reach.
 *
 *   sessions/<sid>.json   heartbeat the plugin writes every tick: { sid, cwd, busy, seen }
 *   inbox/<id>.json       a message for one Code session: { id, sid, cwd, text, from, at }
 *   delivered/<id>.json   the plugin took it (submitted as a turn, or added to the running one): { id, sid, at, mode }
 *   replies/<id>.json     the Code session's final reply after that turn: { id, sid, cwd, project, text, at, readAt? }
 *
 * The plugin has no delete, so taken messages leave the inbox here (sendToCode / cleanup).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { grugHome } from './config.js';

/** The plugin writes a heartbeat every 15 s; a session silent for longer than this is closed or asleep. */
export const LIVE_MS = 90_000;
const KEEP_MS = 2 * 24 * 3600_000;
const MAX_TEXT = 20_000;

export interface BridgeSession {
  sid: string;
  cwd: string;
  busy?: boolean;
  seen: number;
}
export interface BridgeMessage {
  id: string;
  sid: string;
  cwd: string;
  text: string;
  from: string;
  at: number;
}
export interface BridgeReply {
  id: string;
  sid: string;
  cwd: string;
  project: string;
  /** What was asked, so the chat can tell replies apart. */
  asked: string;
  text: string;
  at: number;
  readAt?: number;
}

export const bridgeDir = () => path.join(grugHome(), 'bridge');
const dir = (sub: string) => path.join(bridgeDir(), sub);

function readJson<T>(f: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as T;
  } catch {
    return null;
  }
}
function writeJson(f: string, v: unknown): void {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
}
function list<T>(sub: string): T[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir(sub)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  return names.map((n) => readJson<T>(path.join(dir(sub), n))).filter((x): x is T => !!x);
}

/** Code sessions with a recent heartbeat, newest first. */
export function liveSessions(now = Date.now()): BridgeSession[] {
  return list<BridgeSession>('sessions')
    .filter((s) => s.sid && s.cwd && now - s.seen < LIVE_MS)
    .sort((a, b) => b.seen - a.seen);
}

/** Pick the session `to` names: a session id (or its start), a folder path, or a project name (exact, then partial). */
export function resolveSession(to: string, sessions = liveSessions()): BridgeSession | null {
  const t = String(to || '').trim();
  if (!sessions.length) return null;
  if (!t) return sessions.length === 1 ? sessions[0] : null;
  const low = t.toLowerCase();
  return (
    sessions.find((s) => s.sid === t) ||
    (t.length >= 6 ? sessions.find((s) => s.sid.startsWith(t)) : undefined) ||
    sessions.find((s) => path.resolve(s.cwd) === path.resolve(t)) ||
    sessions.find((s) => path.basename(s.cwd).toLowerCase() === low) ||
    sessions.find((s) => path.basename(s.cwd).toLowerCase().includes(low)) ||
    null
  );
}

/** The words a Code session sees: who sent it and that its answer goes back. */
export function framed(m: BridgeMessage): string {
  return `[Message from Claude ${m.from} (desktop app) via grugbrain, id ${m.id}]\n${m.text}\n\n(Your final reply this turn is sent back to the ${m.from}.)`;
}

export function sendToCode(to: string, text: string, from = 'chat', now = Date.now()): { msg: BridgeMessage } | { error: string } {
  const body = String(text || '').trim();
  if (!body) return { error: 'Nothing to send: text is empty.' };
  const sessions = liveSessions(now);
  const s = resolveSession(to, sessions);
  if (!s) {
    const names = sessions.map((x) => `${path.basename(x.cwd)} (${x.sid.slice(0, 8)})`).join(', ');
    return {
      error: sessions.length
        ? `No open Code session matches "${to}". Open ones: ${names}.`
        : 'No Code session is open (or grug-live is not loaded there). Open a Code session in the desktop app first.'
    };
  }
  cleanup(now);
  const msg: BridgeMessage = { id: `${now.toString(36)}-${randomBytes(3).toString('hex')}`, sid: s.sid, cwd: s.cwd, text: body.slice(0, MAX_TEXT), from, at: now };
  writeJson(path.join(dir('inbox'), `${msg.id}.json`), msg);
  return { msg };
}

/** Messages for this session the plugin has not taken yet (what the plugin itself does, for the CLI and tests). */
export function pendingFor(sid: string): BridgeMessage[] {
  return list<BridgeMessage>('inbox')
    .filter((m) => m.sid === sid && !fs.existsSync(path.join(dir('delivered'), `${m.id}.json`)))
    .sort((a, b) => a.at - b.at);
}

export function markDelivered(m: BridgeMessage, mode: 'turn' | 'note', now = Date.now()): void {
  writeJson(path.join(dir('delivered'), `${m.id}.json`), { id: m.id, sid: m.sid, at: now, mode });
}

export function heartbeat(s: BridgeSession): void {
  writeJson(path.join(dir('sessions'), `${s.sid}.json`), s);
}

/**
 * Stop hook: the session's final reply answers every message delivered to it since its last reply.
 * Returns how many replies were written.
 */
export function recordReplies(sid: string, cwd: string, text: string, now = Date.now()): number {
  if (!text.trim() || !fs.existsSync(dir('delivered'))) return 0;
  const taken = list<{ id: string; sid: string; at: number }>('delivered').filter(
    (d) => d.sid === sid && d.at <= now && !fs.existsSync(path.join(dir('replies'), `${d.id}.json`))
  );
  for (const d of taken) {
    const m = readJson<BridgeMessage>(path.join(dir('inbox'), `${d.id}.json`));
    const r: BridgeReply = { id: d.id, sid, cwd, project: path.basename(cwd), asked: (m?.text || '').slice(0, 200), text: text.slice(0, MAX_TEXT), at: now };
    writeJson(path.join(dir('replies'), `${d.id}.json`), r);
  }
  return taken.length;
}

export function replyFor(id: string): BridgeReply | null {
  return readJson<BridgeReply>(path.join(dir('replies'), `${id}.json`));
}

/** Wait for the reply to one message (the chat's ask_code with wait). Polls the file once a second. */
export async function waitReply(id: string, ms: number, stepMs = 1000): Promise<BridgeReply | null> {
  const end = Date.now() + ms;
  for (;;) {
    const r = replyFor(id);
    if (r) return markRead(r);
    if (Date.now() >= end) return null;
    await new Promise((res) => setTimeout(res, Math.min(stepMs, Math.max(0, end - Date.now()))));
  }
}

function markRead(r: BridgeReply, now = Date.now()): BridgeReply {
  if (!r.readAt) writeJson(path.join(dir('replies'), `${r.id}.json`), { ...r, readAt: now });
  return r;
}

/** Replies the chat has not read yet (marked read once returned), oldest first. `all` also shows read ones from the last day. */
export function inbox(all = false, now = Date.now()): BridgeReply[] {
  const rs = list<BridgeReply>('replies')
    .filter((r) => (all ? now - r.at < 24 * 3600_000 : !r.readAt))
    .sort((a, b) => a.at - b.at);
  for (const r of rs) markRead(r, now);
  return rs;
}

/** Messages sent but not answered yet: waiting for the session to take them, or being worked on. */
export function outstanding(): { msg: BridgeMessage; delivered: boolean }[] {
  return list<BridgeMessage>('inbox')
    .filter((m) => !fs.existsSync(path.join(dir('replies'), `${m.id}.json`)))
    .map((m) => ({ msg: m, delivered: fs.existsSync(path.join(dir('delivered'), `${m.id}.json`)) }))
    .sort((a, b) => a.msg.at - b.msg.at);
}

/** Drop old files: answered messages, replies and heartbeats older than two days. */
export function cleanup(now = Date.now()): void {
  for (const sub of ['inbox', 'delivered', 'replies', 'sessions']) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir(sub));
    } catch {
      continue;
    }
    for (const n of names) {
      const f = path.join(dir(sub), n);
      try {
        if (now - fs.statSync(f).mtimeMs > KEEP_MS) fs.rmSync(f, { force: true });
      } catch {
        /* raced */
      }
    }
  }
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
}

export function sessionsText(now = Date.now()): string {
  const ss = liveSessions(now);
  if (!ss.length) return 'No Code session is open (grug-live writes a heartbeat from each open Code session in the desktop app).';
  return ss.map((s) => `- ${path.basename(s.cwd)} · ${s.busy ? 'working' : 'idle'} · seen ${ago(now - s.seen)} ago · ${s.cwd} · id ${s.sid.slice(0, 8)}`).join('\n');
}

export function replyText(r: BridgeReply, now = Date.now()): string {
  return `From Code (${r.project}, ${ago(now - r.at)} ago) to "${r.asked.slice(0, 80)}${r.asked.length > 80 ? '…' : ''}":\n${r.text}`;
}
