/**
 * Handoffs: continue in a fresh, small context instead of dragging (or /compact-ing) a huge one.
 *
 * `/compact` sends the whole conversation to the model again to summarize it. `/clear` costs
 * nothing, and grug writes a handoff from what it already recorded (session log + transcript
 * tail): goal, latest requests, where it got to, open todos, files, commands. No model call.
 * The next session in the project starts with the handoff (~1k tokens) instead of ~500k.
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { paths, readJson, writeJsonAtomic } from './config.js';
import { projectKey, readBuffer, similarity } from './memory/store.js';
import { isTrivialPrompt } from './relevance.js';
import { estimateTokens, priceFor, CACHE_READ_MULT, CACHE_WRITE_MULT, CACHE_WRITE_1H_MULT } from './tokens.js';

export interface Handoff {
  ts: number;
  sessionId: string;
  project: string;
  contextTokens: number;
  text: string;
  consumedBy?: string;
}

const file = (project: string) => path.join(paths.home(), 'handoffs', `${project.replace(/[^\w.~-]/g, '_')}.json`);

export function readTail(p: string, bytes: number): string {
  try {
    const fd = fs.openSync(p, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const t = buf.toString('utf8');
    return len < size ? t.slice(t.indexOf('\n') + 1) : t;
  } catch {
    return '';
  }
}

/** Parsed JSONL entries from the tail of a transcript. */
export function transcriptEntries(p: string | undefined, bytes = 1024 * 1024): any[] {
  if (!p) return [];
  const out: any[] = [];
  for (const l of readTail(p, bytes).split('\n')) {
    if (!l) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* torn */
    }
  }
  return out;
}

/**
 * Complete transcript lines appended since `offset` (0 = from the start, or the last `maxBytes`
 * of a huge file). Returns the new offset to resume from, so each byte is parsed once.
 */
export function transcriptEntriesFrom(p: string | undefined, offset: number, maxBytes = 4 * 1024 * 1024): { entries: any[]; offset: number; size: number } {
  const none = { entries: [] as any[], offset, size: 0 };
  if (!p) return none;
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      let from = offset > size ? 0 : offset; // truncated or replaced file: start over
      const jumped = size - from > maxBytes;
      if (jumped) from = size - maxBytes;
      if (size === from) return { entries: [], offset: from, size };
      let buf: Buffer = Buffer.alloc(size - from);
      fs.readSync(fd, buf, 0, buf.length, from);
      if (jumped && from > 0) {
        // landed mid-line: skip to the next line start
        const nl = buf.indexOf(10);
        if (nl < 0) return { entries: [], offset: size, size };
        from += nl + 1;
        buf = buf.subarray(nl + 1);
      }
      const lastNl = buf.lastIndexOf(10);
      if (lastNl < 0) return { entries: [], offset: from, size }; // no complete line yet
      const out: any[] = [];
      for (const l of buf.subarray(0, lastNl + 1).toString('utf8').split('\n')) {
        if (!l) continue;
        try {
          out.push(JSON.parse(l));
        } catch {
          /* torn */
        }
      }
      return { entries: out, offset: from + lastNl + 1, size };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return none;
  }
}

/** Tokens in context for the latest request (what the next reply will re-read) + its model. */
type ContextSize = { tokens: number; model: string; lastReplyTs: number; oneHourCache: boolean };
let sizeMemo: { key: string; value: ContextSize } | null = null;

export function contextSize(transcriptPath?: string): ContextSize {
  // Several prompt-time checks ask for the same transcript: read it once per change.
  let key = '';
  try {
    if (transcriptPath) {
      const st = fs.statSync(transcriptPath);
      key = `${transcriptPath}|${st.mtimeMs}|${st.size}`;
    }
  } catch {
    /* no transcript */
  }
  if (key && sizeMemo?.key === key) return sizeMemo.value;
  const value = computeContextSize(transcriptPath);
  if (key) sizeMemo = { key, value };
  return value;
}

