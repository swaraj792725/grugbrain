/**
 * MCP server (stdio, JSON-RPC 2.0, newline-delimited).
 * Every tool reads from disk itself and returns LESS than the naive alternative,
 * so calling it never costs more tokens than it saves.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConfig, paths, VERSION } from './config.js';
import { cavemanCompress } from './compress/caveman.js';
import { repoMap, scanRepo } from './compress/repomap.js';
import { languageOf, matchBraces, skeletonize } from './compress/skeleton.js';
import { buildBrief, recall } from './memory/brief.js';
import { writeGraphHtml } from './memory/graphhtml.js';
import { withMemoryLock } from './memory/maintain.js';
import { addNote, loadMemory, MemoryDB, projectKey, projectNodes, saveMemory } from './memory/store.js';
import { recordActivity, summarize } from './stats.js';
import { estimateTokens, fmtTokens, fmtUsd } from './tokens.js';
import { searchHistory } from './history.js';
import { estimateImageTokens, hasTool, imageSizeOfFile, IMAGE_RE, pdfPageCount, pdfText, PDF_RE, videoDuration, videoFrames, VIDEO_RE } from './media.js';

const SUPPORTED_PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_FILE = 5 * 1024 * 1024;

const INSTRUCTIONS = `grugbrain saves tokens. Prefer its tools over reading whole files:
- outline(path) before reading any large source file; then read_symbol or read_lines for just what you need.
- repo_map(dir) instead of listing/reading many files to learn a codebase.
- search(pattern, dir) to locate code before reading.
- recall(query) to check memory of past sessions before re-exploring; remember(text) for durable facts/decisions.
- pdf_text(path, pages) to read a PDF as text (cheap); Read pages as images only for scans/figures. video_frames(path) for a frame sheet of a video. media_info(path) to see what a file costs.
- history(query) to fetch an exact detail from earlier in this project's conversations (e.g. after compaction) instead of guessing.`;

type Json = any;

const TOOLS = [
  {
    name: 'outline',
    description: 'Skeleton of a source file from disk: imports, types, classes and function signatures with bodies stubbed. Typically 70-90% smaller than the file. Use before reading large files.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Absolute path to the file' } }, required: ['path'] }
  },
  {
    name: 'read_symbol',
    description: 'Return the full source of one function, method, class or type by name from a file on disk.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, name: { type: 'string', description: 'Symbol name, e.g. handleRequest or UserService' } },
      required: ['path', 'name']
    }
  },
  {
    name: 'read_lines',
    description: 'Return a line range of a file (1-based, inclusive) with line numbers.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' } },
      required: ['path', 'start', 'end']
    }
  },
  {
    name: 'repo_map',
    description: 'Ranked, token-budgeted map of a codebase: files, top-level symbols, and how often each file is imported. Respects .gitignore; skips binaries, lockfiles and secrets.',
    inputSchema: {
      type: 'object',
      properties: { dir: { type: 'string' }, budget: { type: 'number', description: 'Max tokens (default 1500)' } },
      required: ['dir']
    }
  },
  {
    name: 'search',
    description: 'Regex search across a codebase (respects .gitignore). Returns file:line: text, capped.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        dir: { type: 'string' },
        glob: { type: 'string', description: 'Optional substring/extension filter, e.g. ".ts"' },
        max: { type: 'number', description: 'Max matches (default 60)' }
      },
      required: ['pattern', 'dir']
    }
  },
  {
    name: 'history',
    description:
      "Search this project's earlier Claude Code conversations (full transcripts, including before compaction or /clear) and return only the matching excerpts: what the user asked, what was decided, errors, command output. Use it instead of guessing about earlier context.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Words to find: error text, filename, function, topic, decision' },
        dir: { type: 'string', description: 'Project directory (default: current)' }
      },
      required: ['query']
    }
  },
  {
    name: 'pdf_text',
    description: 'Text of PDF pages via pdftotext, far cheaper than page images. Lists pages that are scans/figures (Read those as images). Default first 20 pages.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, pages: { type: 'string', description: 'e.g. "3", "5-12" (default 1-20)' } },
      required: ['path']
    }
  },
  {
    name: 'video_frames',
    description: 'One contact-sheet image of evenly spaced frames of a video (ffmpeg), costing about one image instead of one per frame. Returns the image plus frame timestamps.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, count: { type: 'number', description: 'Frames (1-16, default 9)' }, from: { type: 'number', description: 'Start second' }, to: { type: 'number', description: 'End second' } },
      required: ['path']
    }
  },
  {
    name: 'media_info',
    description: 'Size, page count or duration of an image/PDF/video plus what reading it would cost and the cheapest way to look at it.',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
  },
  {
    name: 'recall',
    description: 'Search grugbrain memory of past sessions (decisions, notes, files involved). Pass dir to scope to a project.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, dir: { type: 'string' } }, required: ['query'] }
  },
  {
    name: 'remember',
    description: 'Store a durable fact or decision in grugbrain memory (pinned; merged with similar notes).',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, dir: { type: 'string', description: 'Project directory' } }, required: ['text'] }
  },
  {
    name: 'project_brief',
    description: 'Memory brief for a project directory: last session outcome, pinned notes, hot files.',
    inputSchema: { type: 'object', properties: { dir: { type: 'string' } }, required: ['dir'] }
  },
  {
    name: 'memory_graph',
    description: 'Regenerate the interactive memory graph and return its file path plus stats.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'savings',
    description: 'Measured spend and savings recorded by grugbrain.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'compress_text',
    description: 'Strip pleasantries/filler from text you will reuse many times (e.g. a system prompt draft). Code, paths, URLs and quotes are preserved.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  }
];

function readFileChecked(p: string): string {
  const abs = path.resolve(p);
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error(`Not a file: ${abs}`);
  if (st.size > MAX_FILE) throw new Error(`File too large (${Math.round(st.size / 1024)} KB). Use read_lines.`);
  return fs.readFileSync(abs, 'utf8');
}

export function findSymbol(code: string, fileName: string, name: string): { start: number; end: number; text: string } | null {
  const lines = code.split('\n');
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const decl = new RegExp(
    `(^|\\s)(?:export\\s+)?(?:default\\s+)?(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|type|enum|struct|trait|impl|def|fn|func|const|let|var|val|record)\\s+(?:\\([^)]*\\)\\s*)?${esc}\\b|^\\s*(?:public|private|protected|static|readonly|override|async|\\s)*${esc}\\s*[(<=:]`
  );
  const idx = lines.findIndex((l) => decl.test(l));
  if (idx < 0) return null;
  let start = idx;
  while (start > 0 && /^\s*(\/\/|\*|\/\*\*|#|@|""")/.test(lines[start - 1])) start--;
  let end = idx;
  if (languageOf(fileName) === 'python') {
    const base = (lines[idx].match(/^\s*/) || [''])[0].length;
    end = idx + 1;
    while (end < lines.length && (lines[end].trim() === '' || (lines[end].match(/^\s*/) || [''])[0].length > base)) end++;
    while (end > idx + 1 && lines[end - 1].trim() === '') end--;
    end--;
  } else {
    const offset = lines.slice(0, idx).join('\n').length + (idx > 0 ? 1 : 0);
    const brace = code.indexOf('{', offset);
    const semi = code.indexOf(';', offset);
    if (brace >= 0 && (semi < 0 || brace < semi || /=>|\)\s*[:{]/.test(code.slice(offset, brace)))) {
      const close = matchBraces(code).get(brace);
      if (close !== undefined) end = code.slice(0, close).split('\n').length - 1;
    } else if (semi >= 0) end = code.slice(0, semi).split('\n').length - 1;
  }
  return { start: start + 1, end: end + 1, text: lines.slice(start, end + 1).join('\n') };
}

