/**
 * Repo map: a ranked, token-budgeted overview of a codebase (files, symbols, who-imports-whom).
 * Respects .gitignore, skips binaries/generated files, never reads huge files.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { estimateTokens } from '../tokens.js';
import { extractSymbols, languageOf } from './skeleton.js';

export const ALWAYS_IGNORE = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.cache', 'coverage', '.turbo',
  'target', 'vendor', '__pycache__', '.venv', 'venv', '.idea', '.vscode', '.gradle', 'Pods', '.terraform'
]);

const SKIP_FILE_RE =
  /(\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|tar|gz|tgz|bz2|7z|mp[34]|mov|wav|woff2?|ttf|otf|eot|so|dylib|dll|exe|bin|class|jar|pyc|lock|map|min\.js|min\.css|sqlite|db)$)|(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum|\.DS_Store)$/i;
const SECRET_RE = /(^|\/)(\.env(\..*)?|.*\.pem|.*\.key|id_rsa.*|credentials.*\.json)$/i;
const MAX_READ = 512 * 1024;

export interface RepoFile {
  rel: string;
  bytes: number;
  mtime: number;
  symbols: string[];
  imports: string[];
  importedBy: number;
}

export interface RepoMap {
  root: string;
  files: RepoFile[];
  text: string;
  tokens: number;
  omitted: number;
}

function gitignoreMatcher(root: string): (rel: string, isDir: boolean) => boolean {
  const rules: Array<{ re: RegExp; neg: boolean; dirOnly: boolean }> = [];
  try {
    const text = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    for (let line of text.split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const neg = line.startsWith('!');
      if (neg) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.includes('/');
      const body = line
        .replace(/^\//, '')
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*\*\/?/g, '\u0001')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '[^/]')
        .replace(/\u0001/g, '(?:.*/)?');
      const re = new RegExp(anchored ? `^${body}(/.*)?$` : `(^|/)${body}(/.*)?$`);
      rules.push({ re, neg, dirOnly });
    }
  } catch {
    /* no .gitignore */
  }
  return (rel, isDir) => {
    let ignored = false;
    for (const r of rules) {
      if (r.dirOnly && !isDir && !r.re.test(path.dirname(rel))) continue;
      if (r.re.test(rel)) ignored = !r.neg;
    }
    return ignored;
  };
}

function extractImports(code: string, lang: string | null): string[] {
  const out = new Set<string>();
  const add = (s?: string) => s && out.add(s);
  if (lang === 'python') {
    for (const m of code.matchAll(/^\s*from\s+([.\w]+)\s+import|^\s*import\s+([.\w]+)/gm)) add(m[1] || m[2]);
  } else if (lang === 'go') {
    for (const m of code.matchAll(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm)) add(m[1]);
    for (const block of code.matchAll(/import\s*\(([\s\S]*?)\)/g))
      for (const m of block[1].matchAll(/"([^"]+)"/g)) add(m[1]);
  } else if (lang === 'rust') {
    for (const m of code.matchAll(/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/gm)) add(m[1]);
  } else {
    for (const m of code.matchAll(/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g))
      add(m[1] || m[2] || m[3] || m[4]);
  }
  return [...out];
}

export function scanRepo(dir: string, maxFiles = 5000): RepoFile[] {
  const root = path.resolve(dir);
  const ignored = gitignoreMatcher(root);
  const files: RepoFile[] = [];
  const walk = (abs: string, depth: number) => {
    if (depth > 12 || files.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (files.length >= maxFiles) return;
      const full = path.join(abs, e.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (e.isDirectory()) {
        if (ALWAYS_IGNORE.has(e.name) || (e.name.startsWith('.') && e.name !== '.github') || ignored(rel, true)) continue;
        walk(full, depth + 1);
      } else if (e.isFile()) {
        if (SKIP_FILE_RE.test(rel) || SECRET_RE.test(rel) || ignored(rel, false)) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        const lang = languageOf(e.name);
        let symbols: string[] = [];
        let imports: string[] = [];
        if (lang && st.size <= MAX_READ) {
          try {
            const code = fs.readFileSync(full, 'utf8');
            if (!code.slice(0, 1024).includes('\u0000')) {
              symbols = extractSymbols(code, e.name);
              imports = extractImports(code, lang);
            }
          } catch {
            /* unreadable */
          }
        }
        files.push({ rel, bytes: st.size, mtime: st.mtimeMs, symbols, imports, importedBy: 0 });
      }
    }
  };
  walk(root, 0);

  // Resolve relative imports to count in-degree (importance).
  const byStem = new Map<string, RepoFile>();
  for (const f of files) {
    byStem.set(f.rel, f);
    byStem.set(f.rel.replace(/\.[^./]+$/, ''), f);
    byStem.set(f.rel.replace(/\/index\.[^./]+$/, ''), f);
  }
  for (const f of files) {
    for (const imp of f.imports) {
      if (!imp.startsWith('.')) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(f.rel), imp)).replace(/\.(js|mjs|cjs)$/, '');
      const hit = byStem.get(target);
      if (hit && hit !== f) hit.importedBy++;
    }
  }
  return files;
}

/** Builds the map text, adding the most important files first until the token budget is spent. */
export function repoMap(dir: string, budgetTokens = 1500): RepoMap {
  const root = path.resolve(dir);
  const files = scanRepo(root);
  const newest = Math.max(1, ...files.map((f) => f.mtime));
  const score = (f: RepoFile) =>
    f.importedBy * 3 + f.symbols.length * 0.5 + (f.mtime / newest) * 2 + (/(^|\/)(readme|index|main|app|server|cli)\./i.test(f.rel) ? 3 : 0);
  const ranked = [...files].sort((a, b) => score(b) - score(a));

  const header = `# repo map: ${path.basename(root)} (${files.length} files)\n`;
  let used = estimateTokens(header);
  const chosen = new Set<RepoFile>();
  for (const f of ranked) {
    const line = renderFile(f);
    const t = estimateTokens(line);
    if (used + t > budgetTokens) continue;
    chosen.add(f);
    used += t;
  }
  // Render in path order, grouped by directory.
  const byDir = new Map<string, RepoFile[]>();
  for (const f of files) {
    if (!chosen.has(f)) continue;
    const d = path.posix.dirname(f.rel);
    if (!byDir.has(d)) byDir.set(d, []);
    byDir.get(d)!.push(f);
  }
  let text = header;
  for (const [d, fs_] of [...byDir.entries()].sort()) {
    text += `${d === '.' ? './' : d + '/'}\n`;
    for (const f of fs_) text += renderFile(f);
  }
  const omitted = files.length - chosen.size;
  if (omitted > 0) text += `(+${omitted} lower-ranked files omitted to stay under ${budgetTokens} tokens)\n`;
  return { root, files, text, tokens: estimateTokens(text), omitted };
}

function renderFile(f: RepoFile): string {
  const name = f.rel.split('/').pop();
  const kb = f.bytes >= 1024 ? `${Math.round(f.bytes / 1024)}k` : `${f.bytes}b`;
  const syms = f.symbols.length ? ': ' + f.symbols.slice(0, 12).join(', ') + (f.symbols.length > 12 ? ` +${f.symbols.length - 12}` : '') : '';
  const used = f.importedBy ? ` ←${f.importedBy}` : '';
  return `  ${name} (${kb}${used})${syms}\n`;
}