function computeContextSize(transcriptPath?: string): ContextSize {
  const es = transcriptEntries(transcriptPath, 2 * 1024 * 1024);
  // Did any recent reply write the 1-hour cache tier? Then an idle gap under an hour keeps the cache warm.
  const oneHourCache = es.some((e) => e?.type === 'assistant' && (e.message?.usage?.cache_creation?.ephemeral_1h_input_tokens || 0) > 0);
  let pending = 0; // tool results / prompts added after the last reply (not in any usage yet)
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    const m = e?.message;
    if (e?.isSidechain) continue;
    if (e?.type === 'assistant' && m?.usage) {
      const u = m.usage;
      return {
        tokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) + pending,
        model: m.model || '',
        lastReplyTs: Date.parse(e.timestamp) || 0,
        oneHourCache
      };
    }
    if (e?.type === 'user' && m?.content) pending += estimateTokens(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  }
  return { tokens: pending, model: '', lastReplyTs: 0, oneHourCache };
}

/** Rough $ per reply at this context size (mostly cache reads) — shown to the user only. */
export function costPerReply(tokens: number, model: string): number {
  return (tokens * priceFor(model).input * CACHE_READ_MULT) / 1e6;
}

/** What an idle gap costs: the reply after the cache expired re-writes the whole context instead of reading it. */
export function coldCacheCost(tokens: number, model: string, oneHour: boolean): { cold: number; warm: number } {
  const p = priceFor(model).input;
  return { cold: (tokens * p * (oneHour ? CACHE_WRITE_1H_MULT : CACHE_WRITE_MULT)) / 1e6, warm: (tokens * p * CACHE_READ_MULT) / 1e6 };
}

