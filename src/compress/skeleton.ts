/**
 * Skeletonizer: keeps declarations, signatures, types and doc comments; stubs function bodies.
 * Uses a real scanner (strings, template literals, comments, nested braces) instead of regex,
 * so nested blocks never leave dangling code behind.
 */

import { estimateTokens } from '../tokens.js';

export interface SkeletonResult {
  skeleton: string;
  originalTokens: number;
  skeletonTokens: number;
  percentSaved: number;
  language: string;
}

const BRACE_LANGS: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'js', '.jsx': 'js', '.mjs': 'js', '.cjs': 'js',
  '.java': 'java', '.kt': 'kotlin', '.scala': 'scala', '.cs': 'cs',
  '.go': 'go', '.rs': 'rust', '.swift': 'swift', '.dart': 'dart',
  '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.hpp': 'cpp', '.php': 'php'
};

export function languageOf(fileName: string): string | null {
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.')).toLowerCase() : '';
  if (ext === '.py' || ext === '.pyi') return 'python';
  return BRACE_LANGS[ext] || null;
}

export function skeletonize(code: string, fileName = 'file.ts'): SkeletonResult {
  const language = languageOf(fileName) || 'unknown';
  let skeleton = code;
  if (language === 'python') skeleton = skeletonizePython(code);
  else if (language !== 'unknown') skeleton = skeletonizeBraces(code, language);
  skeleton = skeleton.replace(/\n{3,}/g, '\n\n');
  const originalTokens = estimateTokens(code);
  const skeletonTokens = estimateTokens(skeleton);
  const percentSaved =
    originalTokens > 0 ? Math.max(0, Math.round(((originalTokens - skeletonTokens) / originalTokens) * 100)) : 0;
  return { skeleton, originalTokens, skeletonTokens, percentSaved, language };
}

/** Returns map of '{' index -> matching '}' index, ignoring braces in strings/comments. */
export function matchBraces(src: string): Map<number, number> {
  const pairs = new Map<number, number>();
  const stack: Array<{ kind: 'brace' | 'tpl'; pos: number }> = [];
  let i = 0;
  const n = src.length;
  // Inside a template literal we scan until ` or ${
  const inTemplate = () => stack.length > 0 && stack[stack.length - 1].kind === 'tpl';

  const scanTemplate = () => {
    // precondition: positioned just after ` or after the } closing a ${...}
    while (i < n) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i++; return; }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'tpl', pos: i + 1 });
        i += 2;
        return;
      }
      i++;
    }
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') {
      i++;
      scanTemplate();
      continue;
    }
    if (c === '{') {
      stack.push({ kind: 'brace', pos: i });
      i++;
      continue;
    }
    if (c === '}') {
      const top = stack.pop();
      if (top && top.kind === 'brace') pairs.set(top.pos, i);
      i++;
      if (top && top.kind === 'tpl') scanTemplate();
      continue;
    }
    i++;
  }
  void inTemplate;
  return pairs;
}

const CONTAINER_RE =
  /\b(class|interface|struct|enum|trait|impl|namespace|module|object|protocol|extension|union|record)\b[^;{}=]*$|\btype\s+\w+(<[^>]*>)?\s*=\s*$|\bdeclare\s+(global|module)\b/;
const FUNCTION_RE = /(\)\s*(:[^{};=]+|->[^{};]+|throws[^{};]*|\w[\w<>,\s?*&[\]]*)?\s*$)|=>\s*$|\b(fn|func|function|fun|def)\b[^{};]*$|\b(get|set|init|deinit)\s*$/;

function stubBody(inner: string): string {
  const lines = inner.split('\n').length - 1;
  return lines > 1 ? `{ /* …${lines} lines */ }` : '{ /* … */ }';
}

function skeletonizeBraces(src: string, _lang: string): string {
  const pairs = matchBraces(src);

  function walk(start: number, end: number): string {
    let out = '';
    let cursor = start;
    let i = start;
    let headerStart = start;
    while (i < end) {
      const close = pairs.get(i);
      if (close === undefined || close > end) {
        const ch = src[i];
        if (ch === ';' || ch === '\n') {
          // header boundary; only reset on ';' or on newline when previous line ended a statement
          if (ch === ';') headerStart = i + 1;
        }
        i++;
        continue;
      }
      // Header = text between the last statement boundary and this brace.
      const lastBoundary = Math.max(
        headerStart,
        src.lastIndexOf('}', i - 1) + 1 > start ? src.lastIndexOf('}', i - 1) + 1 : start
      );
      const header = src.slice(lastBoundary, i).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim();
      const inner = src.slice(i + 1, close);
      out += src.slice(cursor, i);
      if (CONTAINER_RE.test(header) && !FUNCTION_RE.test(header.replace(/\bclass\b.*$/, ''))) {
        out += '{' + walk(i + 1, close) + '}';
      } else if (FUNCTION_RE.test(header)) {
        out += stubBody(inner);
      } else if (inner.length <= 160) {
        out += src.slice(i, close + 1);
      } else {
        out += stubBody(inner);
      }
      cursor = close + 1;
      i = close + 1;
      headerStart = i;
    }
    out += src.slice(cursor, end);
    return out;
  }

  return walk(0, src.length)
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n');
}

