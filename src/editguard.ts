/**
 * Post-edit guard (SWE-agent's lesson: models slip on edits and recover badly, so catch a broken edit at once).
 * After Edit/Write/MultiEdit, check that file's syntax with a fast local checker. Silent when the file is fine,
 * a few lines when it is not, so a healthy session pays nothing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const MAX_BYTES = 1_500_000;

function run(cmd: string, args: string[], cwd: string): { status: number | null; out: string; missing: boolean } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 4000, env: { ...process.env, GRUG_DISABLE: '1' } });
  return { status: r.status, out: `${r.stderr || ''}${r.stdout || ''}`.trim(), missing: (r.error as any)?.code === 'ENOENT' };
}

function short(s: string, n = 600): string {
  const t = s.replace(/\x1b\[[0-9;]*m/g, '').split('\n').filter((l) => l.trim()).slice(0, 8).join('\n');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/** Syntax error text for this file, or null when it is fine or cannot be judged. */
export function syntaxError(file: string, cwd: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size > MAX_BYTES) return null;
  const ext = path.extname(file).toLowerCase();
  if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(file, 'utf8'));
      return null;
    } catch (e: any) {
      return `invalid JSON: ${String(e.message).slice(0, 200)}`;
    }
  }
  if (ext === '.py') {
    const r = run('python3', ['-m', 'py_compile', file], cwd);
    return r.missing || r.status === 0 ? null : short(r.out);
  }
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const r = run(process.execPath, ['--check', file], cwd);
    if (r.status === 0) return null;
    // Node < 20 parses a .js file in a non-module package as CommonJS, so valid ESM fails; check it as .mjs.
    if (ext === '.js' && /ES module|import statement outside a module|Unexpected token 'export'/.test(r.out)) {
      const tmp = path.join(os.tmpdir(), `grug-check-${process.pid}-${Date.now()}.mjs`);
      try {
        fs.copyFileSync(file, tmp);
        const m = run(process.execPath, ['--check', tmp], cwd);
        return m.status === 0 ? null : short(m.out.split(tmp).join(file));
      } catch {
        return null;
      } finally {
        fs.rmSync(tmp, { force: true });
      }
    }
    return short(r.out);
  }
  if (ext === '.sh' || ext === '.bash') {
    const r = run('bash', ['-n', file], cwd);
    return r.missing || r.status === 0 ? null : short(r.out);
  }
  if (ext === '.ts' || ext === '.tsx' || ext === '.mts' || ext === '.cts') return tsSyntax(file, cwd);
  return null;
}

/** Syntactic diagnostics via the project's own TypeScript (no type check: fast, no false alarms from config). */
function tsSyntax(file: string, cwd: string): string | null {
  let ts: any;
  try {
    ts = createRequire(path.join(cwd, 'noop.js'))('typescript');
  } catch {
    return null; // no TypeScript in this project: nothing to judge with
  }
  try {
    const src = fs.readFileSync(file, 'utf8');
    const out = ts.transpileModule(src, { fileName: file, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2022 } });
    const errs = (out.diagnostics || []).filter((d: any) => d.category === ts.DiagnosticCategory.Error).slice(0, 5);
    if (!errs.length) return null;
    return errs
      .map((d: any) => {
        const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null;
        return `${pos ? `L${pos.line + 1}:${pos.character + 1} ` : ''}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`;
      })
      .join('\n');
  } catch {
    return null;
  }
}

/** Text for the model after an edit, or null. One line per file; only real syntax errors. */
export function editGuardMessage(files: string[], cwd: string): string | null {
  const root = path.resolve(cwd) + path.sep;
  const lines: string[] = [];
  for (const f of [...new Set(files)].slice(0, 4)) {
    const abs = path.resolve(f);
    if (!abs.startsWith(root)) continue;
    const err = syntaxError(abs, cwd);
    if (err) lines.push(`${path.relative(cwd, abs)}:\n${err}`);
  }
  if (!lines.length) return null;
  return `grugbrain edit guard: your last edit left a syntax error in the file (most likely caused by that edit). Fix it before anything else:\n${lines.join('\n')}`;
}