function oneLine(s: string, n: number): string {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

/** Plain prose for a handoff: code blocks, markdown marks and line breaks gone, list items kept as " · ". */
function plain(s: string): string {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '· ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SENTENCE_BREAK = /(?<=[.!?:;])\s+|(?=· )/;

function cutWords(x: string, n: number, fromEnd = false): string {
  if (x.length <= n) return x;
  const y = fromEnd ? x.slice(-n) : x.slice(0, n);
  const sp = fromEnd ? y.indexOf(' ') : y.lastIndexOf(' ');
  const ok = fromEnd ? sp >= 0 && sp < n * 0.5 : sp > n * 0.5;
  const z = ok ? (fromEnd ? y.slice(sp + 1) : y.slice(0, sp)) : y;
  return fromEnd ? '…' + z : z + '…';
}

/**
 * Shorten prose to about `n` characters without losing its ending: whole sentences from the start
 * and from the end, "[…]" between. The end of a reply is where the result, the open question or
 * the next step usually is, so cutting only the tail (as a plain slice does) loses the most.
 */
export function squeeze(text: string, n: number): string {
  const t = plain(text);
  if (t.length <= n) return t;
  const sents = t.split(SENTENCE_BREAK).filter(Boolean);
  const hb = Math.floor(n * 0.55);
  const tb = n - hb - 5;
  const head: string[] = [];
  let hl = 0;
  for (const x of sents) {
    if (hl + x.length + 1 > hb) break;
    head.push(x);
    hl += x.length + 1;
  }
  const tail: string[] = [];
  let tl = 0;
  for (let i = sents.length - 1; i >= head.length; i--) {
    if (tl + sents[i].length + 1 > tb) break;
    tail.unshift(sents[i]);
    tl += sents[i].length + 1;
  }
  // One sentence longer than the whole budget (a list, a log paste, no full stops): keep both of its ends.
  const cutInside = !head.length || !tail.length;
  if (!head.length) head.push(cutWords(sents[0], hb));
  if (!tail.length) tail.push(cutWords(sents[sents.length - 1], tb, true));
  const gap = cutInside || sents.length - head.length - tail.length > 0 ? ' […] ' : ' ';
  return head.join(' ') + gap + tail.join(' ');
}

/** The last sentences of a text, up to about `n` characters (what a short reply such as "yes" answered). */
function endOf(text: string, n: number): string {
  const sents = plain(text).split(SENTENCE_BREAK).filter(Boolean);
  const out: string[] = [];
  let len = 0;
  for (let i = sents.length - 1; i >= 0; i--) {
    if (len + sents[i].length + 1 > n && out.length) break;
    out.unshift(sents[i]);
    len += sents[i].length + 1;
  }
  return cutWords(out.join(' '), n, true);
}

function assistantText(e: any): string {
  const c = e?.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n');
}

const PROMPT_NOISE = /^\s*(\[grugbrain|<system-reminder>|<command-|<local-command|Caveat:)/;

/** A real message typed by the user (not a tool result, not something injected by Claude Code or a hook). */
function isPromptEntry(e: any): boolean {
  if (e?.type !== 'user' || e.isMeta) return false;
  const c = e.message?.content;
  if (typeof c === 'string') return c.trim() !== '' && !PROMPT_NOISE.test(c);
  if (!Array.isArray(c) || c.some((b: any) => b?.type === 'tool_result')) return false;
  const t = c.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n');
  return t.trim() !== '' && !PROMPT_NOISE.test(t);
}

/**
 * The question the last reply ended on, if the user has not answered yet (a session that ended or
 * was cleared while Claude waited for a decision). Null once any work or message follows it.
 */
export function pendingQuestion(es: any[]): string | null {
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    if (!e || e.isSidechain || e.isMeta) continue;
    if (e.type === 'user') {
      if (isPromptEntry(e) || (Array.isArray(e.message?.content) && e.message.content.some((b: any) => b?.type === 'tool_result'))) return null;
      continue;
    }
    if (e.type !== 'assistant') continue;
    const c = e.message?.content;
    if (Array.isArray(c) && c.some((b: any) => b?.type === 'tool_use')) return null; // still working after any text
    const t = plain(assistantText(e));
    if (!t) continue;
    const asks = t.split(SENTENCE_BREAK).filter(Boolean).slice(-3).filter((x) => x.includes('?'));
    return asks.length ? oneLine(asks.join(' '), 260) : null;
  }
  return null;
}

/** The main-chain reply just before `ts`: what a short follow-up like "yes" or "merge it" referred to. */
function replyBefore(es: any[], ts: number): string {
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    if (e?.type !== 'assistant' || e.isSidechain) continue;
    if ((Date.parse(e.timestamp) || 0) >= ts) continue;
    const t = assistantText(e);
    if (t.trim()) return t;
  }
  return '';
}

function openTodos(es: any[]): string[] {
  for (let i = es.length - 1; i >= 0; i--) {
    const c = es[i]?.message?.content;
    if (es[i]?.type !== 'assistant' || !Array.isArray(c)) continue;
    for (let j = c.length - 1; j >= 0; j--) {
      const b = c[j];
      if (b?.type === 'tool_use' && /todo/i.test(b.name || '') && Array.isArray(b.input?.todos)) {
        return b.input.todos
          .filter((t: any) => t && t.status !== 'completed')
          .map((t: any) => `[${t.status || 'pending'}] ${oneLine(t.content || t.activeForm || t.title || '', 140)}`);
      }
    }
  }
  return [];
}

// A check is a command that starts with a test/build/lint tool (not one that merely mentions it in a message).
const CHECK_START = /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check)\b|npx\s+(?:vitest|jest|tsc|eslint)\b|vitest\b|jest\b|pytest\b|tox\b|ruff\b|mypy\b|cargo\s+(?:test|build|clippy)\b|go\s+(?:test|build|vet)\b|tsc\b|make\b|gradle\b|\.\/gradlew\b|mvn\b|dotnet\s+(?:test|build)\b)/;
const FAIL_OUT = /\b(exit code [1-9]|command failed|npm ERR!|FAILED|FAIL\b|error TS\d+|Traceback \(most recent|panic:|\d+ failed)/;
const PASS_LINE = /\b(\d+\s+(?:passed|passing)|Tests?\s+.*passed|test result: ok|build succeeded|0 errors|All checks passed|ok\s+\S+\s+[\d.]+s)\b/i;

/** The check inside a command line: no `cd x &&`, no env prefix, no `2>&1`, no `| tail` trimming. */
export function checkSegment(cmd: string): string | null {
  if (cmd.length > 240 || cmd.includes('\n')) return null;
  for (const seg of cmd.replace(/^\s*cd\s+[^&;]+&&\s*/, '').split(/\s*(?:&&|;)\s*/)) {
    const s = seg.replace(/^(?:[A-Z_][A-Z0-9_]*=\S*\s+)+/, '').trim();
    if (!CHECK_START.test(s)) continue;
    return s.replace(/\s*\d?>&\d/g, '').replace(/\s*\|\s*(?:tail|head|grep|egrep|tee|cat|wc)\b.*$/, '').trim() || null;
  }
  return null;
}

function resultText(c: any): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n');
}

