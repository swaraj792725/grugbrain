/**
 * Graph-first code context. Claude learns where things are from a small map and asks for the
 * exact symbol or line range, instead of reading whole files into a context it re-reads every reply.
 *
 *  - sessionCodeMap(): compact repo map + "use outline/read_symbol/..." at session start.
 *  - relevantCode(): the few files/symbols matching a prompt (names, paths, line ranges; no bodies).
 *
 * The scan is cached per project under ~/.grug/cache/graph and refreshed in the background
 * (`grug warm`), so hooks never walk a big repo on the hot path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { paths, userHome, writeJsonAtomic } from './config.js';
import { RepoFile, renderRepoMap, scanRepo } from './compress/repomap.js';
import { findSymbol } from './mcp.js';
import { estimateTokens } from './tokens.js';
import { rank } from './relevance.js';
import { projectKey } from './memory/store.js';

export interface GraphIndex {
  v: 1;
  root: string;
  built: number;
  files: RepoFile[];
}

const MARKERS = ['.git', 'package.json', 'pyproject.toml', 'setup.py', 'requirements.txt', 'go.mod', 'Cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json', 'mix.exs', 'Package.swift', 'CMakeLists.txt', 'Makefile', 'deno.json', 'tsconfig.json'];
export const STALE_MS = 10 * 60 * 1000;

/** A code project: has a repo/build marker and is not the home directory or filesystem root. */
export function isCodeProject(cwd: string): boolean {
  const abs = path.resolve(cwd);
  if (abs === path.resolve(userHome()) || abs === path.parse(abs).root) return false;
  return MARKERS.some((m) => fs.existsSync(path.join(abs, m)));
}

function indexPath(cwd: string): string {
  return path.join(paths.cache(), 'graph', `${projectKey(cwd).replace(/[^\w.~-]/g, '_')}.json`);
}

export function loadGraphIndex(cwd: string): GraphIndex | null {
  try {
    const g = JSON.parse(fs.readFileSync(indexPath(cwd), 'utf8'));
    return g && g.v === 1 && Array.isArray(g.files) ? g : null;
  } catch {
    return null;
  }
}

/** Scan and cache. With a deadline, returns null (and caches nothing) if the scan could not finish. */
export function buildGraphIndex(cwd: string, deadline = 0): GraphIndex | null {
  const root = path.resolve(cwd);
  const files = scanRepo(root, 5000, deadline);
  if (!files.complete && deadline) return null;
  // Imports are only needed to count importedBy; drop them to keep the cache small.
  const g: GraphIndex = { v: 1, root, built: Date.now(), files: files.map((f) => ({ ...f, imports: [] })) };
  try {
    writeJsonAtomic(indexPath(cwd), g);
  } catch {
    /* best-effort */
  }
  return g;
}

/** Cached index, or a quick synchronous build for small repos. `stale` = refresh in the background. */
export function graphIndexFor(cwd: string, buildMs = 120): { index: GraphIndex | null; stale: boolean } {
  const cached = loadGraphIndex(cwd);
  if (cached) return { index: cached, stale: Date.now() - cached.built > STALE_MS };
  const built = buildMs > 0 ? buildGraphIndex(cwd, Date.now() + buildMs) : null;
  return { index: built, stale: !built };
}

export const GRAPH_FIRST =
  'Graph-first: before a full-file Read, locate code with the grugbrain MCP tools (search or repo_map to find it, outline for a file\'s shape), ' +
  'then read_symbol or read_lines (or Read with offset/limit) for just the part you need.';

/** Session-start block: instruction + compact repo map (hot files from memory rank higher). */
export function sessionCodeMap(cwd: string, budgetTokens: number, hotFiles: string[] = []): { text: string; tokens: number; files: number; stale: boolean } | null {
  if (!isCodeProject(cwd)) return null;
  const { index, stale } = graphIndexFor(cwd);
  const head = `[grugbrain code map: ${GRAPH_FIRST} Map: important files first (←N = imported by N files) with top-level symbols; a snapshot, verify before relying.]`;
  if (!index || !index.files.length) return { text: `[grugbrain: ${GRAPH_FIRST}]`, tokens: 40, files: 0, stale };
  const boost = new Map<string, number>();
  hotFiles.forEach((f, i) => boost.set(f, Math.max(1, 6 - i * 0.5)));
  // Code files and top-level docs only; a session map is about where the code lives.
  const files = index.files.filter((f) => f.symbols.length || /(^|\/)(readme|claude|agents|contributing)\.md$/i.test(f.rel));
  const map = renderRepoMap(index.root, files, Math.max(80, budgetTokens - estimateTokens(head)), boost, 6);
  const text = `${head}\n${map.text.trimEnd()}`;
  return { text, tokens: estimateTokens(text), files: files.length - map.omitted, stale };
}

