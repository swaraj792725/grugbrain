/**
 * Verify before done (Stop hook). Claude Code's own guidance: the biggest quality lever is a pass/fail
 * check that Claude must satisfy. grug runs the project's own check once when files changed this turn and,
 * if it fails, sends Claude back with only the failing lines. Costs tokens only when something is broken.
 *
 *  - Change-gated: no edits this turn (or the same edits already checked) -> nothing runs.
 *  - Bounded: at most `verifyMaxRounds` send-backs per prompt, a hard timeout, and any doubt -> stay silent.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { GrugConfig } from './config.js';
import { BufferEvent, appendBuffer, readBuffer } from './memory/store.js';
import { recordActivity } from './stats.js';
import { estimateTokens } from './tokens.js';

const NON_CODE = /\.(md|mdx|txt|rst|lock|log|png|jpe?g|gif|webp|svg|ico|pdf|csv)$/i;
const FAIL_LINE = /\b(error|fail(ed|ure|ing)?|assert(ion)?|expected|received|exception|traceback|panic|cannot|not found|undefined|TS\d{4}|E\d{4})\b|✗|✖|×|^\s*at .+:\d+|^\s*File ".+", line \d+/i;
const MAX_CHARS = 1800;

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** The command that checks this project, or null. Only fast, standard checks; `quality.verifyCommand` overrides. */
export function detectCheck(cwd: string, override = ''): string | null {
  if (override.trim()) return override.trim();
  const has = (f: string) => fs.existsSync(path.join(cwd, f));
  const pkg = has('package.json') ? readJson(path.join(cwd, 'package.json')) : null;
  if (pkg) {
    const scripts = pkg.scripts || {};
    const parts: string[] = [];
    if (scripts.typecheck) parts.push('npm run -s typecheck');
    else if (has('tsconfig.json') && has('node_modules/.bin/tsc')) parts.push('node_modules/.bin/tsc --noEmit');
    const test = String(scripts.test || '');
    if (test && !/no test specified/.test(test)) parts.push('npm test --silent');
    if (parts.length) return parts.join(' && ');
    return null;
  }
  if (has('Cargo.toml')) return 'cargo check -q';
  if (has('go.mod')) return 'go vet ./...';
  if (has('pytest.ini') || has('tox.ini') || has('conftest.py') || (has('pyproject.toml') && /pytest/.test(fs.readFileSync(path.join(cwd, 'pyproject.toml'), 'utf8')))) return 'python -m pytest -x -q';
  return null;
}

/** Files edited since the last prompt (this turn), inside the project, that are code. */
export function editedThisTurn(events: BufferEvent[], cwd: string): string[] {
  let i = events.length - 1;
  while (i >= 0 && events[i].t !== 'prompt') i--;
  const root = path.resolve(cwd) + path.sep;
  const out = new Set<string>();
  for (const e of events.slice(i + 1)) {
    if (e.t === 'file' && e.op === 'edit') {
      const abs = path.resolve(e.path);
      if (abs.startsWith(root) && !NON_CODE.test(abs) && !abs.includes(`${path.sep}node_modules${path.sep}`)) out.add(abs);
    }
  }
  return [...out];
}

function signature(files: string[]): string {
  const h = createHash('sha1');
  for (const f of files.sort()) {
    try {
      const st = fs.statSync(f);
      h.update(`${f}|${st.mtimeMs}|${st.size};`);
    } catch {
      h.update(`${f}|gone;`);
    }
  }
  return h.digest('hex').slice(0, 12);
}

/** Only the lines that say what is wrong, with a little context; falls back to the tail. */
export function failureExcerpt(raw: string, maxChars = MAX_CHARS): string {
  const lines = raw.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r(?!\n)/g, '\n').split('\n');
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    if (FAIL_LINE.test(l)) {
      keep.add(i);
      if (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) keep.add(i + 1);
    }
  });
  let picked = [...keep].sort((a, b) => a - b).map((i) => lines[i].trimEnd());
  if (!picked.length) picked = lines.filter((l) => l.trim()).slice(-25);
  // Drop exact repeats (a failing suite prints the same frame many times).
  picked = picked.filter((l, i) => picked.indexOf(l) === i);
  let text = picked.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars * 0.6) + '\n…\n' + text.slice(-maxChars * 0.35);
  return text;
}

export interface VerifyResult {
  block: boolean;
  reason?: string;
}

/**
 * Decide at Stop. Returns {block:true, reason} only when the check ran, failed, and rounds remain.
 * `run` is injectable for tests.
 */
export function verifyAtStop(
  cfg: GrugConfig,
  sid: string,
  cwd: string,
  now: number,
  run: (cmd: string, cwd: string, timeoutMs: number) => { status: number | null; output: string; timedOut: boolean } = defaultRun
): VerifyResult {
  const q = cfg.quality;
  if (!q.verify) return { block: false };
  const events = readBuffer(sid);
  const files = editedThisTurn(events, cwd);
  if (!files.length) return { block: false };
  const sig = signature(files);
  let lastPrompt = events.length - 1;
  while (lastPrompt >= 0 && events[lastPrompt].t !== 'prompt') lastPrompt--;
  const turn = events.slice(lastPrompt + 1).filter((e): e is Extract<BufferEvent, { t: 'verify' }> => e.t === 'verify');
  if (turn.some((v) => v.sig === sig)) return { block: false }; // these exact edits were already checked
  const failedRounds = turn.filter((v) => v.ok === false).length;
  if (failedRounds >= q.verifyMaxRounds) return { block: false };
  const cmd = detectCheck(cwd, q.verifyCommand);
  if (!cmd) return { block: false };
  const t0 = Date.now();
  const r = run(cmd, cwd, q.verifyTimeoutSec * 1000);
  const ms = Date.now() - t0;
  if (r.timedOut || r.status === null) {
    appendBuffer(sid, { t: 'verify', ts: now, sig, ok: null, ms });
    return { block: false };
  }
  if (r.status === 0) {
    appendBuffer(sid, { t: 'verify', ts: now, sig, ok: true, ms });
    recordActivity({ kind: 'verify', msg: `Checked the edits before finishing: \`${cmd}\` passed (${(ms / 1000).toFixed(1)}s)`, tokens: 0, project: path.basename(cwd) });
    return { block: false };
  }
  appendBuffer(sid, { t: 'verify', ts: now, sig, ok: false, ms });
  const excerpt = failureExcerpt(r.output);
  const round = failedRounds + 1;
  const reason =
    `grugbrain verify: \`${cmd}\` FAILED after your edits (round ${round}/${q.verifyMaxRounds}). Failing output:\n${excerpt}\n` +
    `Fix the cause, not the check (do not skip or weaken tests). If this failure is unrelated to your edits, say so in one line and finish.`;
  recordActivity({ kind: 'verify', msg: `Sent Claude back: \`${cmd}\` failed after edits (round ${round})`, tokens: -estimateTokens(reason), project: path.basename(cwd) });
  return { block: true, reason };
}

function defaultRun(cmd: string, cwd: string, timeoutMs: number): { status: number | null; output: string; timedOut: boolean } {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, CI: '1', FORCE_COLOR: '0', GRUG_DISABLE: '1' } });
  const timedOut = (r.error as any)?.code === 'ETIMEDOUT' || r.signal === 'SIGTERM';
  return { status: r.status, output: `${r.stdout || ''}\n${r.stderr || ''}`, timedOut };
}