/**
 * Where the work stands: the last test/build/lint command and whether it passed (judged from its
 * output, not from anyone's claim). `editTimes` (file-edit timestamps) adds "N edits since".
 */
export function lastCheck(es: any[], editTimes: number[] = [], dirtyMtimes: number[] = []): string | null {
  const pending = new Map<string, string>();
  let last: { cmd: string; ok: boolean; line: string; ts: number } | null = null;
  for (const e of es) {
    if (!e || e.isSidechain) continue;
    const c = e.message?.content;
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (e.type === 'assistant' && b?.type === 'tool_use' && b.name === 'Bash' && typeof b.input?.command === 'string') {
        const seg = checkSegment(b.input.command);
        if (seg) pending.set(b.id, seg);
      } else if (e.type === 'user' && b?.type === 'tool_result' && pending.has(b.tool_use_id)) {
        const cmd = pending.get(b.tool_use_id)!;
        pending.delete(b.tool_use_id);
        const out = resultText(b.content);
        const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
        const failing = (l: string) => FAIL_OUT.test(l.replace(/\b0 failed\b/gi, ''));
        const bad = b.is_error === true || failing(out);
        let line = '';
        if (bad) {
          // The failing test or error first, then the count line when it says something else.
          const hits = lines.filter(failing);
          const first = hits[0] || lines[0] || '';
          const count = hits.find((l) => /\d+ failed/.test(l) && l !== first);
          line = count ? `${oneLine(first, 90)} · ${oneLine(count, 50)}` : first;
        } else line = lines.filter((l) => PASS_LINE.test(l)).pop() || ''; // the summary comes last ("Tests" after "Test Files")
        last = { cmd, ok: !bad, line: oneLine(line, 150), ts: Date.parse(e.timestamp) || 0 };
      }
    }
  }
  if (!last) return null;
  const since = last.ts ? editTimes.filter((t) => t > last!.ts).length : 0;
  // Edits made by shell commands are not in editTimes; uncommitted files newer than the check show them.
  const newer = !since && last.ts && dirtyMtimes.some((t) => t > last!.ts);
  const verdict = last.ok ? (last.line ? 'passed' : 'no failure output') : 'FAILED';
  return `Last check: \`${oneLine(last.cmd, 70)}\` → ${verdict}${last.line ? ` (${last.line})` : ''}${since ? `; ${since} file edit${since > 1 ? 's' : ''} since` : newer ? '; files changed since' : ''}`;
}

export interface GitState {
  branch: string;
  /** Commits not pushed to the upstream branch (-1 when there is no upstream). */
  ahead: number;
  behind: number;
  /** Changed and untracked paths, relative to the project directory. */
  dirty: string[];
  /** Last commit: short hash, subject, age. */
  last: string;
  /** Commits made since the session began (newest first): short hash + subject. */
  commits: string[];
  /** Files those commits touched. */
  committed: string[];
}

/**
 * Read-only git facts for the handoff. Never takes a lock (GIT_OPTIONAL_LOCKS=0); null when not a repo or git is
 * missing/slow. All git calls share one time budget, because the hooks that call this have 5-10 s to finish
 * (and must still save the handoff).
 */
