/**
 * Claude Code hook handlers: `grug hook <event>` reads the event JSON on stdin.
 * Every handler is fail-safe: any error -> exit 0 with no output, so Claude Code is never blocked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, paths } from './config.js';
import { terseStyle } from './compress/caveman.js';
import { trimToolOutput } from './compress/trim.js';
import { buildBrief, recall } from './memory/brief.js';
import { withMemoryLock } from './memory/maintain.js';
import { addNote, appendBuffer, loadMemory, projectKey, readBuffer, saveMemory } from './memory/store.js';
import { recordActivity } from './stats.js';
import { estimateTokens } from './tokens.js';

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  tool_output?: any;
  reason?: string;
}

type HookOutput = Record<string, any> | null;

const TEXT_READ_SKIP = /\.(png|jpe?g|gif|webp|pdf|ipynb|svg|ico|bmp|tiff?)$/i;

export async function runHook(event: string, input: HookInput): Promise<HookOutput> {
  const cfg = loadConfig();
  const sid = input.session_id || 'unknown';
  const cwd = input.cwd || process.cwd();
  const now = Date.now();

  switch (event) {
    case 'session-start': {
      appendBuffer(sid, { t: 'start', ts: now, cwd, source: input.source });
      ensureDaemon();
      const parts: string[] = [];
      const style = terseStyle(cfg.terse);
      if (style) parts.push(style);
      if (cfg.memory.enabled) {
        const db = loadMemory();
        const brief = buildBrief(db, projectKey(cwd), cfg.memory.briefTokens, cfg.memory.halfLifeDays);
        if (brief.text) {
          parts.push(brief.text);
          appendBuffer(sid, { t: 'injected', ts: now, ids: brief.ids });
          recordActivity({ kind: 'brief', msg: `Session brief injected (${brief.tokens} tok) for ${path.basename(cwd)}`, tokens: -brief.tokens, project: path.basename(cwd) });
        }
      }
      if (!parts.length) return null;
      return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } };
    }

    case 'user-prompt': {
      const prompt = input.prompt || '';
      appendBuffer(sid, { t: 'prompt', ts: now, text: prompt.slice(0, 2000) });
      if (!cfg.memory.enabled) return null;
      const project = projectKey(cwd);
      const m = prompt.match(/^\s*(?:remember|grug remember)\s*[:,-]?\s+(.{8,400})/i);
      if (m) {
        withMemoryLock(() => {
          const db = loadMemory();
          addNote(db, project, m[1].trim(), now, { pinned: true });
          saveMemory(db);
        });
        recordActivity({ kind: 'remember', msg: `Pinned note: ${m[1].slice(0, 80)}`, project: path.basename(cwd) });
        return null; // don't recall the note we just wrote
      }
      if (prompt.trim().length < 12) return null;
      const exclude = new Set<string>();
      for (const ev of readBuffer(sid)) if (ev.t === 'injected') ev.ids.forEach((i) => exclude.add(i));
      const r = recall(loadMemory(), project, prompt, cfg.memory.recallTokens, cfg.memory.halfLifeDays, exclude);
      if (!r.text) return null;
      appendBuffer(sid, { t: 'injected', ts: now, ids: r.ids });
      recordActivity({ kind: 'recall', msg: `Recalled ${r.ids.length} related memory item(s)`, tokens: -r.tokens, project: path.basename(cwd) });
      return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.text } };
    }

    case 'pre-tool': {
      if (input.tool_name !== 'Read' || !cfg.readGuard.enabled) return null;
      const ti = input.tool_input || {};
      const file: string | undefined = ti.file_path;
      if (!file || ti.offset !== undefined || ti.limit !== undefined || TEXT_READ_SKIP.test(file)) return null;
      let size = 0;
      try {
        size = fs.statSync(file).size;
      } catch {
        return null;
      }
      if (size <= cfg.readGuard.maxBytes) return null;
      // Claude Code reads up to 2000 lines by default; estimate what that would have cost.
      let wouldRead = size;
      let totalLines = 0;
      try {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        totalLines = lines.length;
        wouldRead = lines.slice(0, 2000).join('\n').length;
      } catch {
        /* keep size */
      }
      const est = estimateTokens('x'.repeat(Math.min(wouldRead, 2_000_000)));
      recordActivity({ kind: 'read-guard', msg: `Redirected full read of ${path.basename(file)} (${Math.round(size / 1024)} KB)`, tokens: Math.max(0, est - 600), project: path.basename(cwd) });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `grugbrain: ${path.basename(file)} is ${Math.round(size / 1024)} KB / ${totalLines || '?'} lines (~${est} tokens for a full read). ` +
            `Find what you need first (Grep, or the grugbrain outline/read_symbol tools), then Read with offset/limit. ` +
            `A ranged Read is always allowed.`
        }
      };
    }

    case 'post-tool': {
      const ti = input.tool_input || {};
      const tool = input.tool_name || '';
      if (ti.file_path && /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
        appendBuffer(sid, { t: 'file', ts: now, path: ti.file_path, op: tool === 'Read' ? 'read' : 'edit' });
      } else if (tool === 'Bash' && ti.command) {
        appendBuffer(sid, { t: 'cmd', ts: now, cmd: String(ti.command).slice(0, 300) });
      }
      // Trim long plain-text output at the source (Claude Code >= 2.1.121 honours updatedToolOutput).
      if (cfg.proxy.trimToolResults && (tool === 'Bash' || tool === 'Grep') && typeof input.tool_output === 'string') {
        const r = trimToolOutput(input.tool_output, {
          thresholdChars: cfg.proxy.trimThresholdChars,
          keepHeadChars: cfg.proxy.trimKeepHeadChars,
          keepTailChars: cfg.proxy.trimKeepTailChars
        });
        if (r.changed && r.removedChars > 200) {
          recordActivity({ kind: 'trim', msg: `Trimmed ${tool} output at source`, tokens: Math.round(r.removedChars / 3.6), project: path.basename(cwd) });
          return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: r.text } };
        }
      }
      return null;
    }

    case 'stop': {
      const text = lastAssistantText(input.transcript_path);
      if (text) appendBuffer(sid, { t: 'assistant', ts: now, text: text.slice(0, 4000) });
      return null;
    }

    case 'session-end':
    case 'pre-compact': {
      const text = lastAssistantText(input.transcript_path);
      if (text) appendBuffer(sid, { t: 'assistant', ts: now, text: text.slice(0, 4000) });
      if (event === 'session-end') appendBuffer(sid, { t: 'end', ts: now, reason: input.reason });
      spawnDetached(['maintain']);
      return null;
    }
  }
  return null;
}

