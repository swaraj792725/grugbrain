/**
 * Conversation history on demand: search this project's earlier Claude Code conversations
 * (full transcripts on disk) and return only the matching excerpts. After auto-compaction or
 * /clear, Claude fetches exact details (an error, a decision, a snippet) instead of carrying
 * the whole old context in every request.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userHome } from './config.js';
import { estimateTokens } from './tokens.js';

export function projectTranscriptDir(cwd: string): string {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  return path.join(root, path.resolve(cwd).replace(/[^a-zA-Z0-9-]/g, '-'));
}

interface Item {
  ts: number;
  who: string;
  text: string;
}

const STOP = new Set('the and for with that this from what have was were are you your but not can how why when where which into about there their then than just also please'.split(' '));

function blocksText(content: any, who: string, out: Item[], ts: number) {
  if (typeof content === 'string') {
    out.push({ ts, who, text: content });
    return;
  }
  if (!Array.isArray(content)) return;
  for (const b of content) {
    if (!b) continue;
    if (b.type === 'text' && b.text) out.push({ ts, who, text: b.text });
    else if (b.type === 'tool_use') out.push({ ts, who: `Claude → ${b.name}`, text: JSON.stringify(b.input || {}) });
    else if (b.type === 'tool_result') {
      const c = b.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('\n') : '';
      if (t) out.push({ ts, who: 'tool result', text: t });
    }
  }
}

function readItems(file: string, maxBytes = 8 * 1024 * 1024): Item[] {
  const items: Item[] = [];
  let text = '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    text = buf.toString('utf8');
  } catch {
    return items;
  }
  for (const l of text.split('\n')) {
    if (!l || l[0] !== '{') continue;
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.isSidechain) continue;
    const ts = Date.parse(e.timestamp) || 0;
    if (e.type === 'user') blocksText(e.message?.content, 'you', items, ts);
    else if (e.type === 'assistant') blocksText(e.message?.content, 'Claude', items, ts);
  }
  return items;
}

function ago(ts: number): string {
  if (!ts) return '?';
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  if (m < 2880) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

export function searchHistory(cwd: string, query: string, maxTokens = 2500, maxResults = 10): string {
  const dir = projectTranscriptDir(cwd);
  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      .slice(0, 25);
  } catch {
    return `No earlier Claude Code conversations found for ${cwd}.`;
  }
  const q = query.toLowerCase().trim();
  const words = [...new Set(q.split(/[^a-z0-9_./-]+/).filter((w) => w.length >= 3 && !STOP.has(w)))];
  if (!words.length) return 'Give a more specific query (a filename, error text, function name or topic).';

  const hits: Array<{ item: Item; score: number; pos: number }> = [];
  for (const f of files) {
    for (const item of readItems(f)) {
      const low = item.text.toLowerCase();
      let score = 0;
      let pos = -1;
      for (const w of words) {
        const i = low.indexOf(w);
        if (i >= 0) {
          score += 1;
          if (pos < 0) pos = i;
        }
      }
      if (!score) continue;
      if (q.length > 6 && low.includes(q)) score += 2; // exact phrase
      if (item.who === 'you') score += 0.3; // user intent is gold
      hits.push({ item, score, pos });
    }
  }
  if (!hits.length) return `Nothing in this project's earlier conversations matches "${query}".`;
  hits.sort((a, b) => b.score - a.score || b.item.ts - a.item.ts);

  const lines = [`[grugbrain history: best matches for "${query}" in earlier conversations of this project, newest sessions first]`];
  const seen = new Set<string>();
  for (const h of hits) {
    if (lines.length > maxResults) break;
    const start = Math.max(0, h.pos - 200);
    const excerpt = h.item.text.slice(start, start + 600).replace(/\s+/g, ' ').trim();
    const key = excerpt.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    const line = `- ${ago(h.item.ts)} · ${h.item.who}: ${start > 0 ? '…' : ''}${excerpt}${start + 600 < h.item.text.length ? '…' : ''}`;
    if (estimateTokens(lines.join('\n') + line) > maxTokens) break;
    lines.push(line);
  }
  return lines.join('\n');
}
