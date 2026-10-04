/**
 * `grug discover`: where tool output tokens go. Scans recent transcripts for Bash and MCP results, groups them by
 * command, and shows how much grug already shortened, so new output rules go where they pay (rtk's `discover` idea).
 * Read-only; sizes are characters / 3.6 like the rest of grug's estimates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { userHome } from './config.js';

export interface DiscoverRow {
  key: string;
  runs: number;
  tokens: number;
  /** Tokens in results grug already shortened (they carry grug's marker). */
  shortenedTokens: number;
  maxTokens: number;
  example: string;
}

export interface DiscoverReport {
  transcripts: number;
  days: number;
  totalTokens: number;
  rows: DiscoverRow[];
}

const MULTI = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx', 'git', 'cargo', 'go', 'docker', 'kubectl', 'gh', 'uv', 'poetry', 'pip', 'pip3', 'make', 'dotnet', 'mvn', 'gradle', 'terraform']);
const RUNNERS = new Set(['run', 'exec', 'x', '-m']);

/** A stable group name for a shell command: `npm test`, `npx vitest`, `git diff`, `python3 -m pytest`, `ls`. */
export function commandKey(cmd: string): string {
  let c = cmd
    .replace(/\\\n/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l)) // comment lines
    .join('\n')
    .trim()
    .replace(/^[({]\s*/, '');
  // Skip setup steps (cd, export, source, set, VAR=value) and name the first command that does the work.
  let words: string[] = [];
  for (const seg of c.split(/\s*(?:&&|\|\||;|\||\n)\s*/)) {
    const w = seg.split(/\s+/).filter((x) => x && !/^\w+=/.test(x));
    if (!w.length || /^(cd|export|source|set|\.)$/.test(w[0])) continue;
    words = w;
    break;
  }
  if (!words.length) return '(empty)';
  const base = path.basename(words[0].replace(/^["']|["']$/g, ''));
  const out = [base];
  if ((MULTI.has(base) || /^python3?$/.test(base)) && words[1] && !words[1].startsWith('-')) out.push(words[1]);
  else if (/^python3?$/.test(base) && words[1] === '-m' && words[2]) out.push('-m', words[2]);
  if (out.length === 2 && RUNNERS.has(out[1]) && words[2] && !words[2].startsWith('-')) out.push(words[2]);
  return out.join(' ');
}

function resultText(c: any): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('\n');
  return '';
}

export function discover(opts: { days?: number; now?: number; top?: number } = {}): DiscoverReport {
  const days = opts.days ?? 7;
  const since = (opts.now ?? Date.now()) - days * 86400000;
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  const groups = new Map<string, DiscoverRow>();
  let transcripts = 0;
  let totalTokens = 0;
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  };
  walk(root, 0);
  for (const f of files) {
    try {
      if (fs.statSync(f).mtimeMs < since) continue;
    } catch {
      continue;
    }
    transcripts++;
    const calls = new Map<string, string>();
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      const isUse = line.includes('"tool_use"');
      if (!isUse && !line.includes('"tool_result"')) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e.timestamp && Date.parse(e.timestamp) < since) continue;
      const content = e.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'tool_use' && b.id) {
          const name = String(b.name || '');
          if (name === 'Bash' && typeof b.input?.command === 'string') calls.set(b.id, b.input.command);
          else if (name.startsWith('mcp__')) calls.set(b.id, `mcp ${name.replace(/^mcp__/, '')}`);
        } else if (b?.type === 'tool_result' && calls.has(b.tool_use_id)) {
          const cmd = calls.get(b.tool_use_id)!;
          const out = resultText(b.content);
          const tok = Math.round(out.length / 3.6);
          if (!tok) continue;
          const key = cmd.startsWith('mcp ') ? cmd : commandKey(cmd);
          const g = groups.get(key) || { key, runs: 0, tokens: 0, shortenedTokens: 0, maxTokens: 0, example: '' };
          g.runs++;
          g.tokens += tok;
          if (out.includes('[grug:') || out.includes('grugbrain')) g.shortenedTokens += tok;
          if (tok > g.maxTokens) {
            g.maxTokens = tok;
            g.example = cmd.replace(/\s+/g, ' ').slice(0, 100);
          }
          groups.set(key, g);
          totalTokens += tok;
        }
      }
    }
  }
  const rows = [...groups.values()].sort((a, b) => b.tokens - b.shortenedTokens - (a.tokens - a.shortenedTokens)).slice(0, opts.top ?? 15);
  return { transcripts, days, totalTokens, rows };
}
