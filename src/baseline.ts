/**
 * Fixed per-reply overhead: what a session already carries before the user types
 * (system prompt, tool and skill listings, plugin/MCP instructions). Measured as the
 * median context size of the first assistant reply in recent main transcripts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { userHome } from './config.js';

export interface Baseline {
  sessions: number;
  medianTokens: number;
}

const HEAD_BYTES = 256 * 1024;
let memo: { at: number; value: Baseline | null } | null = null;

function firstReplyContext(file: string): number {
  let fd = -1;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      if (!line.includes('"usage"')) continue;
      try {
        const e = JSON.parse(line);
        if (e.type !== 'assistant' || e.isSidechain) continue;
        const u = e.message?.usage;
        if (!u) continue;
        return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      } catch {
        /* partial last line */
      }
    }
  } catch {
    /* unreadable */
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
  return 0;
}

/** Median first-reply context over transcripts touched in the last `days`; null when too few sessions. */
export function measureBaseline(days = 7, minSessions = 5): Baseline | null {
  if (memo && Date.now() - memo.at < 10 * 60 * 1000) return memo.value;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  const cutoff = Date.now() - days * 24 * 3600 * 1000;
  const sizes: number[] = [];
  try {
    for (const d of fs.readdirSync(root)) {
      let files: string[] = [];
      try {
        files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const f of files) {
        const full = path.join(root, d, f);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) continue;
        } catch {
          continue;
        }
        const t = firstReplyContext(full);
        if (t > 0) sizes.push(t);
      }
    }
  } catch {
    /* no projects dir */
  }
  sizes.sort((a, b) => a - b);
  const value = sizes.length >= minSessions ? { sessions: sizes.length, medianTokens: sizes[Math.floor(sizes.length / 2)] } : null;
  memo = { at: Date.now(), value };
  return value;
}
