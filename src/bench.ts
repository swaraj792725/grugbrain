/**
 * `grug bench`: prove savings don't cost quality.
 * Runs real Claude Code (`claude -p`) on small generated repos, twice per task:
 *   off: grug hooks disabled + proxy in raw pass-through mode (baseline)
 *   on : grug hooks + proxy optimizations
 * Each task has an objective check (tests pass / exact answer), so quality is measured, not guessed.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ensureDir, loadConfig, paths, writeJsonAtomic } from './config.js';
import { health, installedCli, MARK } from './install.js';
import { proxyHealth } from './proxy/server.js';
import { recordActivity } from './stats.js';
import { fmtUsd } from './tokens.js';
import { SHOP_STEPS, shopCheck, shopFiles } from './benchlong.js';

export interface BenchTask {
  id: string;
  exercises: string;
  prompt: string;
  files: () => Record<string, string>;
  /** Follow-up prompts sent in the same session (resumed), for long-session tasks. */
  steps?: string[];
  check: (dir: string, result: string) => { pass: boolean; why: string };
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex');

function runnerScript(): string {
  // A deliberately noisy test runner (vitest-like output) with one real failure.
  return `import { median, mean } from './src/stats.js';
let passed = 0, failed = 0; const failures = [];
function t(name, fn) { try { fn(); passed++; console.log(' ✓ ' + name); } catch (e) { failed++; failures.push([name, e]); console.log(' × ' + name); } }
const eq = (a, b) => { if (a !== b) throw new Error('expected ' + JSON.stringify(b) + ' but got ' + JSON.stringify(a)); };
for (let i = 1; i <= 400; i++) t('mean of constant list #' + i, () => eq(mean([i, i, i]), i));
t('median of odd list', () => eq(median([5, 1, 3]), 3));
t('median of even list', () => eq(median([4, 1, 3, 2]), 2.5));
t('median does not mutate input', () => { const a = [3, 1, 2]; median(a); eq(a.join(','), '3,1,2'); });
if (failures.length) { console.log('\\n FAIL'); for (const [n, e] of failures) console.log('  ' + n + '\\n  ' + e.stack.split('\\n').slice(0, 3).join('\\n  ')); }
console.log('\\n Tests  ' + (failed ? failed + ' failed | ' : '') + passed + ' passed (' + (passed + failed) + ')');
process.exit(failed ? 1 : 0);
`;
}

function durationTests(): string {
  return `import { parseDuration as p } from './src/duration.js';
const cases = [['90s', 90], ['2h', 7200], ['1h30m', 5400], ['45m', 2700], ['1h 30m', 5400], ['0s', 0], ['', null], ['abc', null], ['1d', null]];
let bad = 0;
for (const [i, want] of cases) {
  let got;
  try { got = p(i); } catch { got = null; }
  if (got !== want) { console.error('FAIL parseDuration(' + JSON.stringify(i) + ') expected ' + want + ' got ' + got); bad++; }
}
process.exit(bad ? 1 : 0);
`;
}

function csvTests(): string {
  return `import { parseCsv } from './src/csv.js';
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cases = [
  ['a,b,c', [['a', 'b', 'c']]],
  ['a,b\\nc,d\\n', [['a', 'b'], ['c', 'd']]],
  ['a,b\\r\\nc,d\\r\\n', [['a', 'b'], ['c', 'd']]],
  ['"x, y",z', [['x, y', 'z']]],
  ['"say ""hi""",z', [['say "hi"', 'z']]],
  ['"line1\\nline2",z', [['line1\\nline2', 'z']]],
  ['a,,c', [['a', '', 'c']]],
  ['a,b,', [['a', 'b', '']]],
  ['', []],
  ['\\n\\na,b\\n\\n', [['a', 'b']]]
];
let bad = 0;
for (const [i, want] of cases) {
  let got;
  try { got = parseCsv(i); } catch (e) { got = 'threw ' + e.message; }
  if (!eq(got, want)) { console.error('FAIL parseCsv(' + JSON.stringify(i) + ') expected ' + JSON.stringify(want) + ' got ' + JSON.stringify(got)); bad++; }
}
process.exit(bad ? 1 : 0);
`;
}