function numbered(lines: string[], from: number): string {
  return lines.map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
}

function projectFor(db: MemoryDB, dir?: string): string | null {
  if (dir) return projectKey(dir);
  return null;
}

export interface ToolImage {
  data: string;
  mimeType: string;
}

/** Tool result with images (an MCP image block needs no file Read, so no permission prompt). */
export function callToolRich(name: string, args: Json): { text: string; images: ToolImage[] } {
  if (name === 'video_frames') return videoFramesTool(args);
  return { text: callTool(name, args), images: [] };
}

function pageSpec(spec: unknown): { from: number; to: number } {
  const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(String(spec ?? ''));
  if (!m) return { from: 1, to: 0 };
  const from = Math.max(1, Number(m[1]));
  return { from, to: m[2] ? Math.max(from, Number(m[2])) : from };
}

function pdfTextTool(args: Json): string {
  const file = path.resolve(String(args.path));
  const { from, to } = pageSpec(args.pages);
  const r = pdfText(file, from, to);
  if (!r.ok) return r.text;
  const shown = r.to - r.from + 1;
  const tok = estimateTokens(r.text);
  const saved = Math.max(0, shown * 1500 - tok);
  if (saved > 500) recordActivity({ kind: 'media', msg: `pdf_text: ${shown} page(s) of ${path.basename(file)} as text instead of images`, tokens: saved });
  const notes: string[] = [];
  if (r.imagePages.length) notes.push(`Pages with little or no text (scans/figures), Read these as images with pages="N": ${r.imagePages.join(', ')}.`);
  if (r.truncated) notes.push('Output was cut to stay small; continue with a later pages range.');
  if (r.pages && r.to < r.pages) notes.push(`${r.pages - r.to} more page(s) after ${r.to}; ask for pages="${r.to + 1}-${Math.min(r.pages, r.to + 20)}".`);
  return `// ${file}: ${r.pages || '?'} pages, showing ${r.from}-${r.to}, ~${tok} tokens as text (page images would be ~${shown * 1500}+)\n${r.text}${notes.length ? '\n' + notes.join('\n') : ''}`;
}

