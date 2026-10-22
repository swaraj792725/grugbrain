/**
 * `grug exec '<command>'`: runs a command and prints its output shortened by the same chain the
 * Claude Code PostToolUse hook uses. Other apps (Antigravity, Codex) cannot rewrite a tool's output
 * after it ran, so their PreToolUse hook rewrites noisy commands to go through this wrapper instead.
 * The exit code is kept, and the untouched output is saved (the shortened text points at it).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig, paths } from '../config.js';
import { ruleFor } from '../compress/cmdrules.js';
import { checkSegment } from '../handoff.js';
import { recordActivity } from '../stats.js';

const WRAPPED = / exec (?:--app [a-z]+ )?-- '/;
// Runs that never end or need a terminal: never wrapped (the wrapper prints only at the end).
const NO_WRAP = /(^|[\s;&|(])(?:vim?|nano|less|more|top|htop|ssh|tail\s+-f|watch|docker\s+(?:compose\s+)?(?:up|logs\s+-f|attach|exec\s+-it)|npm\s+(?:run\s+)?(?:dev|start|serve)|pnpm\s+(?:run\s+)?(?:dev|start|serve)|yarn\s+(?:dev|start|serve)|next\s+dev|vite(?:\s+dev)?\s*$|python3?\s+-m\s+http\.server)\b|--watch\b|\s-w(?:\s|$)|&\s*$/;
const NOISY = /(^|[\s;&|(])(?:npm|pnpm|yarn|bun)\s+(?:ci|install|i|add|update|test|run\s+(?:test|build|lint|check|typecheck))\b|(?:pip3?|uv\s+pip|poetry)\s+install\b|cargo\s+(?:build|test|check|clippy)\b|go\s+(?:build|test|vet)\b|(?:pytest|vitest|jest|tsc|mvn|gradle|\.\/gradlew)\b|make\b/;

/** Is this a finite, noisy command worth shortening (tests, builds, installs)? */
export function shouldWrap(cmd: string): boolean {
  const c = cmd.trim();
  if (!c || c.length > 2000 || WRAPPED.test(c) || NO_WRAP.test(c)) return false;
  return Boolean(ruleFor(c) || checkSegment(c) || NOISY.test(c));
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The wrapped command: readable in the app's approval prompt (the original stays visible, quoted). */
export function wrapCommand(cmd: string, app: string): string {
  const launcher = path.join(paths.home(), 'bin', 'grug');
  const cli = path.join(paths.app(), 'cli.js');
  const head = fs.existsSync(launcher) ? q(launcher) : `${q(process.execPath)} ${q(fs.existsSync(cli) ? cli : process.argv[1] || cli)}`;
  return `${head} exec --app ${app} -- ${q(cmd)}`;
}

/** The original command inside a wrapped one (else the command itself). */
export function unwrapCommand(cmd: string): string {
  const m = WRAPPED.exec(cmd);
  if (!m) return cmd;
  const rest = cmd.slice(m.index + m[0].length - 1).trim();
  if (!rest.startsWith("'") || !rest.endsWith("'")) return cmd;
  return rest.slice(1, -1).replace(/'\\''/g, "'");
}

/** Run the command in the user's shell, collect stdout+stderr in arrival order, print the shortened text. */
export async function runExec(cmd: string, app = 'another app'): Promise<number> {
  const shell = process.env.SHELL && fs.existsSync(process.env.SHELL) ? process.env.SHELL : '/bin/sh';
  const chunks: Buffer[] = [];
  const code: number = await new Promise((resolve) => {
    const child = spawn(shell, ['-c', cmd], { stdio: ['inherit', 'pipe', 'pipe'] });
    child.stdout.on('data', (b: Buffer) => chunks.push(b));
    child.stderr.on('data', (b: Buffer) => chunks.push(b));
    const onTerm = () => child.kill('SIGTERM');
    const onInt = () => child.kill('SIGINT');
    process.on('SIGTERM', onTerm);
    process.on('SIGINT', onInt);
    const done = (n: number) => {
      process.off('SIGTERM', onTerm);
      process.off('SIGINT', onInt);
      resolve(n);
    };
    child.on('error', (e) => {
      chunks.push(Buffer.from(`grug exec: ${e.message}\n`));
      done(127);
    });
    child.on('close', (c, sig) => done(c ?? (sig ? 128 + ((({ SIGINT: 2, SIGKILL: 9, SIGTERM: 15 }) as Record<string, number>)[sig] || 0) : 1)));
  });
  const raw = Buffer.concat(chunks).toString('utf8');
  let text = raw;
  try {
    const { shrinkToolText } = await import('../hooks.js');
    const r = shrinkToolText(loadConfig(), 'Bash', cmd, raw);
    const removed = raw.length - r.text.length;
    if (r.kind && removed >= 200) {
      const { reword } = await import('./common.js');
      text = app === 'antigravity' || app === 'codex' ? reword(app, r.text) : r.text;
      recordActivity({ kind: r.kind, msg: `Shortened ${r.ruleName || 'command'} output in ${app} (${Math.round((removed / raw.length) * 100)}% smaller)`, tokens: Math.round(removed / 3.6), project: path.basename(process.cwd()) });
    }
  } catch {
    text = raw; // never lose the output
  }
  process.stdout.write(text.endsWith('\n') || !text ? text : text + '\n');
  return code;
}