function rippleFiles(): Record<string, string> {
  return {
    'package.json': JSON.stringify({ name: 'bench-ripple', type: 'module', private: true, scripts: { test: 'node test.js' } }, null, 2),
    'test.js': `import { price } from './src/pricing.js';
import { invoiceTotal } from './src/invoice.js';
import { quote } from './src/quote.js';
import { receiptLine } from './src/receipt.js';
const checks = [
  ['price eur', price(1000, { currency: 'EUR' }), 1000],
  ['price usd', price(1000, { currency: 'USD' }), 1080],
  ['price default', price(1000, {}), 1080],
  ['invoice', invoiceTotal([{ cents: 1000 }, { cents: 500 }], 'EUR'), 1500],
  ['quote', quote(2000, 'USD'), 2160],
  ['receipt', receiptLine('tea', 500, 'USD'), 'tea: 540 USD']
];
let bad = 0;
for (const [n, got, want] of checks) if (got !== want) { console.error('FAIL ' + n + ' expected ' + want + ' got ' + got); bad++; }
process.exit(bad ? 1 : 0);
`,
    'src/pricing.js': `export const RATES = { USD: 1.08, EUR: 1.0 };\nexport function price(cents, currency = 'USD') {\n  return Math.round(cents * (RATES[currency] ?? 1.08));\n}\n`,
    'src/invoice.js': `import { price } from './pricing.js';\nexport function invoiceTotal(lines, currency) {\n  return lines.reduce((sum, l) => sum + price(l.cents, currency), 0);\n}\n`,
    'src/quote.js': `import { price } from './pricing.js';\nexport function quote(cents, currency) {\n  return price(cents, currency);\n}\n`,
    'src/receipt.js': `import { price } from './pricing.js';\nexport function receiptLine(name, cents, currency) {\n  return name + ': ' + price(cents, currency) + ' ' + currency;\n}\n`
  };
}

