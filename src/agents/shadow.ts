/**
 * Shadow transcripts: other apps' conversation logs copied into Claude Code's transcript shape, so the
 * meter, handoff, facts, recall and batching code read them unchanged. Incremental: only bytes added
 * since the last call are converted (offset kept next to the shadow file).
 *
 * Antigravity: <brain>/<id>/.system_generated/logs/transcript_full.jsonl, one step per line
 *   ({step_index, type, source, created_at, content, tool_calls, input_tokens, cache_read_tokens, output_tokens}).
 * Codex: $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl ({timestamp, type, payload}).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, grugHome } from '../config.js';
import { unwrapCommand } from './exec.js';

export type Client = 'antigravity' | 'codex';

interface ShadowState {
  offset: number;
  n: number;
  model?: string;
  /** Tool calls waiting for their result step (Antigravity runs them in order after the reply). */
  pending?: string[];
  lastTotal?: number;
  lastPrompt?: string;
}

const MAX_CHUNK = 8 * 1024 * 1024;

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
export const foreignDir = () => path.join(grugHome(), 'foreign');
export const shadowPath = (client: Client, sid: string) => path.join(foreignDir(), `${client}-${safe(sid)}.jsonl`);
const statePath = (client: Client, sid: string) => path.join(foreignDir(), `${client}-${safe(sid)}.state.json`);

function loadState(client: Client, sid: string): ShadowState {
  try {
    return JSON.parse(fs.readFileSync(statePath(client, sid), 'utf8'));
  } catch {
    return { offset: 0, n: 0 };
  }
}

/** Antigravity tool call -> the Claude Code tool it matches (grug's hooks and parsers know those). */
export function agTool(name: string, args: any = {}): { name: string; input: any } {
  const a = args || {};
  switch (name) {
    case 'run_command':
      return { name: 'Bash', input: { command: unwrapCommand(String(a.CommandLine || '')), ...(a.Cwd ? { cwd: a.Cwd } : {}) } };
    case 'view_file':
    case 'read_file': {
      const file = String(a.AbsolutePath || a.Path || a.FilePath || '');
      const start = Number(a.StartLine) || 0;
      const end = Number(a.EndLine) || 0;
      return { name: 'Read', input: { file_path: file, ...(start || end ? { offset: start || 1, limit: end && end >= (start || 1) ? end - (start || 1) + 1 : 2000 } : {}) } };
    }
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return { name: 'Edit', input: { file_path: String(a.TargetFile || '') } };
    case 'write_to_file':
      return { name: 'Write', input: { file_path: String(a.TargetFile || '') } };
    case 'grep_search':
      return { name: 'Grep', input: { pattern: String(a.Query || ''), ...(a.SearchPath ? { path: a.SearchPath } : {}) } };
    case 'list_dir':
      return { name: 'Glob', input: { pattern: '*', path: String(a.DirectoryPath || '') } };
    default:
      return { name, input: a };
  }
}