function videoFramesTool(args: Json): { text: string; images: ToolImage[] } {
  const file = path.resolve(String(args.path));
  if (!fs.existsSync(file)) return { text: `No such file: ${file}`, images: [] };
  const n = Math.max(1, Math.min(16, Number(args.count) || 9));
  const r = videoFrames(file, path.join(paths.cache(), 'media'), n, Number(args.from) || 0, Number(args.to) || 0);
  if (!r.ok || !r.sheet) return { text: r.message, images: [] };
  const dur = videoDuration(file);
  const cols = Math.ceil(Math.sqrt(r.times.length));
  const saved = Math.max(0, (r.times.length - 1) * 1500);
  if (saved) recordActivity({ kind: 'media', msg: `video_frames: ${r.times.length} frames of ${path.basename(file)} as one sheet`, tokens: saved });
  return {
    text:
      `// ${path.basename(file)}${dur ? `, ${dur.toFixed(1)} s` : ''}: contact sheet of ${r.times.length} frames, ${cols} per row, left to right, top to bottom.\n` +
      `Frame times (s): ${r.times.join(', ')}. Ask again with from/to (seconds) and a higher count to look closer at a stretch.`,
    images: [{ data: fs.readFileSync(r.sheet).toString('base64'), mimeType: 'image/jpeg' }]
  };
}

function mediaInfoTool(args: Json): string {
  const file = path.resolve(String(args.path));
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return `No such file: ${file}`;
  }
  const kb = Math.round(st.size / 1024);
  if (IMAGE_RE.test(file)) {
    const s = imageSizeOfFile(file);
    if (!s) return `${file}: image, ${kb} KB (size unreadable). Cost ≈ 1.5k tokens.`;
    const cfg = loadConfig();
    const tok = estimateImageTokens(s.w, s.h);
    return `${file}: ${s.type} ${s.w}x${s.h}, ${kb} KB. Reading it costs ≈ ${tok + 330} tokens and it then stays in context; ${cfg.mediaGuard.imageMaxEdge && Math.max(s.w, s.h) > cfg.mediaGuard.imageMaxEdge ? `grug reads a copy shrunk to ${cfg.mediaGuard.imageMaxEdge}px (repeat the Read for full size)` : 'no shrinking needed'}.`;
  }
  if (PDF_RE.test(file)) {
    const pages = pdfPageCount(file);
    return `${file}: PDF, ${pages || '?'} pages, ${kb} KB. As page images ≈ ${pages ? pages * 1500 + '–' + pages * 3000 : '1.5–3k per page'} tokens; as text ≈ ${pages ? pages * 500 : '~500 per page'}. ${hasTool('pdftotext') ? 'Use pdf_text(path, pages); Read only scan/figure pages as images.' : 'pdftotext is not installed (brew install poppler); use Read with a pages range.'}`;
  }
  if (VIDEO_RE.test(file)) {
    const d = videoDuration(file);
    return `${file}: video, ${kb} KB${d ? `, ${d.toFixed(1)} s` : ''}. Cannot be read directly. ${hasTool('ffmpeg') ? 'Use video_frames(path, count, from, to): one sheet ≈ one image.' : 'ffmpeg is not installed (brew install ffmpeg).'}`;
  }
  return `${file}: ${kb} KB. Not an image, PDF or video.`;
}