/** Last assistant text block from a Claude Code transcript (reads only the tail). */
export function lastAssistantText(file?: string): string {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const msg = e.message || e;
        if (msg.role !== 'assistant' && e.type !== 'assistant') continue;
        const content = msg.content;
        const text = typeof content === 'string' ? content : (content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        if (text.trim()) return text.trim();
      } catch {
        /* partial first line */
      }
    }
  } catch {
    /* no transcript */
  }
  return '';
}

function cliPath(): string {
  const installed = path.join(paths.app(), 'cli.js');
  return fs.existsSync(installed) ? installed : process.argv[1];
}

export function spawnDetached(args: string[]): void {
  try {
    fs.mkdirSync(paths.logs(), { recursive: true });
    const out = fs.openSync(path.join(paths.logs(), `${args[0]}.log`), 'a');
    const child = spawn(process.execPath, [cliPath(), ...args], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
  } catch {
    /* best effort */
  }
}

/** If the proxy is configured in Claude Code but not answering, start it (belt and braces next to launchd). */
function ensureDaemon(): void {
  const cfg = loadConfig();
  try {
    const pid = Number(fs.readFileSync(paths.pid(), 'utf8'));
    if (pid) {
      process.kill(pid, 0);
      return; // alive
    }
  } catch {
    /* not running or no pid file */
  }
  if (cfg.proxy.enabled) spawnDetached(['daemon']);
}

export async function readStdinJson(): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