export function gitState(cwd: string, sinceMs = 0, budgetMs = 2500): GitState | null {
  const deadline = Date.now() + budgetMs;
  const run = (args: string[]): string | null => {
    const left = deadline - Date.now();
    if (left < 50) return null;
    try {
      const r = spawnSync('git', ['-c', 'color.ui=false', '-c', 'core.quotepath=off', ...args], {
        cwd,
        encoding: 'utf8',
        timeout: left,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
      });
      return r.status === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  };
  const st = run(['status', '-sb', '--untracked-files=normal']);
  if (st === null) return null;
  const lines = st.split('\n').filter(Boolean);
  const head = (lines.find((l) => l.startsWith('## ')) || '## ').slice(3);
  const m = head.match(/^(.*?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/);
  const gone = /gone/.test(m?.[3] || '');
  const branch = (m?.[1] || head).replace(/^No commits yet on /, '') || '(detached)';
  const counts = m?.[3] || '';
  const hasUpstream = !!m?.[2] && !gone;
  const dirty = lines
    .filter((l) => !l.startsWith('## '))
    .map((l) => l.slice(3).replace(/^.* -> /, '').replace(/^"|"$/g, ''))
    .filter(Boolean);
  const log = run(['log', '-1', '--format=%h%x09%s%x09%cr'])?.trim().split('\t') || [];
  const commits: string[] = [];
  const committed = new Set<string>();
  if (sinceMs > 0) {
    for (const chunk of (run(['log', `--since=${Math.floor(sinceMs / 1000)}`, '-n', '12', '--format=%x01%h %s', '--name-only']) || '').split('\x01').filter(Boolean)) {
      const [subject, ...files] = chunk.split('\n').map((x) => x.trim()).filter(Boolean);
      if (subject) commits.push(oneLine(subject, 80));
      files.forEach((f) => committed.add(f));
    }
  }
  return {
    branch,
    ahead: hasUpstream ? Number(counts.match(/ahead (\d+)/)?.[1] || 0) : -1,
    behind: Number(counts.match(/behind (\d+)/)?.[1] || 0),
    dirty,
    last: log.length >= 2 ? `${log[0]} "${oneLine(log[1], 70)}"${log[2] ? ` (${log[2]})` : ''}` : '',
    commits,
    committed: [...committed]
  };
}

/** One line: branch, what is not pushed, what is uncommitted, last commit. */
export function gitLine(g: GitState): string {
  const parts = [`branch \`${g.branch}\``];
  if (g.ahead > 0) parts.push(`${g.ahead} commit${g.ahead > 1 ? 's' : ''} not pushed`);
  else if (g.ahead < 0 && g.last) parts.push('no upstream (not pushed)');
  if (g.behind > 0) parts.push(`${g.behind} behind upstream`);
  const shown = g.dirty.slice(0, 10);
  parts.push(g.dirty.length ? `${g.dirty.length} uncommitted: ${shown.join(', ')}${g.dirty.length > shown.length ? `, +${g.dirty.length - shown.length} more` : ''}` : 'working tree clean');
  if (g.last) parts.push(`last commit ${g.last}`);
  return `Git: ${parts.join(' · ')}`;
}

/** What was committed while this session ran: the work that is done and saved, not visible in the uncommitted list. */
export function commitsLine(g: GitState): string {
  if (!g.commits.length) return '';
  const shown = g.commits.slice(0, 4).map((c) => {
    const sp = c.indexOf(' ');
    return `${c.slice(0, sp)} "${c.slice(sp + 1)}"`;
  });
  const files = g.committed.slice(0, 8);
  return `Committed this session: ${shown.join(' · ')}${g.commits.length > 4 ? ` · +${g.commits.length - 4} more` : ''}${files.length ? ` (files: ${files.join(', ')}${g.committed.length > files.length ? ', …' : ''})` : ''}`;
}

// Looking at things is not progress: keep the commands that changed or verified something.
const READ_ONLY = /^(?:ls|cat|head|tail|grep|egrep|rg|find|wc|echo|printf|pwd|which|file|stat|tree|less|more|sed\s+-n|awk|cut|sort|uniq|diff|curl|sleep|true|cd|mkdir\s+-p|node\s+(?:-v|--version)|git\s+(?:status|diff|log|show|branch|fetch|remote|config|rev-parse|ls-files|blame)|npm\s+(?:ls|view|outdated))\b/;

/** Recent commands worth remembering: no heredoc scripts, no read-only looking around; compound lines keep their doing parts. */
export function meaningfulCommands(cmds: string[], max = 5): string[] {
  const out: string[] = [];
  for (const raw of cmds) {
    if (raw.includes('\n') || raw.includes('<<') || raw.includes('$(cat')) continue;
    const segs = raw
      .replace(/^\s*cd\s+[^&;]+&&\s*/, '')
      .split(/\s*(?:&&|;)\s*/)
      .map((x) => x.trim())
      .filter((x) => x && !READ_ONLY.test(x));
    if (!segs.length) continue;
    const line = oneLine(segs.join(' && ').replace(/\s*\d?>&\d/g, '').replace(/\s*\|\s*(?:tail|head|grep|egrep|tee|cat|wc)\b.*$/, ''), 90);
    const at = out.indexOf(line);
    if (at >= 0) out.splice(at, 1);
    out.push(line);
  }
  return out.slice(-max);
}

/**
 * True when every trigger phrase in a sentence sits inside double quotes: the sentence talks about
 * the words ("a 'root cause' line") instead of stating a cause or a decision. A leading
 * "Root cause:" label added by the extractor is ignored.
 */
export function quotedOnly(sentence: string, trigger: RegExp): boolean {
  const s = sentence.replace(/^Root cause:\s*/, '');
  const re = new RegExp(trigger.source, trigger.flags.includes('g') ? trigger.flags : trigger.flags + 'g');
  let seen = 0;
  for (const m of s.matchAll(re)) {
    seen++;
    const before = s.slice(0, m.index);
    const quotes = (before.match(/["\u201c\u201d]/g) || []).length;
    if (quotes % 2 === 0) return false;
  }
  return seen > 0;
}

const CORRECTION = /^(?:no[,.!]?\s|nope|wrong|that'?s not|not like that|don'?t|do not|stop|never|always|instead|actually|i said|i meant|from now on|please don'?t)/i;
const SUBSTANTIVE = 25;

interface Block {
  pri: number;
  order: number;
  lines: string[];
}

export function buildHandoff(sessionId: string, transcriptPath: string | undefined, cwd: string, maxTokens = 1200, withGit = true): Handoff | null {
  const buf = readBuffer(sessionId);
  const prompts = buf.filter((e) => e.t === 'prompt') as Array<{ t: 'prompt'; ts: number; text: string }>;
  const es = transcriptEntries(transcriptPath);
  const timed = es
    .filter((e) => e?.type === 'assistant' && !e.isSidechain)
    .map((e) => ({ ts: Date.parse(e.timestamp) || 0, text: assistantText(e) }))
    .filter((r) => r.text.trim());
  const replies = timed.map((r) => r.text);
  if (!prompts.length && !replies.length) return null;

  const edited = new Map<string, number>();
  const read = new Map<string, number>();
  const editTimes: number[] = [];
  for (const e of buf) {
    if (e.t !== 'file') continue;
    const rel = path.isAbsolute(e.path) ? path.relative(cwd, e.path) : e.path;
    if (!rel || rel.startsWith('..')) continue;
    const m = e.op === 'edit' ? edited : read;
    m.set(rel, (m.get(rel) || 0) + 1);
    if (e.op === 'edit') editTimes.push(e.ts);
  }
  const cmds = (buf.filter((e) => e.t === 'cmd') as Array<{ cmd: string }>).map((c) => c.cmd);
  const ctx = contextSize(transcriptPath);
  const project = projectKey(cwd);
  const began = (buf.find((e) => e.t === 'start') as { ts: number } | undefined)?.ts || prompts[0]?.ts || 0;
  const git = withGit ? gitState(cwd, began) : null;
  const dirtyMtimes = (git?.dirty || []).slice(0, 30).flatMap((f) => {
    try {
      return [fs.statSync(path.join(cwd, f)).mtimeMs];
    } catch {
      return [];
    }
  });

  const header =
    `[grugbrain handoff: continuing work from a previous session in ${path.basename(cwd)} (its context was ${Math.round(ctx.tokens / 1000)}k tokens; not loaded). ` +
    `Pick up from here; check files before assuming, and ask the user if something is unclear.]`;
  const footer = 'Need an exact detail from before (an error, a decision, a snippet)? Search the full earlier conversation with the grugbrain `history` tool instead of guessing.';

  // The current task is the latest substantive request, not the first message (which may be long gone).
  const substantive = prompts.filter((p) => !isTrivialPrompt(p.text) && p.text.trim().length >= SUBSTANTIVE);
  const current = substantive[substantive.length - 1] || prompts[prompts.length - 1];
  const first = prompts[0];
  const latest = prompts[prompts.length - 1];
  const facts = buf.flatMap((e) => (e.t === 'facts' ? e.items || [] : []));
  const factLines = (kinds: string[], n: number) => {
    const seen: string[] = [];
    for (const f of facts.slice().reverse()) {
      if (!kinds.includes(f.kind) || seen.some((x) => similarity(x, f.text) >= 0.6)) continue;
      if (f.kind === 'decision' || f.kind === 'cause') {
        const t = f.text.replace(/^Root cause:\s*/, '');
        if (quotedOnly(t, /\b(root cause|decided|decision:|caused by|because|the fix)\b/i)) continue;
      }
      seen.push(f.text);
      if (seen.length >= n) break;
    }
    return seen.reverse();
  };
  const prefs = factLines(['preference'], 4);
  for (const p of prompts.slice(-12)) {
    const t = p.text.trim().split(/\n/)[0];
    if (t.length >= 15 && t.length <= 200 && CORRECTION.test(t) && !t.endsWith('?') && !prefs.some((x) => similarity(x, t) >= 0.5)) prefs.push(`User: ${oneLine(t, 180)}`);
  }

  const blocks: Block[] = [];
  const block = (pri: number, order: number, lines: string[]) => lines.length && blocks.push({ pri, order, lines });
  if (current) block(1, 1, [`Goal: ${squeeze(current.text, 360)}`]);
  // A short follow-up ("yes", "merge it") is the freshest thing the user said; keep what it answered.
  if (latest && current && latest !== current && !latest.text.trim().startsWith('/')) {
    const before = replyBefore(es, latest.ts);
    block(1, 2, [`Latest message: "${oneLine(latest.text, 160)}"${before ? ` (replying to: ${endOf(before, 240)})` : ''}`]);
  }
  const ask = pendingQuestion(es);
  block(2, 3, ask ? [`Waiting on the user, the last reply asked: ${ask}`] : []);
  block(2, 4, prefs.length ? ['Rules from the user (keep following them):', ...prefs.slice(-5).map((x) => `- ${oneLine(x, 180)}`)] : []);
  block(2, 5, git ? [gitLine(git)] : []);
  const todos = openTodos(es);
  block(3, 6, todos.length ? ['Open todos:', ...todos.slice(0, 10).map((t) => `- ${t}`)] : []);
  const check = lastCheck(es, editTimes, dirtyMtimes);
  block(3, 7, check ? [check] : []);
  // What was said since the current request is where the work is; replies from before it belong to an earlier task.
  const after = current ? timed.filter((r) => r.ts >= current.ts - 1000).map((r) => r.text) : replies;
  const pool = after.length ? after : replies;
  const subst = pool.filter((r) => r.trim().length >= 160);
  // Mostly one-line progress notes since the request? Keep a few of them instead of two fragments.
  const notes = pool.filter((r) => r.trim().length >= 30);
  const last = subst.length ? subst.slice(-2) : notes.length ? notes.slice(-3) : pool.slice(-2);
  block(4, 8, last.length ? [after.length ? 'Where it got to (last replies):' : 'Last replies (before the goal above, about the previous task):', ...last.map((r, i) => `> ${squeeze(r, i === last.length - 1 ? 700 : 350)}`)] : []);
  const dec = factLines(['decision', 'cause'], 4);
  block(5, 9, dec.length ? ['Decisions and causes so far:', ...dec.map((x) => `- ${oneLine(x, 200)}`)] : []);
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  // With git, the uncommitted files and the commits made this session come from git itself (it sees shell edits too).
  if (git) block(6, 10, [commitsLine(git)].filter(Boolean));
  else block(6, 10, edited.size ? [`Files changed: ${top(edited).slice(0, 15).join(', ')}`] : []);
  const recent = substantive.filter((p) => p !== current).slice(-3);
  block(7, 11, recent.length ? ['Earlier requests:', ...recent.map((p) => `- ${oneLine(p.text, 200)}`)] : []);
  if (first && current && first !== current && !isTrivialPrompt(first.text)) block(8, 12, [`Started with: ${oneLine(first.text, 140)}`]);
  const did = meaningfulCommands(cmds);
  block(9, 13, did.length ? [`Recent commands: ${did.join(' · ')}`] : []);
  const readOnly = top(read).filter((f) => !edited.has(f));
  block(10, 14, readOnly.length ? [`Files read: ${readOnly.slice(0, 12).join(', ')}`] : []);

  // Fill by priority within the budget (a block that does not fit is skipped; smaller ones below may), then show in reading order.
  let used = estimateTokens(header + '\n' + footer);
  const chosen: Block[] = [];
  for (const b of blocks.sort((x, y) => x.pri - y.pri || x.order - y.order)) {
    const cost = estimateTokens(b.lines.join('\n') + '\n');
    if (used + cost > maxTokens) continue;
    used += cost;
    chosen.push(b);
  }
  chosen.sort((x, y) => x.order - y.order);
  const lines = [header, ...chosen.flatMap((b) => b.lines), footer];
  return { ts: Date.now(), sessionId, project, contextTokens: ctx.tokens, text: lines.join('\n') };
}

/** The handoff as shown to the model: old ones say how old, since the git and check lines describe the moment they were saved. */
export function handoffText(h: Handoff, now = Date.now()): string {
  const mins = Math.round((now - h.ts) / 60000);
  if (mins < 10) return h.text;
  const ago = mins < 120 ? `${mins} min` : mins < 48 * 60 ? `${Math.round(mins / 60)} h` : `${Math.round(mins / 1440)} days`;
  const nl = h.text.indexOf('\n');
  const first = nl < 0 ? h.text : h.text.slice(0, nl);
  const rest = nl < 0 ? '' : h.text.slice(nl);
  return first.replace(/\]$/, ` Saved ${ago} ago: git and check status below may have changed since.]`) + rest;
}

export function saveHandoff(h: Handoff): void {
  writeJsonAtomic(file(h.project), h);
}

export function loadHandoff(project: string): Handoff | null {
  const r = readJson<Handoff>(file(project));
  return r.ok && r.value?.text ? r.value : null;
}

/** Handoff to inject into a new session: recent, from another session, not already used. */
export function takeHandoff(project: string, sessionId: string, maxAgeHours: number, afterCompaction = false): Handoff | null {
  const h = loadHandoff(project);
  if (!h || h.consumedBy) return null;
  // A new session takes another session's handoff; a compacted session takes its own.
  if (!afterCompaction && h.sessionId === sessionId) return null;
  if (afterCompaction && h.sessionId !== sessionId) return null;
  if (Date.now() - h.ts > maxAgeHours * 3600 * 1000) return null;
  saveHandoff({ ...h, consumedBy: sessionId });
  return h;
}