function bareName(sym: string): string {
  return sym.replace(/\(\)$/, '').replace(/^(class|interface|type|enum|struct|trait|record)\s+/, '');
}

function splitIdent(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_./-]+/g, ' ').toLowerCase();
}

export interface CodeHint {
  /** Dedupe keys: the file and each symbol shown. */
  keys: string[];
  line: string;
}

/**
 * Files/symbols relevant to a prompt: "- src/a.ts: foo() L10-42, class Bar L50-90". No bodies.
 * `terms` come from queryTerms(prompt); `promptLower` catches exact identifiers and file names.
 */
export function relevantCode(cwd: string, terms: string[], promptLower: string, maxHints = 5, exclude: Set<string> = new Set()): CodeHint[] {
  if (!terms.length || !isCodeProject(cwd)) return [];
  const index = loadGraphIndex(cwd);
  if (!index) return [];
  type Doc = { file: RepoFile; sym?: string; symLine?: number; text: string; exact: boolean };
  const docs: Doc[] = [];
  for (const f of index.files) {
    const base = path.posix.basename(f.rel).replace(/\.[^.]+$/, '').toLowerCase();
    const relText = `${f.rel.toLowerCase()} ${splitIdent(f.rel)}`;
    docs.push({ file: f, text: relText, exact: base.length >= 4 && new RegExp(`\\b${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(promptLower) });
    f.symbols.forEach((s, i) => {
      const name = bareName(s);
      if (name.length < 3) return;
      docs.push({
        file: f,
        sym: s,
        symLine: f.symLines?.[i],
        text: `${name.toLowerCase()} ${splitIdent(name)} ${relText}`,
        exact: name.length >= 5 && promptLower.includes(name.toLowerCase())
      });
    });
  }
  const ranked = rank(
    docs.map((d) => d.text),
    terms,
    docs.map((d) => (d.exact ? 3 : d.sym ? 1 : 0.8))
  ).filter((r) => docs[r.index].exact || (r.matched >= 2 && r.coverage >= 0.3));
  // Group chosen symbols by file, best first.
  const byFile = new Map<string, { file: RepoFile; syms: Array<{ sym: string; line?: number }>; score: number }>();
  for (const r of ranked) {
    const d = docs[r.index];
    if (d.sym && exclude.has(`g:${d.file.rel}#${d.sym}`)) continue;
    const g = byFile.get(d.file.rel) || { file: d.file, syms: [], score: r.score };
    if (!d.sym && exclude.has(`g:${d.file.rel}`)) continue;
    if (!byFile.has(d.file.rel) && byFile.size >= maxHints) continue;
    if (d.sym && g.syms.length < 3 && !g.syms.some((x) => x.sym === d.sym)) g.syms.push({ sym: d.sym, line: d.symLine });
    byFile.set(d.file.rel, g);
  }
  const out: CodeHint[] = [];
  for (const g of [...byFile.values()].slice(0, maxHints)) {
    const abs = path.join(index.root, g.file.rel);
    let code = '';
    if (g.syms.length && g.file.bytes <= 512 * 1024) {
      try {
        code = fs.readFileSync(abs, 'utf8');
      } catch {
        continue; // file moved since the scan
      }
    }
    const parts: string[] = [];
    for (const s of g.syms) {
      const hit = code ? findSymbol(code, g.file.rel, bareName(s.sym)) : null;
      if (code && !hit) continue; // renamed since the scan
      parts.push(`${s.sym} ${hit ? `L${hit.start}-${hit.end}` : s.line ? `L${s.line}` : ''}`.trim());
    }
    if (g.syms.length && !parts.length) continue;
    const size = g.file.bytes ? ` (${Math.round(g.file.bytes / 1024) || 1}k)` : '';
    out.push({
      keys: [`g:${g.file.rel}`, ...g.syms.map((s) => `g:${g.file.rel}#${s.sym}`)],
      line: `- ${g.file.rel}${size}${parts.length ? ': ' + parts.join(', ') : ''}`
    });
  }
  return out;
}