function indentOf(line: string): number {
  const m = line.match(/^[ \t]*/);
  return m ? m[0].replace(/\t/g, '    ').length : 0;
}

function skeletonizePython(code: string): string {
  const lines = code.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\s*)(async\s+def|def)\s+/);
    if (!m) {
      out.push(line);
      i++;
      continue;
    }
    const base = indentOf(line);
    // Signature may span lines until a line ends with ':' at paren depth 0.
    let depth = 0;
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j].replace(/#.*$/, '');
      for (const ch of l) {
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch)) depth--;
      }
      out.push(lines[j]);
      if (depth <= 0 && /:\s*$/.test(l)) break;
    }
    j++;
    // Body = following lines indented deeper than the def (blank lines included).
    let k = j;
    while (k < lines.length && (lines[k].trim() === '' || indentOf(lines[k]) > base)) k++;
    // Trim trailing blank lines back into the outer scope.
    let bodyEnd = k;
    while (bodyEnd > j && lines[bodyEnd - 1].trim() === '') bodyEnd--;
    const body = lines.slice(j, bodyEnd);
    const pad = ' '.repeat(base + 4);
    const first = body.find((l) => l.trim() !== '');
    if (first && /^\s*[rbuf]*("""|''')/.test(first)) {
      const q = first.includes('"""') ? '"""' : "'''";
      const t = first.trim();
      const oneLine = t.length > 6 && t.endsWith(q) && t.indexOf(q) !== t.lastIndexOf(q);
      out.push(oneLine ? `${pad}${t}` : `${pad}${t.replace(/\s*$/, '')} …${q}`);
    }
    out.push(`${pad}...  # ${body.length} lines`);
    for (let b = bodyEnd; b < k; b++) out.push(lines[b]);
    i = k;
  }
  return out.join('\n');
}

/** Extracts top-level symbol names (for repo maps). */
export function extractSymbols(code: string, fileName: string): string[] {
  return extractSymbolLines(code, fileName).map((s) => s.name);
}

/** Top-level symbols with their 1-based declaration line (for the code graph). */
export function extractSymbolLines(code: string, fileName: string): Array<{ name: string; line: number }> {
  const lang = languageOf(fileName);
  const syms: Array<{ name: string; line: number }> = [];
  const seen = new Set<string>();
  let lineNo = 0;
  const add = (s: string) => {
    if (s && !seen.has(s)) {
      seen.add(s);
      syms.push({ name: s, line: lineNo });
    }
  };
  const lines = code.split('\n');
  for (const line of lines) {
    lineNo++;
    let m: RegExpMatchArray | null;
    if (lang === 'python') {
      if ((m = line.match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)/))) add(m[1] + '()');
      else if ((m = line.match(/^class\s+([A-Za-z_]\w*)/))) add('class ' + m[1]);
    } else if (lang === 'go') {
      if ((m = line.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/))) add(m[1] + '()');
      else if ((m = line.match(/^type\s+([A-Za-z_]\w*)\s+(struct|interface)/))) add(m[2] + ' ' + m[1]);
    } else if (lang === 'rust') {
      if ((m = line.match(/^\s*pub(?:\([^)]*\))?\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/))) add(m[1] + '()');
      else if ((m = line.match(/^\s*pub(?:\([^)]*\))?\s+(struct|enum|trait)\s+([A-Za-z_]\w*)/))) add(m[1] + ' ' + m[2]);
    } else if (lang === 'ts' || lang === 'js') {
      if ((m = line.match(/^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(function\*?|class|interface|type|enum|const|let|var)\s+([A-Za-z_$][\w$]*)/))) {
        const kind = m[1].replace('*', '');
        add(kind === 'function' ? m[2] + '()' : kind === 'const' || kind === 'let' || kind === 'var' ? m[2] : `${kind} ${m[2]}`);
      } else if ((m = line.match(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/))) add(m[1] + '()');
      else if ((m = line.match(/^class\s+([A-Za-z_$][\w$]*)/))) add('class ' + m[1]);
    } else if (lang) {
      if ((m = line.match(/^\s*(?:public|export)?\s*(?:abstract\s+|final\s+|sealed\s+)*(class|interface|struct|enum|record)\s+([A-Za-z_]\w*)/)))
        add(m[1] + ' ' + m[2]);
    }
  }
  return syms;
}