export function callTool(name: string, args: Json): string {
  const cfg = loadConfig();
  switch (name) {
    case 'pdf_text':
      return pdfTextTool(args);
    case 'video_frames':
      return videoFramesTool(args).text;
    case 'media_info':
      return mediaInfoTool(args);
    case 'outline': {
      const code = readFileChecked(args.path);
      const r = skeletonize(code, args.path);
      if (r.language === 'unknown') return `(no outline support for this file type; ${code.split('\n').length} lines) Use read_lines.`;
      recordActivity({ kind: 'outline', msg: `Outlined ${path.basename(args.path)} (${r.percentSaved}% smaller)`, tokens: r.originalTokens - r.skeletonTokens });
      return `// outline of ${args.path}: ${code.split('\n').length} lines, ~${r.originalTokens} → ~${r.skeletonTokens} tokens\n${r.skeleton}`;
    }
    case 'read_symbol': {
      const code = readFileChecked(args.path);
      const hit = findSymbol(code, args.path, String(args.name));
      if (!hit) return `Symbol "${args.name}" not found in ${args.path}. Try outline first.`;
      return `// ${args.path}:${hit.start}-${hit.end}\n${numbered(hit.text.split('\n'), hit.start)}`;
    }
    case 'read_lines': {
      const lines = readFileChecked(args.path).split('\n');
      const s = Math.max(1, Math.floor(args.start || 1));
      const e = Math.min(lines.length, Math.floor(args.end || s + 99));
      if (e - s > 800) return 'Range too large (max 800 lines per call).';
      return `// ${args.path}:${s}-${e} of ${lines.length}\n${numbered(lines.slice(s - 1, e), s)}`;
    }
    case 'repo_map': {
      const m = repoMap(args.dir, Math.min(8000, args.budget || 1500));
      return m.text;
    }
    case 'search': {
      let re: RegExp;
      try {
        re = new RegExp(args.pattern, 'i');
      } catch (err: any) {
        return `Invalid regex: ${err.message}`;
      }
      const max = Math.min(300, args.max || 60);
      const root = path.resolve(args.dir);
      const out: string[] = [];
      let total = 0;
      for (const f of scanRepo(root)) {
        if (args.glob && !f.rel.includes(String(args.glob).replace(/^\*/, ''))) continue;
        if (f.bytes > 1024 * 1024) continue;
        let text: string;
        try {
          text = fs.readFileSync(path.join(root, f.rel), 'utf8');
        } catch {
          continue;
        }
        if (text.slice(0, 1024).includes('\u0000')) continue;
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (!re.test(lines[i])) continue;
          total++;
          if (out.length < max) out.push(`${f.rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
      return out.length ? out.join('\n') + (total > max ? `\n(+${total - max} more matches; narrow the pattern)` : '') : 'No matches.';
    }
    case 'history': {
      const out = searchHistory(args.dir || process.cwd(), String(args.query || ''));
      recordActivity({ kind: 'history', msg: `History lookup: ${String(args.query).slice(0, 60)}`, tokens: -estimateTokens(out) });
      return out;
    }
    case 'recall': {
      const db = loadMemory();
      const target = projectFor(db, args.dir);
      const projects = target ? [target] : [...new Set(Object.values(db.nodes).map((n) => n.project))];
      const parts: string[] = [];
      for (const p of projects) {
        const r = recall(db, p, String(args.query), cfg.memory.recallTokens, cfg.memory.halfLifeDays);
        if (r.text) parts.push(r.text.replace('[grugbrain recall: related memory]', `[${p.split('~')[0]}]`));
      }
      return parts.join('\n') || 'Nothing relevant in memory.';
    }
    case 'remember': {
      const project = projectKey(args.dir || path.join(paths.home(), 'global'));
      withMemoryLock(() => {
        const db = loadMemory();
        addNote(db, project, String(args.text).slice(0, 600), Date.now(), { pinned: true });
        saveMemory(db);
      });
      recordActivity({ kind: 'remember', msg: `Pinned note via MCP: ${String(args.text).slice(0, 80)}` });
      return 'Remembered.';
    }
    case 'project_brief': {
      const b = buildBrief(loadMemory(), projectKey(args.dir), cfg.memory.briefTokens, cfg.memory.halfLifeDays);
      return b.text || 'No memory for this project yet.';
    }
    case 'memory_graph': {
      const db = loadMemory();
      writeGraphHtml(db, paths.graphHtml(), cfg.memory.halfLifeDays);
      const projects = [...new Set(Object.values(db.nodes).map((n) => n.project))];
      return `Graph: ${paths.graphHtml()}\n${Object.keys(db.nodes).length} nodes, ${Object.keys(db.edges).length} links, ${projects.length} project(s): ${projects
        .map((p) => `${p.split('~')[0]} (${projectNodes(db, p).length})`)
        .join(', ')}`;
    }
    case 'savings': {
      const s = summarize();
      return [
        `requests: ${s.requests}, spend: ${fmtUsd(s.costUsd)}, cache saved: ${fmtUsd(s.cacheSavedUsd)} (hit rate ${(s.cacheHitRate * 100).toFixed(0)}%)`,
        `trimmed: ~${fmtTokens(s.trimmedTokens + (s.savedByKind.trim || 0))} tok, read-guard: ~${fmtTokens(s.savedByKind['read-guard'] || 0)} tok, outlines: ~${fmtTokens(s.savedByKind.outline || 0)} tok`
      ].join('\n');
    }
    case 'compress_text': {
      const r = cavemanCompress(String(args.text || ''));
      return `(${r.originalTokens} → ${r.compressedTokens} tokens)\n${r.text}`;
    }
  }
  throw new Error(`Unknown tool: ${name}`);
}

export function handleMessage(msg: Json): Json | null {
  const isRequest = msg && msg.id !== undefined && msg.id !== null;
  const reply = (result: Json) => ({ jsonrpc: '2.0', id: msg.id, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
  if (!msg || typeof msg.method !== 'string') return isRequest ? error(-32600, 'Invalid Request') : null;
  if (!isRequest) return null; // notifications never get a response

  switch (msg.method) {
    case 'initialize': {
      const asked = msg.params?.protocolVersion;
      return reply({
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : SUPPORTED_PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'grugbrain', version: VERSION },
        instructions: INSTRUCTIONS
      });
    }
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'resources/list':
      return reply({ resources: [] });
    case 'prompts/list':
      return reply({ prompts: [] });
    case 'tools/call': {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return error(-32602, `Unknown tool: ${name}`);
      try {
        const r = callToolRich(name, msg.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: r.text }, ...r.images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))] });
      } catch (err: any) {
        return reply({ content: [{ type: 'text', text: `Error: ${err?.message || err}` }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${msg.method}`);
  }
}

export function runMcpServer(): void {
  process.stdin.setEncoding('utf8');
  let buf = '';
  const send = (obj: Json) => process.stdout.write(JSON.stringify(obj) + '\n');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line);
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      const batch = Array.isArray(msg) ? msg : [msg];
      const out = batch.map((m) => handleMessage(m)).filter(Boolean);
      if (out.length) send(Array.isArray(msg) ? out : out[0]);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
