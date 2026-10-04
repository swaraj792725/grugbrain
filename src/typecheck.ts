/**
 * Post-edit type check for TypeScript (SWE-agent's lint guardrail, type-aware). Before an Edit/Write of a .ts file
 * the errors already present in that file and the files that import it are noted; after the edit only NEW errors are
 * reported, so pre-existing breakage never sends Claude off course. Uses the project's own TypeScript and tsconfig,
 * checks just the edited file plus its in-project importers (a signature change shows up at the callers), and stays
 * silent when nothing new broke. A project where one check takes too long is skipped for the rest of the session.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { paths, ensureDir, readJson, writeJsonAtomic } from './config.js';
import { graphIndexFor, projectImports } from './graph.js';

const TS_RE = /\.(ts|tsx|mts|cts)$/i;
const SLOW_MS = 2500;
const MAX_IMPORTERS = 6;

interface State {
  slow?: string[];
  base?: Record<string, string[]>;
}

function stateFile(sid: string): string {
  return path.join(paths.home(), 'typecheck', `${sid.replace(/[^\w-]/g, '_')}.json`);
}

function loadState(sid: string): State {
  const r = readJson(stateFile(sid));
  return r.ok && r.value && typeof r.value === 'object' ? (r.value as State) : {};
}

function saveState(sid: string, s: State): void {
  const file = stateFile(sid);
  const dir = path.dirname(file);
  ensureDir(dir);
  if (!fs.existsSync(file)) {
    // A new session: drop state files of sessions idle for 2+ days.
    for (const f of fs.readdirSync(dir)) {
      try {
        if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > 2 * 86400000) fs.rmSync(path.join(dir, f), { force: true });
      } catch {
        /* best-effort */
      }
    }
  }
  writeJsonAtomic(file, s);
}

/** In-project files that import this file (code graph cache, or a quick build for a small repo). */
export function importersOf(cwd: string, abs: string): string[] {
  const { index } = graphIndexFor(cwd, 120);
  if (!index) return [];
  const rel = path.relative(index.root, abs).split(path.sep).join('/');
  return index.files
    .filter((f) => f.rel !== rel && projectImports(index, f, 8).includes(rel))
    .slice(0, MAX_IMPORTERS)
    .map((f) => path.join(index.root, f.rel));
}

/** Error fingerprints (file + message, no line numbers: lines move with edits) for `abs` and its importers. */
export function typeErrors(cwd: string, abs: string): { errors: { file: string; line: number; text: string; fp: string }[]; ms: number } | null {
  let ts: any;
  try {
    ts = createRequire(path.join(cwd, 'noop.js'))('typescript');
  } catch {
    return null; // no TypeScript in this project
  }
  const t0 = Date.now();
  try {
    const cfgPath = ts.findConfigFile(path.dirname(abs), ts.sys.fileExists);
    if (!cfgPath || !path.resolve(cfgPath).startsWith(path.resolve(cwd) + path.sep)) return null; // no tsconfig of this project
    const parsed = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic() {} });
    if (!parsed) return null;
    const files = [abs, ...importersOf(cwd, abs)].filter((f) => fs.existsSync(f));
    const program = ts.createProgram(files, { ...parsed.options, noEmit: true, skipLibCheck: true, incremental: false, composite: false });
    const errors: { file: string; line: number; text: string; fp: string }[] = [];
    for (const f of files) {
      const sf = program.getSourceFile(f);
      if (!sf) continue;
      for (const d of [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)]) {
        if (d.category !== ts.DiagnosticCategory.Error) continue;
        const text = ts.flattenDiagnosticMessageText(d.messageText, ' ');
        const line = d.start !== undefined ? sf.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
        const rel = path.relative(cwd, f);
        errors.push({ file: rel, line, text, fp: `${rel}\u0000TS${d.code}\u0000${text}` });
      }
    }
    return { errors, ms: Date.now() - t0 };
  } catch {
    return null;
  }
}

function eligible(cwd: string, file: string): string | null {
  if (!file || !TS_RE.test(file) || /\.d\.[mc]?ts$/i.test(file)) return null;
  const abs = path.resolve(cwd, file);
  return abs.startsWith(path.resolve(cwd) + path.sep) && !abs.includes(`${path.sep}node_modules${path.sep}`) ? abs : null;
}

/** PreToolUse: remember the errors that exist before this edit. */
export function typeBaseline(sid: string, cwd: string, file: string): void {
  const abs = eligible(cwd, file);
  if (!abs) return;
  const s = loadState(sid);
  if (s.slow?.includes(path.resolve(cwd))) return;
  const r = fs.existsSync(abs) ? typeErrors(cwd, abs) : { errors: [], ms: 0 };
  if (!r) return;
  s.base = s.base || {};
  s.base[abs] = r.errors.map((e) => e.fp);
  if (r.ms > SLOW_MS) s.slow = [...(s.slow || []), path.resolve(cwd)];
  saveState(sid, s);
}

/** PostToolUse: text for Claude about errors this edit introduced, or null. */
export function typeCheckMessage(sid: string, cwd: string, file: string): string | null {
  const abs = eligible(cwd, file);
  if (!abs) return null;
  const s = loadState(sid);
  const before = s.base?.[abs];
  if (!before || s.slow?.includes(path.resolve(cwd))) return null; // no baseline: cannot tell new from old
  const r = typeErrors(cwd, abs);
  if (!r) return null;
  const seen = new Set(before);
  const fresh = r.errors.filter((e) => !seen.has(e.fp));
  // The new state is the baseline for the next edit of this file, so an error is reported once.
  s.base![abs] = r.errors.map((e) => e.fp);
  if (r.ms > SLOW_MS) s.slow = [...(s.slow || []), path.resolve(cwd)];
  saveState(sid, s);
  if (!fresh.length) return null;
  const lines = fresh.slice(0, 6).map((e) => `${e.file}:${e.line} ${e.text.length > 220 ? e.text.slice(0, 220) + '…' : e.text}`);
  const more = fresh.length > 6 ? `\n(+${fresh.length - 6} more)` : '';
  return `grugbrain type check: this edit introduced ${fresh.length} new type error${fresh.length > 1 ? 's' : ''} (errors that were already there are not listed):\n${lines.join('\n')}${more}`;
}