/** Files named in an apply_patch body ("*** Update File: x", "*** Add File: x", "*** Move to: x"). */
export function patchFiles(patch: string, cwd: string): string[] {
  const out = new Set<string>();
  for (const m of String(patch || '').matchAll(/^\*\*\* (?:Update|Add|Move to:?|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const f = (m[1] || m[2] || '').trim();
    if (f) out.add(path.isAbsolute(f) ? f : path.join(cwd, f));
  }
  return [...out];
}

/** Codex shell tool input: a string, or an argv array (`["bash","-lc","..."]`). */
export function codexCommand(input: any): string {
  const c = input?.command ?? input?.cmd;
  if (typeof c === 'string') return unwrapCommand(c);
  if (Array.isArray(c)) {
    const i = c.findIndex((x: string) => x === '-lc' || x === '-c');
    return unwrapCommand(i >= 0 && c[i + 1] ? String(c[i + 1]) : c.join(' '));
  }
  return '';
}

/** Codex tool -> Claude Code tool. apply_patch becomes an Edit of the first file it touches. */
export function cxTool(name: string, input: any, cwd: string): { name: string; input: any } {
  if (name === 'Bash' || name === 'exec_command' || name === 'shell' || name === 'local_shell' || name === 'container.exec') return { name: 'Bash', input: { command: codexCommand(input) } };
  if (name === 'apply_patch' || name === 'Edit' || name === 'Write') {
    const files = patchFiles(typeof input === 'string' ? input : input?.command || input?.input || '', cwd);
    return { name: 'Edit', input: { file_path: files[0] || '', files } };
  }
  return { name, input };
}

const userRequest = (c: string) => {
  const m = c.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  return (m ? m[1] : c).trim();
};

function convertAntigravity(e: any, st: ShadowState): any[] {
  const ts = e.created_at || new Date().toISOString();
  const base = { isSidechain: false, timestamp: ts };
  if (e.type === 'USER_INPUT') {
    const text = userRequest(String(e.content || ''));
    // grug's own context (sent as a user message so it stays in the conversation) is not a prompt.
    if (text.startsWith('[grugbrain context')) return [{ ...base, type: 'user', message: { role: 'user', content: text } }];
    st.lastPrompt = text;
    st.pending = [];
    return [{ ...base, type: 'user', message: { role: 'user', content: text } }];
  }
  if (e.type === 'PLANNER_RESPONSE') {
    const content: any[] = [];
    if (e.content) content.push({ type: 'text', text: String(e.content) });
    (e.tool_calls || []).forEach((t: any, i: number) => {
      const id = `ag-${e.step_index}-${i}`;
      const m = agTool(t.name, t.args);
      content.push({ type: 'tool_use', id, name: m.name, input: m.input });
      (st.pending ||= []).push(id);
    });
    const usage =
      e.input_tokens !== undefined || e.output_tokens !== undefined
        ? { input_tokens: e.input_tokens || 0, output_tokens: e.output_tokens || 0, cache_read_input_tokens: e.cache_read_tokens || 0, cache_creation_input_tokens: 0 }
        : undefined;
    if (!content.length && !usage) return [];
    return [{ ...base, type: 'assistant', message: { id: `ag-${e.step_index}`, role: 'assistant', model: st.model || 'gemini', content, ...(usage ? { usage } : {}) } }];
  }
  // A tool step: the result of the oldest call still waiting.
  if (e.source === 'MODEL' && st.pending?.length) {
    const id = st.pending.shift()!;
    const text = String(e.content || e.error || '').replace(/^(?:Created At|Completed At): .*\n/gm, '');
    return [{ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text.slice(0, 4000), ...(e.status === 'ERROR' ? { is_error: true } : {}) }] } }];
  }
  return [];
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
}

