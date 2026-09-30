/**
 * What fills the context? Walks a Claude Code transcript and sums estimated tokens per kind of
 * message: your prompts, Claude's text and thinking, tool calls, tool results per tool, images.
 * Shown by `grug context` and used to say *why* a context alert fired, so the fix is aimed
 * (trim big command output, stop re-reading files) instead of a generic "context is big".
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userHome } from './config.js';
import { estimateImageTokens, imageSizeOfBase64 } from './media.js';
import { estimateTokens } from './tokens.js';

export interface Bucket {
  label: string;
  tokens: number;
  count: number;
}

export interface BigItem {
  label: string;
  tokens: number;
  ts: string;
}

export interface Breakdown {
  total: number;
  buckets: Bucket[];
  biggest: BigItem[];
  messages: number;
}

const MAX_BYTES = 32 * 1024 * 1024;

function textOf(c: any): string {
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.map((b: any) => (b?.type === 'text' ? b.text || '' : b?.type === 'image' ? '' : typeof b === 'string' ? b : '')).join('\n');
}

export function analyzeTranscript(file: string): Breakdown {
  const out: Breakdown = { total: 0, buckets: [], biggest: [], messages: 0 };
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, MAX_BYTES);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
      if (len < size) text = text.slice(text.indexOf('\n') + 1);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return out;
  }
  // Only what is still in context: everything after the last compaction summary.
  const lines = text.split('\n');
  let start = 0;
  const entries: any[] = [];
  for (const l of lines) {
    if (!l || l[0] !== '{') continue;
    try {
      const e = JSON.parse(l);
      if (e.isSidechain) continue;
      if (e.isCompactSummary || e.type === 'summary') start = entries.length;
      entries.push(e);
    } catch {
      /* torn */
    }
  }
  const buckets = new Map<string, Bucket>();
  const toolName = new Map<string, string>();
  const big: BigItem[] = [];
  const add = (label: string, tokens: number, ts: string, note?: string) => {
    if (tokens <= 0) return;
    const b = buckets.get(label) || { label, tokens: 0, count: 0 };
    b.tokens += tokens;
    b.count++;
    buckets.set(label, b);
    out.total += tokens;
    if (tokens >= 1500) big.push({ label: note ? `${label}: ${note}` : label, tokens, ts });
  };
  for (const e of entries.slice(start)) {
    const c = e.message?.content;
    const ts = e.timestamp || '';
    if (e.type === 'user') {
      out.messages++;
      if (typeof c === 'string') add('your messages', estimateTokens(c), ts);
      else if (Array.isArray(c))
        for (const b of c) {
          if (b?.type === 'text') add('your messages', estimateTokens(b.text || ''), ts);
          else if (b?.type === 'image') {
            const s = imageSizeOfBase64(b.source?.data || '');
            add('images', s ? estimateImageTokens(s.w, s.h) : 1500, ts);
          } else if (b?.type === 'tool_result') {
            const name = toolName.get(b.tool_use_id) || 'tool';
            const t = textOf(b.content);
            const imgs = Array.isArray(b.content) ? b.content.filter((x: any) => x?.type === 'image') : [];
            for (const im of imgs) {
              const s = imageSizeOfBase64(im.source?.data || im.data || '');
              add('images', s ? estimateImageTokens(s.w, s.h) : 1500, ts);
            }
            add(`${name} results`, estimateTokens(t), ts, t.replace(/\s+/g, ' ').slice(0, 60));
          }
        }
    } else if (e.type === 'assistant') {
      out.messages++;
      if (!Array.isArray(c)) continue;
      for (const b of c) {
        if (b?.type === 'text') add('Claude text', estimateTokens(b.text || ''), ts);
        else if (b?.type === 'thinking') add('Claude thinking', estimateTokens(b.thinking || ''), ts);
        else if (b?.type === 'tool_use') {
          toolName.set(b.id, String(b.name || 'tool').replace(/^mcp__/, '').replace(/__/g, ':'));
          add('tool calls', estimateTokens(JSON.stringify(b.input || {})), ts);
        }
      }
    }
  }
  out.buckets = [...buckets.values()].sort((a, b) => b.tokens - a.tokens);
  out.biggest = big.sort((a, b) => b.tokens - a.tokens).slice(0, 5);
  return out;
}

/** "Read results 34%, Bash results 22%": the top consumers as a phrase for alerts. */
export function topConsumers(b: Breakdown, n = 3): string {
  if (!b.total) return '';
  return b.buckets
    .slice(0, n)
    .map((x) => `${x.label} ${Math.round((x.tokens / b.total) * 100)}%`)
    .join(', ');
}

/** Most recently modified transcript of the project at `cwd` (or of any project when cwd is empty). */
export function latestTranscript(cwd?: string): string | null {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  let best: { p: string; m: number } | null = null;
  const dirs = cwd ? [path.join(root, path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-'))] : (() => {
    try {
      return fs.readdirSync(root).map((d) => path.join(root, d));
    } catch {
      return [];
    }
  })();
  for (const d of dirs) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(d).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const m = fs.statSync(path.join(d, f)).mtimeMs;
        if (!best || m > best.m) best = { p: path.join(d, f), m };
      } catch {
        /* vanished */
      }
    }
  }
  return best ? best.p : null;
}