export const TASKS: BenchTask[] = [
  {
    id: 'csv-trap',
    exercises: 'verify-before-done (many small edge cases, tests not mentioned in the prompt)',
    prompt: 'Implement parseCsv(text) in src/csv.js as a named export. It returns an array of rows, each an array of string fields, for RFC 4180 style CSV.',
    files: () => ({
      'package.json': JSON.stringify({ name: 'bench-csv', type: 'module', private: true, scripts: { test: 'node test.js' } }, null, 2),
      'test.js': csvTests(),
      'src/csv.js': `// TODO: implement parseCsv\nexport {};\n`
    }),
    check: (dir) => {
      if (sha(fs.readFileSync(path.join(dir, 'test.js'), 'utf8')) !== sha(csvTests())) return { pass: false, why: 'edited the test file' };
      const r = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
      return r.status === 0 ? { pass: true, why: 'all CSV cases pass' } : { pass: false, why: (r.stderr || '').split('\n')[0].slice(0, 100) };
    }
  },
  {
    id: 'signature-ripple',
    exercises: 'verify-before-done (a signature change must reach every caller)',
    prompt: 'In src/pricing.js, change price(cents, currency) so its second argument is an options object { currency } instead of a bare currency string (default currency stays USD). Update the code so nothing else breaks.',
    files: rippleFiles,
    check: (dir) => {
      const r = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
      return r.status === 0 ? { pass: true, why: 'every caller updated' } : { pass: false, why: (r.stderr || '').split('\n')[0].slice(0, 100) };
    }
  },
  {
    id: 'edge-case-trap',
    exercises: 'verify-before-done (quality gate: the project test catches an edge case the prompt does not list)',
    prompt: 'Implement parseDuration(str) in src/duration.js: it turns strings like "90s", "2h" or "1h30m" into a number of seconds. Export it as a named export. The project has tests (`npm test`).',
    files: () => ({
      'package.json': JSON.stringify({ name: 'bench-duration', type: 'module', private: true, scripts: { test: 'node test.js' } }, null, 2),
      'test.js': durationTests(),
      'src/duration.js': `// TODO: implement parseDuration\nexport {};\n`
    }),
    check: (dir) => {
      const untouched = sha(fs.readFileSync(path.join(dir, 'test.js'), 'utf8')) === sha(durationTests());
      if (!untouched) return { pass: false, why: 'edited the test file' };
      const r = spawnSync(process.execPath, ['test.js'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
      return r.status === 0 ? { pass: true, why: 'all edge cases pass' } : { pass: false, why: 'an edge case still fails' };
    }
  },
  {
    id: 'fix-failing-test',
    exercises: 'test-output summarizer, trimming',
    prompt: 'Run `node run-tests.js`. Some tests fail. Fix the bug(s) in src/stats.js (do not edit the tests) so that all tests pass, then run the tests again to confirm.',
    files: () => ({
      'package.json': JSON.stringify({ name: 'bench-stats', type: 'module', private: true }, null, 2),
      'run-tests.js': runnerScript(),
      'src/stats.js': `export function mean(xs) {\n  return xs.reduce((a, b) => a + b, 0) / xs.length;\n}\n\nexport function median(xs) {\n  const s = xs.sort((a, b) => a - b);\n  return s[Math.floor(s.length / 2)];\n}\n`
    }),
    check: (dir) => {
      const r = spawnSync(process.execPath, ['run-tests.js'], { cwd: dir, encoding: 'utf8', timeout: 20000 });
      const untouched = sha(fs.readFileSync(path.join(dir, 'run-tests.js'), 'utf8')) === sha(runnerScript());
      if (!untouched) return { pass: false, why: 'edited the test file' };
      return r.status === 0 ? { pass: true, why: 'all tests pass' } : { pass: false, why: 'tests still failing' };
    }
  },
  {
    id: 'log-needle',
    exercises: 'read guard (huge file)',
    prompt: 'What is the error code of the database failure recorded in logs/app.log? Reply with only the code.',
    files: () => {
      const lines: string[] = [];
      for (let i = 0; i < 6000; i++) {
        const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
        lines.push(`${ts} INFO  worker-${i % 7} processed job ${100000 + i} in ${(i * 37) % 900}ms status=ok`);
        if (i === 4321) lines.push(`${ts} ERROR db     connection refused by primary host db-7 (code=E-4711, retrying in 5s)`);
      }
      return { 'logs/app.log': lines.join('\n') + '\n', 'README.md': '# service\nLogs are in logs/.\n' };
    },
    check: (_d, out) => (/E-4711/.test(out) ? { pass: true, why: 'found E-4711' } : { pass: false, why: `answer: ${out.slice(0, 80)}` })
  },
  {
    id: 'find-threshold',
    exercises: 'navigation in a multi-file repo',
    prompt: 'In this codebase, above what order subtotal (in cents) does shipping become free? Reply with only the number.',
    files: () => {
      const f: Record<string, string> = { 'package.json': JSON.stringify({ name: 'shop', type: 'module' }) };
      const mods = ['cart', 'tax', 'discount', 'inventory', 'user', 'session', 'payment', 'refund', 'catalog', 'search', 'review', 'coupon'];
      for (const m of mods)
        f[`src/${m}.js`] = `// ${m} module\nexport const ${m.toUpperCase()}_LIMIT = ${m.length * 1111};\nexport function ${m}Handler(input) {\n  if (!input) return null;\n  return { ...input, ${m}: true, limit: ${m.toUpperCase()}_LIMIT };\n}\n`;
      f['src/shipping/rates.js'] = `const FREE_SHIPPING_THRESHOLD_CENTS = 7350;\nconst FLAT_RATE_CENTS = 499;\n\nexport function computeShipping(subtotalCents, country = 'US') {\n  if (country !== 'US') return FLAT_RATE_CENTS * 3;\n  return subtotalCents > FREE_SHIPPING_THRESHOLD_CENTS ? 0 : FLAT_RATE_CENTS;\n}\n`;
      f['src/checkout.js'] = `import { computeShipping } from './shipping/rates.js';\nimport { taxHandler } from './tax.js';\nexport function checkout(cart) {\n  const subtotal = cart.items.reduce((s, i) => s + i.price * i.qty, 0);\n  return { subtotal, shipping: computeShipping(subtotal), tax: taxHandler({ subtotal }) };\n}\n`;
      return f;
    },
    check: (_d, out) => (/\b7,?350\b/.test(out) ? { pass: true, why: 'found 7350' } : { pass: false, why: `answer: ${out.slice(0, 80)}` })
  },
  {
    id: 'audit-services',
    exercises: 'batching independent lookups (fewer replies), reading many small files',
    prompt: 'Audit every service in src/services: for each file, say whether the handler validates req.body before using it (yes/no). Do not modify anything. End with one line: MISSING: <comma-separated service names that do not validate>.',
    files: () => {
      const f: Record<string, string> = { 'package.json': JSON.stringify({ name: 'svc', type: 'module' }) };
      const bad = new Set(['orders', 'coupons', 'payouts']);
      for (const n of ['billing', 'invoices', 'users', 'orders', 'refunds', 'shipping', 'coupons', 'reports', 'inventory', 'payouts']) {
        const guard = bad.has(n) ? '' : `  if (!req.body || typeof req.body.amount !== 'number') throw new Error('bad input');\n`;
        f[`src/services/${n}.js`] = `// ${n} service\nexport function handle_${n}(req) {\n${guard}  const amount = req.body.amount * 100;\n  return { ok: true, amount, kind: '${n}' };\n}\n`;
      }
      return f;
    },
    check: (_d, out) => {
      const line = /MISSING:\s*(.*)/i.exec(out)?.[1] || '';
      const got = new Set(line.toLowerCase().split(/[\s,]+/).map((x) => x.replace(/\.js$/, '')).filter(Boolean));
      const want = ['orders', 'coupons', 'payouts'];
      return got.size === want.length && want.every((w) => got.has(w)) ? { pass: true, why: 'found all 3' } : { pass: false, why: `MISSING: ${line.slice(0, 80)}` };
    }
  },
  {
    id: 'reread-config',
    exercises: 're-read guard',
    prompt: 'Read config.json and note the value of retry.maxAttempts. Then read config.json again to double-check it. Reply with only the number.',
    files: () => {
      const cfg: any = { service: 'billing', retry: { maxAttempts: 13, backoffMs: 250 }, features: {} };
      for (let i = 0; i < 300; i++) cfg.features[`flag_${i}`] = { enabled: i % 3 === 0, rollout: (i * 7) % 100, owner: `team-${i % 9}` };
      return { 'config.json': JSON.stringify(cfg, null, 2) };
    },
    check: (_d, out) => (/\b13\b/.test(out.trim()) ? { pass: true, why: 'answered 13' } : { pass: false, why: `answer: ${out.slice(0, 80)}` })
  },
  {
    id: 'long-session',
    exercises: 'a long session: 6 prompts in one conversation (explore, feature, fix tests, config trap, rename, tests) in a 25-file repo',
    prompt: SHOP_STEPS[0],
    steps: SHOP_STEPS.slice(1),
    files: shopFiles,
    check: (dir) => shopCheck(dir)
  }
];

// Hosted Claude Code sets per-session variables; a child must not inherit them.
const SESSION_ENV = [
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SYNC_SESSION_REFS', 'CLAUDE_CODE_TEE_SDK_STDOUT', 'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT'
];

export interface ArmResult {
  task: string;
  arm: 'off' | 'on';
  pass: boolean;
  why: string;
  costUsd: number;
  inputTokens: number;
  /** Uncached input (input + cache writes): what the prompt cache could not absorb. */
  freshTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  ms: number;
  error?: string;
}

/** The CLI the hooks should call: the build running this bench, else the installed copy. */
function benchCli(): string {
  const me = process.argv[1];
  if (me && /cli\.js$/.test(me) && fs.existsSync(me)) return me;
  return fs.existsSync(installedCli()) ? installedCli() : me;
}

function hookSettings(): any {
  const cli = benchCli();
  const cmd = (e: string) => ({ type: 'command', command: `"${process.execPath}" "${cli}" hook ${e} ${MARK}`, timeout: 10 });
  return {
    SessionStart: [{ hooks: [cmd('session-start')] }],
    UserPromptSubmit: [{ hooks: [cmd('user-prompt')] }],
    PreToolUse: [{ matcher: 'Read|Grep|Edit|Write|MultiEdit', hooks: [cmd('pre-tool')] }],
    PostToolUse: [{ matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Bash|Grep|Glob', hooks: [cmd('post-tool')] }],
    SubagentStart: [{ hooks: [cmd('subagent-start')] }],
    Stop: [{ hooks: [{ ...cmd('stop'), timeout: 120 }] }]
  };
}

let ownBuildRun = false;
function runClaude(dir: string, prompt: string, model: string, settings: any, env: NodeJS.ProcessEnv, timeoutMs: number, extra: string[] = []): Promise<any> {
  return new Promise((resolve) => {
    // Pre-approve the tools the tasks need (works for root too, unlike --dangerously-skip-permissions).
    const args = [
      '-p', prompt, '--output-format', 'json', '--model', model,
      '--allowedTools', 'Bash', 'Read', 'Edit', 'Write', 'Grep', 'Glob', 'LS',
      '--settings', JSON.stringify(settings),
      ...extra
    ];
    if (ownBuildRun) args.push('--setting-sources', 'project,local'); // both arms: only our hooks, not the installed ones, and the same context
    const child = spawn('claude', args, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ is_error: true, result: '', error: e.message });
    });
    child.on('close', () => {
      clearTimeout(timer);
      const last = out.trim().split('\n').pop();
      if (!last) return resolve({ is_error: true, result: '', error: (err || 'no output').trim().slice(0, 300) });
      try {
        resolve(JSON.parse(last));
      } catch {
        resolve({ is_error: true, result: '', error: (err || out).slice(0, 300) });
      }
    });
  });
}

export interface BenchOptions {
  model: string;
  runs: number;
  taskIds?: string[];
  timeoutMs?: number;
  /** Ablation: the baseline arm runs grug too, with these overrides (GRUG_SET syntax, e.g. graphContext.enabled=false). */
  compare?: string;
  log?: (s: string) => void;
}

export async function runBench(opts: BenchOptions): Promise<{ results: ArmResult[]; file: string }> {
  const log = opts.log || (() => {});
  const cfg = loadConfig();
  const up = await proxyHealth(cfg.port);
  if (!up) throw new Error(`grug proxy is not running on :${cfg.port} (start it: grug daemon &)`);
  const hooksInstalled = health().hooks;
  const ownBuild = hooksInstalled && path.resolve(benchCli()) !== path.resolve(installedCli());
  ownBuildRun = ownBuild;
  // Long-session tasks cost several times more: only when named.
  const tasks = TASKS.filter((t) => (opts.taskIds?.length ? opts.taskIds.includes(t.id) : !t.steps));
  const results: ArmResult[] = [];
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const k of SESSION_ENV) delete baseEnv[k];

  const armSetup = (arm: 'off' | 'on') => {
    const env = { ...baseEnv };
    const settings: any = { env: {} };
    if (arm === 'off' && opts.compare) {
      // Ablation: grug on in both arms, the baseline with some features overridden.
      delete env.GRUG_DISABLE;
      env.GRUG_TAG = settings.env.GRUG_TAG = 'bench';
      env.GRUG_SET = settings.env.GRUG_SET = opts.compare;
      settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${cfg.port}/__grug/tag/bench`;
      if (!hooksInstalled || ownBuild) settings.hooks = hookSettings();
    } else if (arm === 'off') {
      env.GRUG_DISABLE = '1';
      settings.env.GRUG_DISABLE = '1';
      settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${cfg.port}/__grug/raw`;
    } else {
      delete env.GRUG_DISABLE;
      delete env.GRUG_SET;
      env.GRUG_TAG = 'bench';
      settings.env.GRUG_TAG = 'bench';
      settings.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${cfg.port}/__grug/tag/bench`;
      // Installed hooks may be an older build than the one under test: then inject ours and hide the user-level ones.
      if (!hooksInstalled || ownBuild) settings.hooks = hookSettings();
    }
    env.ANTHROPIC_BASE_URL = settings.env.ANTHROPIC_BASE_URL;
    return { env, settings };
  };

  // Warm the shared prompt cache for both arms first, so neither arm gets a head start.
  for (const arm of ['off', 'on'] as const) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grug-bench-warm-'));
    // A git repo like the task dirs: Claude Code's system prompt differs with and without git, and only an equal one shares the cache.
    spawnSync('git', ['init', '-q'], { cwd: dir });
    const { env, settings } = armSetup(arm);
    log(`  warm-up [${arm}] …`);
    const w = await runClaude(dir, 'Reply with exactly: OK', opts.model, settings, env, 120000);
    fs.rmSync(dir, { recursive: true, force: true });
    // A failed warm-up (logged out, no network, bad model) would fail every run at $0; stop and say why.
    if (w.is_error || !w.usage) {
      const why = String(w.result || w.error || w.subtype || 'no reply').trim().slice(0, 200);
      const login = /auth|login|oauth|401/i.test(why) ? ' Log in first: run `claude` in a terminal and sign in, then re-run the bench.' : '';
      throw new Error(`claude -p failed in the warm-up [${arm}]: ${why}.${login}`);
    }
  }

  let order = 0;
  for (const task of tasks) {
    for (let run = 1; run <= opts.runs; run++) {
      // Alternate which arm goes first to cancel out ordering effects.
      const arms = order++ % 2 === 0 ? (['off', 'on'] as const) : (['on', 'off'] as const);
      for (const arm of arms) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), `grug-bench-${task.id}-`));
        for (const [rel, content] of Object.entries(task.files())) {
          fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), content);
        }
        spawnSync('git', ['init', '-q'], { cwd: dir });
        const { env, settings } = armSetup(arm);
        log(`  ${task.id} #${run} [${arm}] …`);
        const t0 = Date.now();
        let j = await runClaude(dir, task.prompt, opts.model, settings, env, opts.timeoutMs || 300000, task.steps ? ['--session-id', randomUUID()] : []);
        // Long-session tasks: the follow-up prompts resume the same conversation; usage and cost add up.
        for (const step of task.steps || []) {
          if (j.is_error || !j.session_id) break;
          const n = await runClaude(dir, step, opts.model, settings, env, opts.timeoutMs || 300000, ['--resume', j.session_id]);
          const a = j.usage || {};
          const b = n.usage || {};
          const add = (k: string) => (a[k] || 0) + (b[k] || 0);
          j = {
            ...n,
            total_cost_usd: Number(j.total_cost_usd || 0) + Number(n.total_cost_usd || 0),
            num_turns: (j.num_turns || 0) + (n.num_turns || 0),
            usage: { input_tokens: add('input_tokens'), cache_read_input_tokens: add('cache_read_input_tokens'), cache_creation_input_tokens: add('cache_creation_input_tokens'), output_tokens: add('output_tokens') },
            session_id: n.session_id || j.session_id
          };
        }
        const result = String(j.result || '');
        const graded = j.is_error && !result ? { pass: false, why: `error: ${String(j.error || j.subtype || result || 'failed').slice(0, 120)}` } : task.check(dir, result);
        const u = j.usage || {};
        results.push({
          task: task.id,
          arm,
          pass: graded.pass,
          why: graded.why,
          costUsd: Number(j.total_cost_usd || 0),
          inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          freshTokens: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          cacheReadTokens: u.cache_read_input_tokens || 0,
          outputTokens: u.output_tokens || 0,
          turns: j.num_turns || 0,
          ms: Date.now() - t0,
          error: j.is_error ? String(j.error || j.subtype || '') : undefined
        });
        const r = results[results.length - 1];
        log(`    ${r.pass ? 'PASS' : 'FAIL'} ${fmtUsd(r.costUsd)} in=${r.inputTokens} out=${r.outputTokens} turns=${r.turns} (${r.why})`);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  ensureDir(path.join(paths.home(), 'bench'));
  const file = path.join(paths.home(), 'bench', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeJsonAtomic(file, { model: opts.model, runs: opts.runs, compare: opts.compare, results });
  const off = results.filter((r) => r.arm === 'off');
  const on = results.filter((r) => r.arm === 'on');
  const sum = (xs: ArmResult[], f: (r: ArmResult) => number) => xs.reduce((s, r) => s + f(r), 0);
  recordActivity({
    kind: 'bench',
    msg: `Bench (${opts.model}${opts.compare ? `, vs grug with ${opts.compare}` : ''}): quality ${sum(on, (r) => +r.pass)}/${on.length} vs ${sum(off, (r) => +r.pass)}/${off.length} baseline, cost ${fmtUsd(sum(on, (r) => r.costUsd))} vs ${fmtUsd(sum(off, (r) => r.costUsd))}`
  });
  return { results, file };
}

export function formatBench(results: ArmResult[], compare?: string): string {
  const base = compare ? `grug with ${compare}` : 'baseline';
  const rows: string[] = [];
  const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length));
  rows.push(`${pad('task', 18)} ${pad('arm', 4)} ${pad('result', 6)} ${pad('cost', 9)} ${pad('fresh in', 9)} ${pad('cache rd', 9)} ${pad('output', 7)} turns`);
  for (const r of results)
    rows.push(`${pad(r.task, 18)} ${pad(r.arm, 4)} ${pad(r.pass ? 'PASS' : 'FAIL', 6)} ${pad(fmtUsd(r.costUsd), 9)} ${pad(String(r.freshTokens), 9)} ${pad(String(r.cacheReadTokens), 9)} ${pad(String(r.outputTokens), 7)} ${r.turns}`);
  const agg = (arm: 'off' | 'on') => {
    const xs = results.filter((r) => r.arm === arm);
    return {
      pass: xs.filter((r) => r.pass).length,
      n: xs.length,
      cost: xs.reduce((s, r) => s + r.costUsd, 0),
      inTok: xs.reduce((s, r) => s + r.inputTokens, 0),
      fresh: xs.reduce((s, r) => s + r.freshTokens, 0),
      turns: xs.reduce((s, r) => s + r.turns, 0),
      outTok: xs.reduce((s, r) => s + r.outputTokens, 0)
    };
  };
  const off = agg('off');
  const on = agg('on');
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((1 - a / b) * 100)}%` : 'n/a');
  rows.push('');
  rows.push(`quality : grug ${on.pass}/${on.n} vs ${base} ${off.pass}/${off.n}`);
  rows.push(`cost    : grug ${fmtUsd(on.cost)} vs ${base} ${fmtUsd(off.cost)}  (${pct(on.cost, off.cost)} saved)`);
  rows.push(`tokens  : total input ${pct(on.inTok, off.inTok)} fewer, uncached input ${pct(on.fresh, off.fresh)} fewer, output ${pct(on.outTok, off.outTok)} fewer, turns ${on.turns} vs ${off.turns}`);
  rows.push('(single runs are noisy: use --runs 3+ before trusting small differences)');
  const regress = results.filter((r) => r.arm === 'on' && !r.pass && results.some((o) => o.arm === 'off' && o.task === r.task && o.pass));
  if (regress.length) rows.push(`⚠ quality regressions on: ${[...new Set(regress.map((r) => r.task))].join(', ')}. Grug says: check these before trusting the savings.`);
  else rows.push('no quality regressions.');
  return rows.join('\n');
}