function convertCodex(e: any, st: ShadowState, cwd: string): any[] {
  const p = e.payload || {};
  const base = { isSidechain: false, timestamp: e.timestamp || new Date().toISOString() };
  const id = () => `cx-${++st.n}`;
  if (e.type === 'turn_context' && p.model) st.model = p.model;
  if (e.type === 'event_msg') {
    if (p.type === 'user_message' && p.message) {
      st.lastPrompt = String(p.message);
      return [{ ...base, type: 'user', message: { role: 'user', content: String(p.message) } }];
    }
    if (p.type === 'agent_message' && p.message) return [{ ...base, type: 'assistant', message: { id: id(), role: 'assistant', model: st.model || 'gpt', content: [{ type: 'text', text: String(p.message) }] } }];
    if (p.type === 'token_count' && p.info?.last_token_usage) {
      const total = Number(p.info.total_token_usage?.total_tokens) || 0;
      if (total && total === st.lastTotal) return []; // a repeat (rate-limit ping)
      st.lastTotal = total;
      const u = p.info.last_token_usage;
      const cached = Number(u.cached_input_tokens) || 0;
      // OpenAI counts cached tokens inside input_tokens; Claude's usage keeps them apart.
      const usage = { input_tokens: Math.max(0, (Number(u.input_tokens) || 0) - cached), output_tokens: Number(u.output_tokens) || 0, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 };
      return [{ ...base, type: 'assistant', message: { id: id(), role: 'assistant', model: st.model || 'gpt', content: [], usage } }];
    }
    return [];
  }
  if (e.type === 'response_item') {
    if (p.type === 'function_call' || p.type === 'custom_tool_call' || p.type === 'local_shell_call') {
      let input: any = p.input ?? p.action ?? {};
      if (typeof p.arguments === 'string') {
        try {
          input = JSON.parse(p.arguments);
        } catch {
          input = { command: p.arguments };
        }
      }
      const m = cxTool(p.type === 'local_shell_call' ? 'local_shell' : String(p.name || ''), input, cwd);
      return [{ ...base, type: 'assistant', message: { id: id(), role: 'assistant', model: st.model || 'gpt', content: [{ type: 'tool_use', id: p.call_id || id(), name: m.name, input: m.input }] } }];
    }
    if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output' || p.type === 'local_shell_call_output') {
      const out = typeof p.output === 'string' ? p.output : textOf(p.output?.content) || JSON.stringify(p.output ?? '');
      return [{ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: p.call_id || '', content: String(out).slice(0, 4000) }] } }];
    }
  }
  return [];
}

/**
 * Bring the shadow up to date with the app's own log and return its path (undefined when there is
 * nothing to read). `model` comes from the hook input (Antigravity steps carry no model name).
 */
export function syncShadow(client: Client, sid: string, source: string | undefined, model?: string, cwd = process.cwd()): string | undefined {
  const out = shadowPath(client, sid);
  if (!source || !fs.existsSync(source)) return fs.existsSync(out) ? out : undefined;
  // One converter at a time per conversation (a background end job can overlap the next hook).
  const lock = `${out}.lock`;
  let fd: number | undefined;
  try {
    ensureDir(foreignDir());
    try {
      fd = fs.openSync(lock, 'wx');
    } catch {
      if (Date.now() - fs.statSync(lock).mtimeMs < 15000) return fs.existsSync(out) ? out : undefined;
      fs.rmSync(lock, { force: true });
      fd = fs.openSync(lock, 'wx');
    }
    const st = loadState(client, sid);
    if (model && model !== 'auto') st.model = model;
    const size = fs.statSync(source).size;
    if (size < st.offset) {
      // The app rewrote its log: start the shadow over.
      st.offset = 0;
      st.pending = [];
      fs.rmSync(out, { force: true });
    }
    if (size > st.offset) {
      const len = Math.min(size - st.offset, MAX_CHUNK);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(source, 'r');
      fs.readSync(fd, buf, 0, len, st.offset);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      const end = text.lastIndexOf('\n');
      if (end >= 0) {
        const lines: string[] = [];
        for (const line of text.slice(0, end).split('\n')) {
          if (!line.trim()) continue;
          let e: any;
          try {
            e = JSON.parse(line);
          } catch {
            continue;
          }
          const conv = client === 'antigravity' ? convertAntigravity(e, st) : convertCodex(e, st, cwd);
          for (const c of conv) lines.push(JSON.stringify(c));
        }
        if (lines.length) fs.appendFileSync(out, lines.join('\n') + '\n');
        st.offset += Buffer.byteLength(text.slice(0, end + 1), 'utf8');
      }
    }
    fs.writeFileSync(statePath(client, sid), JSON.stringify(st));
  } catch {
    /* the shadow is best-effort */
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
      fs.rmSync(lock, { force: true });
    }
  }
  return fs.existsSync(out) ? out : undefined;
}

/** The latest user prompt seen in the app's log (Antigravity hooks do not carry it). */
export function lastPrompt(client: Client, sid: string): string {
  return loadState(client, sid).lastPrompt || '';
}
