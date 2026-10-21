/**
 * Shared bits of the Antigravity and Codex adapters: grug's Claude Code wording put in the other
 * app's tool names, a per-conversation queue of notes for the model, and per-process config
 * overrides (things only Claude Code has, like its auto-compact window, are turned off).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir } from '../config.js';
import { runHook } from '../hooks.js';
import { foreignDir, syncShadow, type Client } from './shadow.js';

/** Claude Code tool words in grug's hints -> the other app's tools. */
export function reword(client: Client, text: string): string {
  if (!text) return text;
  if (client === 'antigravity') {
    return text
      .replace(/repeat the same Read/g, 'repeat the same view_file call')
      .replace(/\bRead (just (?:that|these line) ranges?|it) with offset\/limit/g, 'view $1 with view_file StartLine/EndLine')
      .replace(/\bRead with offset\/limit\b/g, 'view_file with StartLine/EndLine')
      .replace(/\ba ranged Read\b/g, 'a ranged view_file')
      .replace(/\bA ranged Read\b/g, 'A ranged view_file')
      .replace(/\bGrep\b/g, 'grep_search')
      .replace(/\bone Bash call\b/g, 'one command')
      .replace(/\s*\((?:that|a ranged view_file) also satisfies Edit\)/g, '')
      .replace(/the grugbrain outline tool/gi, 'the grugbrain outline MCP tool');
  }
  return text
    .replace(/repeat the same Read and it will be allowed/g, 'repeat the same command and it will be allowed')
    .replace(/\bRead (just (?:that|these line) ranges?|it) with offset\/limit/g, "print $1 with sed -n 'START,ENDp'")
    .replace(/\bRead with offset\/limit\b/g, "sed -n 'START,ENDp' on just that part")
    .replace(/\ba ranged Read\b/g, "a ranged sed -n")
    .replace(/\bA ranged Read\b/g, 'A ranged sed -n')
    .replace(/\bGrep\b/g, 'rg')
    .replace(/\s*\((?:that|a ranged sed -n) also satisfies Edit\)/g, '')
    .replace(/\bone Bash call\b/g, 'one shell command');
}

/** First words of the context grug adds as a (persistent) user message in Antigravity; never a prompt. */
export const AG_CONTEXT_MARK = '[grugbrain context';

/** Run `fn` with extra GRUG_SET overrides (restored afterwards). */
export async function withOverrides<T>(pairs: string[], fn: () => Promise<T>): Promise<T> {
  const before = process.env.GRUG_SET;
  process.env.GRUG_SET = [before, ...pairs].filter(Boolean).join(',');
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.GRUG_SET;
    else process.env.GRUG_SET = before;
  }
}

/**
 * Off for every other app: the Claude Code auto-compact window (it would rewrite ~/.claude/settings.json),
 * the user-only notices (these apps have no channel for them) and the app summary line.
 * On: the re-read guard (Claude Code answers unchanged re-reads itself; these apps re-send the file).
 */
export const FOREIGN_OVERRIDES = ['autoCompact.guard=false', 'autoCompact.auto=false', 'appSummary.enabled=false', 'contextAlert.enabled=false', 'idleAlert.enabled=false', 'rereadGuard.enabled=true'];
/** At the start: the rules file already carries the short-reply style and the batch rule. */
export const START_OVERRIDES = ['terse=off', 'batching.rule=false'];

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
const notesPath = (client: Client, sid: string) => path.join(foreignDir(), `${client}-${safe(sid)}.notes.json`);
const metaPath = (client: Client, sid: string) => path.join(foreignDir(), `${client}-${safe(sid)}.meta.json`);

/** Notes for the model that this app can only deliver later (Antigravity: next model call). */
export function queueNote(client: Client, sid: string, text: string): void {
  if (!text) return;
  try {
    ensureDir(foreignDir());
    const f = notesPath(client, sid);
    let list: string[] = [];
    try {
      list = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      /* none yet */
    }
    if (!list.includes(text)) list.push(text);
    fs.writeFileSync(f, JSON.stringify(list.slice(-8)));
  } catch {
    /* best-effort */
  }
}

export function takeNotes(client: Client, sid: string): string[] {
  const f = notesPath(client, sid);
  try {
    const list = JSON.parse(fs.readFileSync(f, 'utf8'));
    fs.rmSync(f, { force: true });
    return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export interface ConvMeta {
  started?: boolean;
  /** The last prompt recall ran for (the same prompt is never recalled twice). */
  prompt?: string;
}

export function loadMeta(client: Client, sid: string): ConvMeta {
  try {
    return JSON.parse(fs.readFileSync(metaPath(client, sid), 'utf8'));
  } catch {
    return {};
  }
}

export function saveMeta(client: Client, sid: string, m: ConvMeta): void {
  try {
    ensureDir(foreignDir());
    fs.writeFileSync(metaPath(client, sid), JSON.stringify(m));
  } catch {
    /* best-effort */
  }
}

/** The additionalContext text of a runHook result, if any. */
export const contextOf = (out: any): string => String(out?.hookSpecificOutput?.additionalContext || '');

/** End-of-turn upkeep in the background: handoff for the next session, final facts, recall scoring. */
export async function agentEnd(client: Client, conv: string, cwd: string, source?: string, model?: string): Promise<void> {
  const transcript = syncShadow(client, conv, source || undefined, model || undefined, cwd);
  const sid = `${client === 'antigravity' ? 'ag' : 'cx'}-${conv}`;
  await withOverrides(FOREIGN_OVERRIDES, () => runHook('session-end', { session_id: sid, transcript_path: transcript, cwd, reason: 'other' }));
}
