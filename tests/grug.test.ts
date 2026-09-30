import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import { skeletonize } from '../src/compress/skeleton.js';
import { trimToolOutput, looksLikeFileRead } from '../src/compress/trim.js';
import { cavemanCompress, terseStyle } from '../src/compress/caveman.js';
import { repoMap } from '../src/compress/repomap.js';
import { transformRequest } from '../src/proxy/transform.js';
import { startProxy } from '../src/proxy/server.js';
import { defaultConfig, paths, userHome } from '../src/config.js';
import {
  addNote, appendBuffer, consolidate, ingestSession, loadMemory, MemoryDB, projectKey, readBuffer
} from '../src/memory/store.js';
import { buildBrief, recall } from '../src/memory/brief.js';
import { exportVault } from '../src/memory/vault.js';
import { renderGraphHtml } from '../src/memory/graphhtml.js';
import { findSymbol, handleMessage } from '../src/mcp.js';
import { installClaudeCode, installDesktop, uninstall, MARK } from '../src/install.js';
import { readActivity, readRequests, summarize } from '../src/stats.js';
import { runHook } from '../src/hooks.js';
import { costOf } from '../src/tokens.js';
import { projectTranscriptDir } from '../src/history.js';

const ORIGINAL = { HOME: process.env.HOME, GRUG_HOME: process.env.GRUG_HOME, PATH: process.env.PATH, BASE: process.env.ANTHROPIC_BASE_URL };
let tmp = '';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grug-test-'));
  process.env.HOME = tmp;
  process.env.GRUG_HOME = path.join(tmp, '.grug');
  process.env.PATH = '/usr/bin:/bin'; // keep the real `claude` CLI out of reach
  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.CLAUDE_CONFIG_DIR;
  // Hard stop if isolation ever breaks: never touch a real home directory.
  if (userHome() !== tmp || !paths.home().startsWith(tmp)) throw new Error('test HOME isolation failed');
});

afterAll(() => {
  process.env.HOME = ORIGINAL.HOME;
  process.env.PATH = ORIGINAL.PATH;
  if (ORIGINAL.GRUG_HOME === undefined) delete process.env.GRUG_HOME;
  else process.env.GRUG_HOME = ORIGINAL.GRUG_HOME;
  if (ORIGINAL.BASE !== undefined) process.env.ANTHROPIC_BASE_URL = ORIGINAL.BASE;
});

const DAY = 86400000;
const trimOpts = { thresholdChars: 2000, keepHeadChars: 500, keepTailChars: 300 };

describe('skeletonizer', () => {
  it('stubs nested bodies without leaving dangling code', () => {
    const code = `export function f(x: number) {\n  if (x) {\n    return \`\${ {a:1}.a } }\`;\n  }\n  return 3;\n}\nexport class A {\n  m(): void { if (1) { go(); } }\n}\n`;
    const r = skeletonize(code, 'a.ts');
    expect(r.skeleton).toContain('export function f(x: number) {');
    expect(r.skeleton).not.toContain('return 3');
    expect(r.skeleton).toContain('m(): void { /* … */ }');
    expect(r.skeleton.match(/\{/g)?.length).toBe(r.skeleton.match(/\}/g)?.length);
  });

  it('keeps interfaces/types and python docstrings', () => {
    expect(skeletonize('interface I { a: string; b(): void }', 'i.ts').skeleton).toContain('b(): void');
    const py = skeletonize('class A:\n    def f(self):\n        """Doc."""\n        return 1\n', 'a.py').skeleton;
    expect(py).toContain('def f(self):');
    expect(py).toContain('"""Doc."""');
    expect(py).not.toContain('return 1');
  });

  it('handles go and rust', () => {
    expect(skeletonize('func (s *S) Do() error {\n  return nil\n}\n', 'a.go').skeleton).not.toContain('return nil');
    const rs = skeletonize('impl A {\n    pub fn new() -> Self { Self { x: 1 } }\n}', 'a.rs').skeleton;
    expect(rs).toContain('pub fn new() -> Self { /* … */ }');
  });
});

describe('wantsContent', () => {
  it('separates content commands from noisy runs', async () => {
    const { wantsContent } = await import('../src/hooks.js');
    for (const c of ['sed -n 1,200p src/a.ts', 'cat src/x.ts && ls', 'git show abc --stat', 'grep -rn foo src | head', 'cd x && git diff']) expect(wantsContent(c)).toBe(true);
    for (const c of ['npm test', 'npm ci && npm run build', 'pip install -r requirements.txt', 'docker build .']) expect(wantsContent(c)).toBe(false);
  });
});

describe('trimmer', () => {
  const noisy = '\u001b[31mred\u001b[0m\n' + 'dup\n'.repeat(20) + Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n');

  it('strips ansi, collapses duplicates, keeps head and tail', () => {
    const r = trimToolOutput(noisy, trimOpts);
    expect(r.text).not.toContain('\u001b[');
    expect(r.text).toContain('dup  [×20]');
    expect(r.text).toContain('line 0');
    expect(r.text).toContain('line 399');
    expect(r.text).toContain('[grug:');
    expect(r.text.length).toBeLessThan(noisy.length);
  });

  it('is deterministic and leaves file reads alone', () => {
    expect(trimToolOutput(noisy, trimOpts).text).toBe(trimToolOutput(noisy, trimOpts).text);
    const read = Array.from({ length: 500 }, (_, i) => `${i + 1}\tconst x${i} = ${i};`).join('\n');
    expect(looksLikeFileRead(read)).toBe(true);
    expect(trimToolOutput(read, trimOpts).changed).toBe(false);
  });

  it('keeps problem lines from the cut part and points at the saved original', () => {
    const body = Array.from({ length: 600 }, (_, i) => (i === 300 ? 'FATAL: database connection refused' : `ok step ${i}`)).join('\n');
    let saved = '';
    const r = trimToolOutput(body, { ...trimOpts, saveFull: (full) => ((saved = full), '/tmp/full.txt') });
    expect(r.text).toContain('FATAL: database connection refused');
    expect(r.text).toContain('/tmp/full.txt');
    expect(saved).toBe(body);
    expect(r.text).not.toContain('ok step 300');
  });
});

describe('caveman', () => {
  it('strips pleasantries but never code, paths, urls or quotes', () => {
    const r = cavemanCompress('Could you please fix `could you please` in ./src/a.ts, see https://x.dev/please and "please keep". Thanks in advance!');
    expect(r.text).toContain('`could you please`');
    expect(r.text).toContain('./src/a.ts');
    expect(r.text).toContain('https://x.dev/please');
    expect(r.text).toContain('"please keep"');
    expect(r.text.startsWith('Fix')).toBe(true);
    expect(r.text).not.toMatch(/thanks/i);
  });

  it('has terse output styles', () => {
    expect(terseStyle('off')).toBe('');
    expect(terseStyle('full')).toMatch(/caveman/);
  });
});

describe('proxy transform', () => {
  const bigSystem = 'rule '.repeat(2000);
  const body = () => ({
    model: 'claude-opus-5-5',
    system: bigSystem,
    tools: [{ name: 't', description: 'x', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 's' }, { type: 'tool_use', id: '1', name: 'Bash', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: '1', content: 'x\n'.repeat(3000) + 'y'.repeat(30000) }] }
    ]
  });

  it('adds at most 4 breakpoints and never touches assistant turns', () => {
    const b = body();
    const before = JSON.stringify(b.messages[1]);
    const r = transformRequest(b, { autoCache: true, trimToolResults: true, dedupeReads: true, trim: trimOpts });
    const count = (JSON.stringify(b).match(/cache_control/g) || []).length;
    expect(r.breakpointsAdded).toBe(3);
    expect(count).toBeLessThanOrEqual(4);
    expect(JSON.stringify(b.messages[1])).toBe(before);
    expect(r.trimmedResults).toBe(1);
  });

  it('is deterministic (stable cache prefix across turns)', () => {
    const a = body();
    const b = body();
    const o = { autoCache: true, trimToolResults: true, dedupeReads: true, trim: trimOpts };
    transformRequest(a, o);
    transformRequest(b, o);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('leaves client-managed caching alone', () => {
    const b: any = body();
    b.system = [{ type: 'text', text: bigSystem, cache_control: { type: 'ephemeral' } }];
    const r = transformRequest(b, { autoCache: true, trimToolResults: false, dedupeReads: false, trim: trimOpts });
    expect(r.breakpointsAdded).toBe(0);
  });

  it('dedupes identical later tool results', () => {
    const same = 'z'.repeat(3000);
    const b: any = {
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: same }] },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: same }] }
      ]
    };
    const r = transformRequest(b, { autoCache: false, trimToolResults: false, dedupeReads: true, trim: trimOpts });
    expect(r.dedupedResults).toBe(1);
    expect(b.messages[0].content[0].content).toBe(same);
    expect(b.messages[2].content[0].content).toContain('identical to an earlier tool result');
  });
});

describe('proxy server', () => {
  it('streams SSE through, records real usage, and falls back on 400', async () => {
    const seen: any[] = [];
    const upstream = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        const j = JSON.parse(b);
        seen.push({ auth: req.headers.authorization, body: j });
        if (j.reject && JSON.stringify(j).includes('cache_control')) {
          res.writeHead(400, { 'content-type': 'application/json' });
          return res.end('{"type":"error"}');
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":10,"cache_read_input_tokens":1000}}}\n\n');
        res.end('data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const up = upstream.address() as any;
    const cfg = defaultConfig();
    cfg.upstream = `http://127.0.0.1:${up.port}`;
    const proxy = await startProxy(cfg, 0);
    const post = (payload: any) =>
      new Promise<string>((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: proxy.port, path: '/v1/messages', method: 'POST', headers: { authorization: 'Bearer tok', 'content-type': 'application/json' } },
          (res) => {
            let t = '';
            res.on('data', (c) => (t += c));
            res.on('end', () => resolve(t));
          }
        );
        req.end(JSON.stringify(payload));
      });
    const msgs = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
    const out = await post({ model: 'claude-opus-5-5', stream: true, system: 'x '.repeat(3000), messages: msgs });
    expect(out).toContain('message_delta');
    expect(seen[0].auth).toBe('Bearer tok');
    await post({ model: 'm', reject: true, system: 'x '.repeat(3000), messages: msgs });
    expect(seen).toHaveLength(3);
    expect(JSON.stringify(seen[2].body)).not.toContain('cache_control');
    await new Promise((r) => setTimeout(r, 50));
    const reqs = readRequests();
    expect(reqs[0].usage.output_tokens).toBe(7);
    expect(reqs[0].usage.cache_read_input_tokens).toBe(1000);
    expect(summarize().cacheSavedUsd).toBeGreaterThan(0);
    await proxy.close();
    upstream.close();
  });
});

describe('memory', () => {
  const cwd = '/work/app';
  function seedSession(id: string, ts: number, prompt = 'fix login bug in auth module') {
    appendBuffer(id, { t: 'start', ts, cwd });
    appendBuffer(id, { t: 'prompt', ts, text: prompt });
    appendBuffer(id, { t: 'file', ts, path: `${cwd}/src/auth.ts`, op: 'edit' });
    appendBuffer(id, { t: 'assistant', ts, text: 'Done. The root cause was a stale session cookie, fixed by rotating it on login.' });
  }

  it('ingest is idempotent', () => {
    seedSession('s1', Date.now());
    const db = loadMemory();
    ingestSession(db, 's1');
    const snap = JSON.stringify(Object.values(db.nodes).map((n) => [n.id, n.touches]));
    ingestSession(db, 's1');
    expect(JSON.stringify(Object.values(db.nodes).map((n) => [n.id, n.touches]))).toBe(snap);
    expect(Object.values(db.nodes).some((n) => n.type === 'note' && /root cause/.test(n.label))).toBe(true);
  });

  it('folds old sessions into digests and deletes their buffers (no pile-up)', () => {
    const db: MemoryDB = { version: 1, nodes: {}, edges: {} };
    const old = Date.now() - 40 * DAY;
    for (let i = 0; i < 30; i++) {
      seedSession(`old${i}`, old + i * 1000, `task number ${i} on payments`);
      ingestSession(db, `old${i}`);
    }
    const rep = consolidate(db, defaultConfig().memory);
    expect(rep.folded).toBe(30);
    expect(Object.values(db.nodes).filter((n) => n.type === 'session')).toHaveLength(0);
    expect(Object.values(db.nodes).filter((n) => n.type === 'digest').length).toBeGreaterThan(0);
    expect(readBuffer('old0')).toHaveLength(0);
  });

  it('caps nodes per project and merges similar notes', () => {
    const db: MemoryDB = { version: 1, nodes: {}, edges: {} };
    const p = projectKey(cwd);
    addNote(db, p, 'Always run the migrations before starting the dev server');
    addNote(db, p, 'always run the migrations before starting the dev server!');
    expect(Object.values(db.nodes).filter((n) => n.type === 'note')).toHaveLength(1);
    const cfg = { ...defaultConfig().memory, maxNodesPerProject: 20 };
    for (let i = 0; i < 60; i++) {
      const id = `file:${p}:f${i}.ts`;
      db.nodes[id] = { id, type: 'file', label: `f${i}.ts`, project: p, created: Date.now() - 5 * DAY, updated: Date.now() - 5 * DAY, weight: 1, touches: 0 };
    }
    consolidate(db, cfg);
    expect(Object.values(db.nodes).filter((n) => n.project === p).length).toBeLessThanOrEqual(20);
  });

  it('brief stays within budget however much history exists', () => {
    const db: MemoryDB = { version: 1, nodes: {}, edges: {} };
    const p = projectKey(cwd);
    for (let i = 0; i < 200; i++) addNote(db, p, `Decision ${i}: use approach ${i} because constraint ${i * 7} matters here`);
    for (let i = 0; i < 5; i++) {
      seedSession(`b${i}`, Date.now() - i * 1000);
      ingestSession(db, `b${i}`);
    }
    const b = buildBrief(db, p, 300, 14);
    expect(b.tokens).toBeLessThanOrEqual(300);
    expect(b.text).toContain('Last session');
    const r = recall(db, p, 'why did we rotate the session cookie on login', 150, 14);
    expect(r.tokens).toBeLessThanOrEqual(150);
  });

  it('exports an Obsidian vault and a graph without deleting user notes', () => {
    seedSession('v1', Date.now());
    const db = loadMemory();
    ingestSession(db, 'v1');
    const vault = path.join(tmp, 'MyVault');
    fs.mkdirSync(path.join(vault, 'grugbrain'), { recursive: true });
    fs.writeFileSync(path.join(vault, 'grugbrain', 'mine.md'), '# my own note');
    const r = exportVault(db, vault, 14);
    expect(r.written).toBeGreaterThan(3);
    exportVault({ version: 1, nodes: {}, edges: {} }, vault, 14);
    expect(fs.existsSync(path.join(vault, 'grugbrain', 'mine.md'))).toBe(true);
    const html = renderGraphHtml(db, 14);
    expect(html).toContain('<canvas');
    expect(html).not.toContain('<script src');
  });
});

describe('hooks', () => {
  it('captures a session and injects a brief next time', async () => {
    const cwd = path.join(tmp, 'proj');
    fs.mkdirSync(cwd);
    const tp = path.join(tmp, 't.jsonl');
    fs.writeFileSync(tp, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Fixed. Important: the API key lives in .env.local, never commit it.' }] } }) + '\n');
    await runHook('session-start', { session_id: 'h1', cwd });
    await runHook('user-prompt', { session_id: 'h1', cwd, prompt: 'set up the stripe webhook handler' });
    await runHook('post-tool', { session_id: 'h1', cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'webhook.ts') } });
    await runHook('stop', { session_id: 'h1', cwd, transcript_path: tp });
    const db = loadMemory();
    ingestSession(db, 'h1');
    fs.writeFileSync(paths.memory(), JSON.stringify(db));
    const out: any = await runHook('session-start', { session_id: 'h2', cwd });
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('stripe webhook');
    expect(ctx).toContain('webhook.ts');
  });

  it('read guard denies huge full reads but allows ranged reads', async () => {
    const f = path.join(tmp, 'huge.log');
    fs.writeFileSync(f, 'x'.repeat(200000));
    const deny: any = await runHook('pre-tool', { tool_name: 'Read', tool_input: { file_path: f } });
    expect(deny.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(await runHook('pre-tool', { tool_name: 'Read', tool_input: { file_path: f, limit: 100 } })).toBeNull();
  });
});

describe('mcp', () => {
  it('follows JSON-RPC rules', () => {
    expect(handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeNull();
    expect(handleMessage({ jsonrpc: '2.0', id: 1, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(handleMessage({ jsonrpc: '2.0', id: 2, method: 'nope' }).error.code).toBe(-32601);
    const init = handleMessage({ jsonrpc: '2.0', id: 3, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect(init.result.protocolVersion).toBe('2025-06-18');
    expect(init.result.instructions).toMatch(/outline/);
    const err = handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'outline', arguments: { path: '/definitely/missing' } } });
    expect(err.result.isError).toBe(true);
  });

  it('read_symbol finds a whole function', () => {
    const code = 'const a = 1;\n/** doc */\nexport async function target(x: number): Promise<number> {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\nfunction other() {}\n';
    const hit = findSymbol(code, 'a.ts', 'target')!;
    expect(hit.text).toContain('/** doc */');
    expect(hit.text).toContain('return 2;');
    expect(hit.text).not.toContain('other');
  });
});

describe('repo map', () => {
  it('respects .gitignore, hides secrets, stays under budget', () => {
    const root = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'gen'), { recursive: true });
    fs.writeFileSync(path.join(root, '.gitignore'), 'gen/\n');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(root, 'gen', 'out.ts'), 'export const x = 1;');
    fs.writeFileSync(path.join(root, 'src', 'util.ts'), 'export function helper() {}');
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(root, 'src', `m${i}.ts`), `import { helper } from './util';\nexport function f${i}() {}`);
    const m = repoMap(root, 400);
    expect(m.text).not.toContain('out.ts');
    expect(m.text).not.toContain('.env');
    expect(m.text).toContain('util.ts');
    expect(m.tokens).toBeLessThanOrEqual(420);
  });
});

describe('installer safety', () => {
  beforeEach(async () => {
    const { claudeCodeSettingsPath, claudeDesktopConfigPath, claudeCodeUserConfigPath } = await import('../src/install.js');
    for (const p of [claudeCodeSettingsPath(), claudeDesktopConfigPath(), claudeCodeUserConfigPath()]) {
      if (!p.startsWith(tmp)) throw new Error(`installer path escaped the sandbox: ${p}`);
    }
  });

  it('merges hooks idempotently, keeps user settings, and uninstalls cleanly', () => {
    const settings = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = { permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] } };
    fs.writeFileSync(settings, JSON.stringify(original));
    installClaudeCode(true);
    installClaudeCode(true);
    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(after.permissions).toEqual(original.permissions);
    expect(JSON.stringify(after.hooks).split(MARK).length - 1).toBe(7);
    expect(after.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:4747');
    uninstall();
    expect(JSON.parse(fs.readFileSync(settings, 'utf8'))).toEqual(original);
  });

  it('never overwrites a config it cannot parse', () => {
    const settings = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{ nope');
    const steps = installClaudeCode(true);
    expect(steps[0].ok).toBe(false);
    expect(fs.readFileSync(settings, 'utf8')).toBe('{ nope');
  });

  it('chains an existing custom ANTHROPIC_BASE_URL and restores it on uninstall', () => {
    const settings = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.corp' } }));
    installClaudeCode(true);
    expect(JSON.parse(fs.readFileSync(paths.config(), 'utf8')).upstream).toBe('https://gateway.corp');
    uninstall();
    expect(JSON.parse(fs.readFileSync(settings, 'utf8')).env.ANTHROPIC_BASE_URL).toBe('https://gateway.corp');
  });

  it('replaces legacy Desktop entries with absolute paths', () => {
    const desk = process.platform === 'darwin'
      ? path.join(tmp, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
      : path.join(tmp, '.config', 'Claude', 'claude_desktop_config.json');
    fs.mkdirSync(path.dirname(desk), { recursive: true });
    fs.writeFileSync(desk, JSON.stringify({ mcpServers: { 'token-diet': { command: 'npx' }, other: { command: 'x' } } }));
    expect(installDesktop().ok).toBe(true);
    const j = JSON.parse(fs.readFileSync(desk, 'utf8'));
    expect(j.mcpServers['token-diet']).toBeUndefined();
    expect(j.mcpServers.other).toEqual({ command: 'x' });
    expect(path.isAbsolute(j.mcpServers.grugbrain.command)).toBe(true);
  });
});

describe('pricing', () => {
  it('prices cache reads at 0.1x', () => {
    expect(costOf('claude-opus-5-5', { cache_read_input_tokens: 1_000_000 })).toBeCloseTo(0.4);
    expect(costOf('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 })).toBeCloseTo(12);
  });
});

// ---------------------------------------------------------------- v2.1 features
import { summarizeTestOutput } from '../src/compress/testsum.js';
import { CacheWatch } from '../src/proxy/cachewatch.js';
import { compareVersions } from '../src/update.js';
import * as zlib from 'node:zlib';

describe('test output summarizer', () => {
  it('keeps vitest failures with diff + code frame, drops passing lines', () => {
    const pass = Array.from({ length: 300 }, (_, i) => ` ✓ a.test.js > adds case ${i}`).join('\n');
    const out = `${pass}\n × a.test.js > median of even list\n   → expected 3 to be 2.5\n\n⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯\n\n FAIL  a.test.js > median of even list\nAssertionError: expected 3 to be 2.5\n\n- Expected\n+ Received\n\n- 2.5\n+ 3\n\n ❯ a.test.js:3:109\n      3| test('median', () => {\n\n⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n\n Test Files  1 failed (1)\n      Tests  1 failed | 300 passed (301)\n`;
    const r = summarizeTestOutput(out);
    expect(r.framework).toBe('vitest');
    expect(r.text).toContain('AssertionError: expected 3 to be 2.5');
    expect(r.text).toContain('+ 3');
    expect(r.text).toContain('❯ a.test.js:3:109');
    expect(r.text).toContain('Tests  1 failed | 300 passed');
    expect(r.text).not.toContain('adds case 150');
    expect(r.text.length).toBeLessThan(out.length / 4);
  });

  it('handles pytest and go test', () => {
    const py = Array.from({ length: 200 }, (_, i) => `tests/test_m.py::test_ok_${i} PASSED`).join('\n') +
      `\n=================================== FAILURES ===================================\n___________________________ test_divide ___________________________\n\n    def test_divide():\n>       assert divide(1, 0) == 0\nE       ZeroDivisionError: division by zero\n\ntests/test_m.py:12: ZeroDivisionError\n=========================== short test summary info ============================\nFAILED tests/test_m.py::test_divide - ZeroDivisionError\n========================= 1 failed, 200 passed in 0.41s =========================\n`;
    const p = summarizeTestOutput(py);
    expect(p.framework).toBe('pytest');
    expect(p.text).toContain('ZeroDivisionError: division by zero');
    expect(p.text).toContain('1 failed, 200 passed');
    expect(p.text).not.toContain('test_ok_100 PASSED');

    const go = Array.from({ length: 200 }, (_, i) => `=== RUN   TestOk${i}\n--- PASS: TestOk${i} (0.00s)`).join('\n') +
      `\n=== RUN   TestParse\n    parse_test.go:22: got "a", want "b"\n--- FAIL: TestParse (0.00s)\nFAIL\nFAIL\texample.com/p\t0.012s\n`;
    const g = summarizeTestOutput(go);
    expect(g.framework).toBe('go');
    expect(g.text).toContain('parse_test.go:22: got "a", want "b"');
    expect(g.text).toContain('--- FAIL: TestParse');
  });

  it('caps huge tsc error lists with a per-file count', () => {
    const tsc = Array.from({ length: 120 }, (_, i) => `src/f${i % 4}.ts(${i + 1},5): error TS2322: Type 'string' is not assignable to type 'number'.`).join('\n') + '\nFound 120 errors.';
    const r = summarizeTestOutput(tsc, 100);
    expect(r.framework).toBe('tsc');
    expect(r.text).toContain('showing first 30 of 120');
    expect(r.text).toContain('Found 120 errors.');
  });

  it('never touches unrecognized output', () => {
    const logs = Array.from({ length: 500 }, (_, i) => `INFO request ${i} ok`).join('\n');
    expect(summarizeTestOutput(logs).changed).toBe(false);
  });
});

describe('re-read guard', () => {
  it('skips an unchanged re-read once, allows the repeat, resets on edit', async () => {
    const f = path.join(tmp, 'cfg.json');
    fs.writeFileSync(f, '{"a":1}');
    const cwd = tmp;
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(paths.config(), JSON.stringify({ rereadGuard: { enabled: true } }));
    const read = { session_id: 'rr', cwd, tool_name: 'Read', tool_input: { file_path: f } };
    expect(await runHook('pre-tool', read)).toBeNull();
    await runHook('post-tool', read);
    const denied: any = await runHook('pre-tool', read);
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(/unchanged/);
    expect(await runHook('pre-tool', read)).toBeNull(); // repeat is allowed
    await runHook('post-tool', read);
    await runHook('post-tool', { session_id: 'rr', cwd, tool_name: 'Edit', tool_input: { file_path: f } });
    expect(await runHook('pre-tool', read)).toBeNull(); // edited since -> read allowed
  });

  it('does nothing when GRUG_DISABLE=1', async () => {
    process.env.GRUG_DISABLE = '1';
    const f = path.join(tmp, 'huge.txt');
    fs.writeFileSync(f, 'x'.repeat(300000));
    expect(await runHook('pre-tool', { tool_name: 'Read', tool_input: { file_path: f } })).toBeNull();
    delete process.env.GRUG_DISABLE;
  });

  it('summarizes Bash test output at the source', async () => {
    const pass = Array.from({ length: 400 }, (_, i) => ` ✓ case ${i}`).join('\n');
    const out: any = await runHook('post-tool', {
      session_id: 'b', cwd: tmp, tool_name: 'Bash', tool_input: { command: 'npm test' },
      tool_response: { stdout: `${pass}\n × broken\nError: boom\n\n Test Files  1 failed (1)\n      Tests  1 failed | 400 passed (401)\n`, stderr: '' }
    });
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).toContain('Error: boom');
    expect(out.hookSpecificOutput.updatedToolOutput.stdout).not.toContain('case 200');
  });
});

describe('cache-miss detective', () => {
  const base = () => ({
    model: 'claude-opus-5-5',
    system: [{ type: 'text', text: 'You are helpful. Current time: 10:01:02. Rules follow.' }],
    tools: [{ name: 'Read' }, { name: 'Bash' }],
    messages: [{ role: 'user', content: 'hello there' }]
  });
  const miss = { cache_creation_input_tokens: 30000, cache_read_input_tokens: 0 };

  it('ignores the first request and healthy follow-ups', () => {
    const w = new CacheWatch();
    expect(w.observe(base(), miss)).toBeNull();
    expect(w.observe(base(), { cache_creation_input_tokens: 500, cache_read_input_tokens: 30000 })).toBeNull();
  });

  it('names a changing timestamp in the system prompt', () => {
    const w = new CacheWatch();
    w.observe(base(), miss);
    const b = base();
    b.system[0].text = 'You are helpful. Current time: 10:07:44. Rules follow.';
    const r = w.observe(b, miss)!;
    expect(r.culprit).toBe('system-changed');
    expect(r.detail).toMatch(/timestamp/);
    expect(r.wastedUsd).toBeGreaterThan(0);
  });

  it('detects tool list and model changes', () => {
    const w = new CacheWatch();
    w.observe(base(), miss);
    const b: any = base();
    b.tools.push({ name: 'WebFetch' });
    expect(w.observe(b, miss)!.detail).toContain('+WebFetch');
    const c: any = { ...b, model: 'claude-sonnet-5-5' };
    expect(w.observe(c, miss)!.culprit).toBe('model-switch');
  });
});

describe('proxy routes', () => {
  it('decodes gzip bodies and passes /__grug/raw through untouched', async () => {
    const seen: any[] = [];
    const upstream = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ url: req.url, enc: req.headers['content-encoding'], body: Buffer.concat(chunks) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"model":"m","usage":{"input_tokens":1,"output_tokens":1}}');
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const cfg = defaultConfig();
    cfg.upstream = `http://127.0.0.1:${(upstream.address() as any).port}`;
    const proxy = await startProxy(cfg, 0);
    const bodyObj = {
      model: 'm', system: 'x '.repeat(3000),
      messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }]
    };
    const send = (p: string, gz: boolean) =>
      new Promise<void>((resolve) => {
        const raw = Buffer.from(JSON.stringify(bodyObj));
        const payload = gz ? zlib.gzipSync(raw) : raw;
        const req = http.request({ host: '127.0.0.1', port: proxy.port, path: p, method: 'POST', headers: { 'content-type': 'application/json', ...(gz ? { 'content-encoding': 'gzip' } : {}) } }, (res) => {
          res.resume();
          res.on('end', () => resolve());
        });
        req.end(payload);
      });
    await send('/v1/messages', true);
    expect(seen[0].enc).toBeUndefined(); // transformed -> re-sent as plain JSON
    expect(JSON.parse(seen[0].body.toString()).system[0].cache_control).toEqual({ type: 'ephemeral' });
    await send('/__grug/raw/v1/messages', true);
    expect(seen[1].url).toBe('/v1/messages');
    expect(seen[1].enc).toBe('gzip'); // untouched bytes
    expect(zlib.gunzipSync(seen[1].body).toString()).toBe(JSON.stringify(bodyObj));
    await new Promise((r) => setTimeout(r, 50));
    expect(readRequests().find((r) => r.tag === 'raw')).toBeTruthy();
    expect(summarize().requests).toBe(1); // tagged traffic excluded
    await proxy.close();
    upstream.close();
  });
});

describe('versions', () => {
  it('compares semver-ish tags', () => {
    expect(compareVersions('2.1.0', '2.0.9')).toBeGreaterThan(0);
    expect(compareVersions('v2.1.0', '2.1.0')).toBe(0);
    expect(compareVersions('2.1.0', '2.10.0')).toBeLessThan(0);
  });
});

describe('grug command on PATH', () => {
  it('links into a writable PATH dir and removes it on uninstall', async () => {
    const { installCommand, commandStatus } = await import('../src/install.js');
    const local = path.join(tmp, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    process.env.PATH = `${local}:/usr/bin:/bin`;
    const step = installCommand();
    expect(step.ok).toBe(true);
    expect(fs.lstatSync(path.join(local, 'grug')).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(paths.home(), 'bin', 'grug'), 'utf8')).toContain('cli.js" "$@"');
    expect(commandStatus()).toBe('on-path');
    uninstall();
    expect(fs.existsSync(path.join(local, 'grug'))).toBe(false);
  });

  it('falls back to a marked line in the shell rc file, never overwriting foreign files', async () => {
    const { installCommand, commandStatus } = await import('../src/install.js');
    process.env.SHELL = '/bin/zsh';
    fs.writeFileSync(path.join(tmp, '.zshrc'), 'alias ll="ls -l"\n');
    const step = installCommand();
    expect(step.ok).toBe(true);
    const rc = fs.readFileSync(path.join(tmp, '.zshrc'), 'utf8');
    expect(rc).toContain('alias ll="ls -l"');
    expect(rc).toContain('.grug/bin:$PATH" # added by grugbrain');
    installCommand(); // idempotent
    expect(fs.readFileSync(path.join(tmp, '.zshrc'), 'utf8').split('added by grugbrain').length).toBe(2);
    expect(commandStatus()).toBe('rc');
    uninstall();
    expect(fs.readFileSync(path.join(tmp, '.zshrc'), 'utf8')).toBe('alias ll="ls -l"\n');
  });
});

describe('grug command under npx', () => {
  it('ignores npx temporary .bin folders and links a real command', async () => {
    const { installCommand, commandStatus } = await import('../src/install.js');
    const npxBin = path.join(tmp, '.npm', '_npx', 'abc123', 'node_modules', '.bin');
    const pkg = path.join(tmp, '.npm', '_npx', 'abc123', 'node_modules', 'grugbrain', 'dist');
    fs.mkdirSync(npxBin, { recursive: true });
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'cli.js'), '#!/usr/bin/env node\n');
    fs.chmodSync(path.join(pkg, 'cli.js'), 0o755);
    fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(npxBin, 'grug'));
    const local = path.join(tmp, '.local', 'bin');
    fs.mkdirSync(local, { recursive: true });
    process.env.PATH = `${npxBin}:${local}:/usr/bin:/bin`;
    const step = installCommand();
    expect(step.message).toContain('linked in');
    expect(fs.lstatSync(path.join(local, 'grug')).isSymbolicLink()).toBe(true);
    process.env.PATH = `${local}:/usr/bin:/bin`; // after npx exits
    expect(commandStatus()).toBe('on-path');
  });
});

describe('update notice', () => {
  it('SessionStart shows a user-only notice when a newer release is cached', async () => {
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(path.join(paths.home(), 'update.json'), JSON.stringify({ current: '0.0.1', latest: '99.0.0', newer: true, checkedAt: Date.now() }));
    const out: any = await runHook('session-start', { session_id: 'u1', cwd: tmp });
    expect(out.systemMessage).toContain('99.0.0');
    expect(out.systemMessage).toContain('grug update');
    expect(JSON.stringify(out.hookSpecificOutput || {})).not.toContain('99.0.0'); // not sent to Claude
  });

  it('no notice when up to date', async () => {
    await quietSummary();
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(path.join(paths.home(), 'update.json'), JSON.stringify({ current: '0.0.0-dev', latest: '0.0.0', newer: false, checkedAt: Date.now() }));
    const out: any = await runHook('session-start', { session_id: 'u2', cwd: tmp });
    expect(out?.systemMessage).toBeUndefined();
  });
});

describe('traffic check', () => {
  it('flags hook sessions with zero proxied calls', async () => {
    const { trafficCheck } = await import('../src/stats.js');
    appendBuffer('t1', { t: 'start', ts: Date.now(), cwd: tmp });
    expect(trafficCheck()).toEqual({ sessions: 1, requests: 0, metered: 0 });
  });
});

describe('stale update cache', () => {
  it('re-checks when the cached latest is older than the installed version', async () => {
    const { cachedUpdate } = await import('../src/update.js');
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(path.join(paths.home(), 'update.json'), JSON.stringify({ current: '0.0.0', latest: '0.0.0-a', newer: false, checkedAt: Date.now() }));
    expect(cachedUpdate()?.newer).toBe(false); // older/equal cached value never claims an update
  });
});

describe('transcript metering', () => {
  const line = (id: string, out: number, ts = new Date().toISOString()) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, model: 'claude-opus-5-5', usage: { input_tokens: 2, cache_read_input_tokens: 40000, cache_creation_input_tokens: 1000, output_tokens: out } } });

  it('records each reply once, reads only new bytes, and shows up in stats', async () => {
    const { meterTranscript } = await import('../src/meter.js');
    const t = path.join(tmp, 't.jsonl');
    fs.writeFileSync(t, [line('m1', 100), line('m1', 100), line('m2', 50)].join('\n') + '\n');
    expect(meterTranscript('s', t, 'p').recorded).toBe(2);
    expect(meterTranscript('s', t, 'p').recorded).toBe(0); // nothing new
    fs.appendFileSync(t, line('m3', 10) + '\n' + '{"partial":');
    expect(meterTranscript('s', t, 'p').recorded).toBe(1);
    const s = summarize();
    expect(s.requests).toBe(3);
    expect(s.outputTokens).toBe(160);
    expect(s.cacheSavedUsd).toBeGreaterThan(0);
  });

  it('does not double count traffic the proxy already recorded', async () => {
    const { meterTranscript } = await import('../src/meter.js');
    const { recordRequest } = await import('../src/stats.js');
    recordRequest({ ts: Date.now() - 1000, model: 'm', usage: {}, status: 200, trimmedTokens: 0, cacheBreakpointsAdded: 0 });
    const t = path.join(tmp, 't2.jsonl');
    fs.writeFileSync(t, line('x1', 5) + '\n');
    const r = meterTranscript('s2', t, 'p');
    expect(r.recorded).toBe(0);
    expect(r.skippedProxy).toBe(1);
  });
});

describe('leftover cleanup', () => {
  it('finds and removes hooks/MCP of uninstalled tools, keeping everything else', async () => {
    const { brokenIntegrations, fixBrokenIntegrations } = await import('../src/install.js');
    const settings = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const dead = `'${tmp}/.caveman/bin/caveman-proxy' native-hook claude --adapter '/x/native-hook-fast.js'`;
    fs.writeFileSync(settings, JSON.stringify({
      hooks: {
        SessionEnd: [{ hooks: [{ type: 'command', command: dead }, { type: 'command', command: `"/bin/sh" -c true ${MARK}` }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }]
      },
      statusLine: { type: 'command', command: `${tmp}/.caveman/bin/caveman-proxy statusline` }
    }));
    const userCfg = path.join(tmp, '.claude.json');
    fs.writeFileSync(userCfg, JSON.stringify({ mcpServers: { caveman: { command: `${tmp}/.caveman/bin/caveman-mcp` }, ok: { command: 'npx' } } }));
    expect(brokenIntegrations().map((b) => b.where).sort()).toEqual(['hook', 'mcp', 'statusLine']);
    fixBrokenIntegrations();
    const after = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(JSON.stringify(after)).not.toContain('caveman');
    expect(JSON.stringify(after.hooks.SessionEnd)).toContain(MARK);
    expect(after.hooks.Stop[0].hooks[0].command).toBe('echo mine');
    const mcp = JSON.parse(fs.readFileSync(userCfg, 'utf8')).mcpServers;
    expect(mcp.caveman).toBeUndefined();
    expect(mcp.ok).toBeTruthy();
    expect(brokenIntegrations()).toHaveLength(0);
  });
});

describe('transcript catch-up', () => {
  it('meters recent transcripts once, shared with the Stop hook', async () => {
    const { meterRecent, meterTranscript } = await import('../src/meter.js');
    const dir = path.join(tmp, '.claude', 'projects', '-Users-me-code-shop');
    fs.mkdirSync(dir, { recursive: true });
    const t = path.join(dir, 'abc.jsonl');
    fs.writeFileSync(t, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'r1', model: 'claude-sonnet-5-5', usage: { input_tokens: 5, output_tokens: 7 } } }) + '\n');
    expect(meterRecent().recorded).toBe(1);
    expect(meterTranscript('some-session-id', t, 'shop').recorded).toBe(0); // same file, already counted
    expect(meterRecent().recorded).toBe(0);
    expect(readRequests()[0].project).toBe('shop');
  });
});

// ---------------------------------------------------------------- v2.5 features
describe('config validation', () => {
  it('rejects bad values with a hint and repairs old saved ones', async () => {
    const { setConfigValue, loadConfig } = await import('../src/config.js');
    expect(() => setConfigValue('terse', 'full # caveman-style short answers')).toThrow(/# comments/);
    expect(() => setConfigValue('readGuard.enabled', 'yes')).toThrow(/true or false/);
    expect(() => setConfigValue('memory.briefTokens', 'lots')).toThrow(/number/);
    expect(() => setConfigValue('memory', '1')).toThrow(/group/);
    setConfigValue('terse', 'full');
    expect(loadConfig().terse).toBe('full');
    fs.writeFileSync(paths.config(), JSON.stringify({ terse: 'full # caveman-style short answers, now from grug' }));
    expect(loadConfig().terse).toBe('full');
  });
});

describe('context alert + handoff', () => {
  const assistant = (id: string, ctx: number, text = 'ok', extra: any[] = []) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id, model: 'claude-opus-5-5', content: [{ type: 'text', text }, ...extra], usage: { input_tokens: 10, cache_read_input_tokens: ctx - 10, cache_creation_input_tokens: 0, output_tokens: 0 } } });

  it('alerts the user (only) once per level and leaves a handoff', async () => {
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(paths.config(), JSON.stringify({ autoCompact: { windowTokens: 0 } }));
    const cwd = path.join(tmp, 'shop');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'ctx.jsonl');
    fs.writeFileSync(t, assistant('a1', 200000) + '\n');
    await runHook('session-start', { session_id: 'big', cwd, source: 'startup' });
    const a: any = await runHook('user-prompt', { session_id: 'big', cwd, transcript_path: t, prompt: 'add coupon support to checkout' });
    expect(a.systemMessage).toMatch(/200k tokens/);
    expect(a.systemMessage).toMatch(/\/clear/);
    expect(JSON.stringify(a.hookSpecificOutput || {})).not.toMatch(/200k/); // never sent to Claude
    const b: any = await runHook('user-prompt', { session_id: 'big', cwd, transcript_path: t, prompt: 'and the tests too please' });
    expect(b?.systemMessage).toBeUndefined();
    fs.appendFileSync(t, assistant('a2', 420000) + '\n');
    const c: any = await runHook('user-prompt', { session_id: 'big', cwd, transcript_path: t, prompt: 'now refactor the cart module' });
    expect(c.systemMessage).toMatch(/420k tokens/);
    const { loadHandoff } = await import('../src/handoff.js');
    expect(loadHandoff(projectKey(cwd))?.text).toContain('add coupon support to checkout');
  });

  it('/clear hands the work to the next session exactly once', async () => {
    const cwd = path.join(tmp, 'api');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'h.jsonl');
    const todo = { type: 'tool_use', id: 't', name: 'TodoWrite', input: { todos: [{ content: 'write migration', status: 'completed' }, { content: 'wire webhook retries', status: 'in_progress' }] } };
    fs.writeFileSync(t, assistant('h1', 300000, 'Webhook handler done; retries still pending.', [todo]) + '\n');
    await runHook('session-start', { session_id: 'old', cwd, source: 'startup' });
    await runHook('user-prompt', { session_id: 'old', cwd, transcript_path: t, prompt: 'build the stripe webhook handler' });
    await runHook('post-tool', { session_id: 'old', cwd, tool_name: 'Edit', tool_input: { file_path: path.join(cwd, 'src/webhook.ts') } });
    await runHook('post-tool', { session_id: 'old', cwd, tool_name: 'Bash', tool_input: { command: 'npm test' } });
    await runHook('session-end', { session_id: 'old', cwd, transcript_path: t, reason: 'clear' });
    const fresh: any = await runHook('session-start', { session_id: 'new', cwd, source: 'clear' });
    const ctx = fresh.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('grugbrain handoff');
    expect(ctx).toContain('Goal: build the stripe webhook handler');
    expect(ctx).toContain('[in_progress] wire webhook retries');
    expect(ctx).not.toContain('write migration');
    expect(ctx).toContain('src/webhook.ts');
    expect(ctx).toContain('npm test');
    expect(ctx).toContain('retries still pending');
    const again: any = await runHook('session-start', { session_id: 'newer', cwd, source: 'startup' });
    expect(JSON.stringify(again || {})).not.toContain('grugbrain handoff');
  });
});


// ---------------------------------------------------------------- v2.6 features
describe('auto-compaction + restore', () => {
  it('installer manages autoCompactWindow/env and restores the previous values', () => {
    const settings = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ autoCompactWindow: 500000, env: { KEEP: '1' } }));
    installClaudeCode(false);
    const s1 = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(s1.autoCompactWindow).toBe(150000);
    expect(s1.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('150000');
    expect(s1.env.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    installClaudeCode(false); // idempotent, still remembers the original 500000
    uninstall();
    const s2 = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(s2.autoCompactWindow).toBe(500000);
    expect(s2.env).toEqual({ KEEP: '1' });
  });

  it('config set applies routing/auto-compact changes to Claude Code at once', async () => {
    const { setConfigValue } = await import('../src/config.js');
    const { applyTuningNow } = await import('../src/install.js');
    const settings = path.join(tmp, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, '{}');
    expect(() => setConfigValue('autoCompact.windowTokens', '50000')).toThrow(/100000/);
    expect(() => setConfigValue('routing.subagentModel', 'gpt')).toThrow(/one of/);
    setConfigValue('routing.subagentModel', 'sonnet');
    setConfigValue('autoCompact.windowTokens', '0');
    applyTuningNow();
    const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
    expect(s.env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('sonnet');
    expect(s.autoCompactWindow).toBeUndefined();
  });

  it('after auto-compaction the same session gets its own handoff back', async () => {
    const cwd = path.join(tmp, 'svc');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'c.jsonl');
    fs.writeFileSync(t, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'z', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Rate limiter wired into the API gateway; load test still to run.' }], usage: { input_tokens: 1, cache_read_input_tokens: 190000, output_tokens: 1 } } }) + '\n');
    await runHook('session-start', { session_id: 'long', cwd, source: 'startup' });
    await runHook('user-prompt', { session_id: 'long', cwd, transcript_path: t, prompt: 'add rate limiting to the gateway' });
    await runHook('pre-compact', { session_id: 'long', cwd, transcript_path: t });
    const out: any = await runHook('session-start', { session_id: 'long', cwd, source: 'compact' });
    const ctx = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('Goal: add rate limiting to the gateway');
    expect(ctx).toContain('load test still to run');
    expect(ctx).toContain('`history` tool');
  });
});

describe('history tool', () => {
  it('finds exact earlier details in the project transcripts', async () => {
    const { searchHistory, projectTranscriptDir } = await import('../src/history.js');
    const cwd = path.join(tmp, 'my app');
    const dir = projectTranscriptDir(cwd);
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 's1.jsonl'), [
      JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'deploy fails with ECONNRESET on the payments worker' } }),
      JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text: 'Decision: we pin undici to 6.19 because 6.20 drops keep-alive sockets (ECONNRESET).' }] } }),
      JSON.stringify({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'unrelated output' }] } })
    ].join('\n') + '\n');
    const out = searchHistory(cwd, 'ECONNRESET undici');
    expect(out).toContain('pin undici to 6.19');
    expect(out).toContain('you: deploy fails with ECONNRESET');
    expect(out).not.toContain('unrelated output');
    const r = handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'history', arguments: { query: 'undici', dir: cwd } } });
    expect(r.result.content[0].text).toContain('6.19');
  });
});

// ---------------------------------------------------------------- v2.7 features
const line = (type: 'user' | 'assistant', content: any, ts = new Date().toISOString(), extra: any = {}) =>
  JSON.stringify({ type, timestamp: ts, message: { role: type, content }, ...extra });

function writeTranscript(cwd: string, name: string, lines: string[]): string {
  const dir = projectTranscriptDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  fs.writeFileSync(f, lines.join('\n') + '\n');
  return f;
}

function codeProject(name: string): string {
  const cwd = path.join(tmp, name);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"name":"shop"}');
  fs.writeFileSync(
    path.join(cwd, 'src', 'webhook.ts'),
    `import { db } from './db';\n\nexport function verifyStripeSignature(body: string, sig: string): boolean {\n  return sig.length > 0 && body.length > 0;\n}\n\nexport async function handleStripeWebhook(req: any) {\n  if (!verifyStripeSignature(req.body, req.sig)) throw new Error('bad sig');\n  await db.save(req.body);\n}\n`
  );
  fs.writeFileSync(path.join(cwd, 'src', 'db.ts'), `export const db = { save: async (x: any) => x };\n`);
  fs.writeFileSync(path.join(cwd, 'src', 'cart.ts'), `import { db } from './db';\nexport function addToCart(id: string) { return db.save(id); }\n`);
  return cwd;
}

describe('relevance', () => {
  it('treats short acknowledgements as trivial and keeps identifiers', async () => {
    const { isTrivialPrompt, queryTerms, rank } = await import('../src/relevance.js');
    for (const p of ['ok', 'yes', 'go ahead', 'thanks!', 'fix it', '/clear', 'lgtm']) expect(isTrivialPrompt(p)).toBe(true);
    expect(isTrivialPrompt('why does the stripe webhook retry twice')).toBe(false);
    const t = queryTerms('speed up searchHistory in history.ts');
    expect(t).toEqual(expect.arrayContaining(['searchhistory', 'search', 'history', 'history.ts', 'speed']));
    // A rare term outranks a common one.
    const docs = ['the test passed', 'the test failed', 'the test ran', 'ECONNRESET in the test'].map((d) => d.toLowerCase());
    expect(rank(docs, ['test', 'econnreset'])[0].index).toBe(3);
  });

  it('matches paraphrases through concept groups at reduced credit, direct words still win', async () => {
    const { alternatives, rank, queryTerms } = await import('../src/relevance.js');
    expect(alternatives('pictur')).toContain('avatar'); // "pictures" ~ "avatar", despite different stems
    expect(alternatives('login')).toContain('authenticate');
    expect(alternatives('login')).not.toContain('login');
    const docs = ['login sessions expire after thirty minutes', 'authentication settings page'];
    const terms = queryTerms('why does authentication expire');
    const plain = rank(docs, terms);
    const withAlts = rank(docs, terms, undefined, undefined, true);
    expect(plain[0].index).toBe(1); // direct word only
    expect(withAlts.find((r) => r.index === 0)!.matched).toBeCloseTo(1.6, 5); // "expire" direct (1.0) + "authentication" via "login" (0.6)
    expect(withAlts.find((r) => r.index === 1)!.matched).toBeGreaterThanOrEqual(1);
    // Unknown words get no alternatives, so nothing is invented.
    expect(alternatives('fibonacci')).toEqual([]);
  });
});

describe('history cache + ranking', () => {
  it('caches parsed transcripts by size/mtime and parses only appended lines', async () => {
    const { historyHits, transcriptItems } = await import('../src/history.js');
    const cwd = path.join(tmp, 'cached');
    const f = writeTranscript(cwd, 'a.jsonl', [line('user', 'the payments worker crashes with ECONNRESET under load')]);
    expect(historyHits(cwd, 'payments ECONNRESET').hits[0].item.text).toContain('ECONNRESET');
    const cacheDir = path.join(paths.home(), 'cache', 'history');
    expect(fs.readdirSync(cacheDir).length).toBe(1);
    fs.appendFileSync(f, line('assistant', [{ type: 'text', text: 'Decision: pin undici to 6.19 because 6.20 drops keep-alive sockets.' }]) + '\n');
    const items = transcriptItems(f)!;
    expect(items.length).toBe(2); // old item kept from cache, new one parsed
    expect(historyHits(cwd, 'undici keep-alive').hits[0].item.text).toContain('pin undici');
    // grug's own injected blocks are never indexed
    fs.appendFileSync(f, line('user', '[grugbrain recall: possibly relevant notes] undici undici undici') + '\n');
    expect(transcriptItems(f)!.some((i) => i.text.includes('[grugbrain'))).toBe(false);
  });
});

describe('auto-recall', () => {
  async function setup() {
    const cwd = codeProject('shop');
    withMem((db) => {
      addNote(db, projectKey(cwd), 'Stripe webhook retries must be idempotent: dedupe on event id before saving', Date.now(), { kind: 'decision' });
      addNote(db, projectKey(cwd), 'Deploys go through fly.io, never from a laptop', Date.now(), { pinned: true });
    });
    writeTranscript(cwd, 'old.jsonl', [
      line('user', 'the stripe webhook fails signature verification in staging', new Date(Date.now() - 3 * DAY).toISOString()),
      line('assistant', [{ type: 'text', text: 'Root cause: the staging webhook secret was rotated; verifyStripeSignature used the old STRIPE_WEBHOOK_SECRET.' }], new Date(Date.now() - 3 * DAY).toISOString()),
      line('user', 'unrelated: rename the cart button colour', new Date(Date.now() - 3 * DAY).toISOString())
    ]);
    const { buildGraphIndex } = await import('../src/graph.js');
    buildGraphIndex(cwd);
    return cwd;
  }
  function withMem(fn: (db: MemoryDB) => void) {
    const db = loadMemory();
    fn(db);
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(paths.memory(), JSON.stringify(db));
  }

  it('injects memory, code locations and earlier-session excerpts under the cap, once', async () => {
    const cwd = await setup();
    const cur = path.join(tmp, 'current.jsonl');
    fs.writeFileSync(cur, line('user', 'stripe webhook signature: this is already in my context') + '\n');
    const prompt = 'stripe webhook retries fail the signature check in verifyStripeSignature';
    // A note the session brief already showed is not repeated by recall.
    const start: any = await runHook('session-start', { session_id: 'r0', cwd, source: 'startup' });
    expect(start.hookSpecificOutput.additionalContext).toContain('idempotent');
    const r0: any = await runHook('user-prompt', { session_id: 'r0', cwd, prompt, transcript_path: cur });
    expect(r0.hookSpecificOutput.additionalContext).not.toContain('idempotent');
    const out: any = await runHook('user-prompt', { session_id: 'r1', cwd, prompt, transcript_path: cur });
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx.startsWith('[grugbrain recall: possibly relevant notes from memory/earlier sessions; verify before relying]')).toBe(true);
    expect(ctx).toContain('idempotent');
    expect(ctx).not.toContain('fly.io'); // pinned but unrelated
    expect(ctx).toMatch(/src\/webhook\.ts.*verifyStripeSignature\(\) L3-5/);
    expect(ctx).toContain('secret was rotated');
    expect(ctx).not.toContain('already in my context'); // current session is in context already
    expect(ctx).not.toContain('cart button');
    // Memory is listed before code, code before history.
    expect(ctx.indexOf('idempotent')).toBeLessThan(ctx.indexOf('webhook.ts'));
    expect(ctx.indexOf('webhook.ts')).toBeLessThan(ctx.indexOf('secret was rotated'));
    const { estimateTokens } = await import('../src/tokens.js');
    expect(estimateTokens(ctx)).toBeLessThanOrEqual(800);
    const kinds = readActivity().map((a: any) => a.kind);
    expect(kinds).toEqual(expect.arrayContaining(['auto-recall', 'graph']));
    // Same prompt again: nothing new to say.
    const again: any = await runHook('user-prompt', { session_id: 'r1', cwd, prompt, transcript_path: cur });
    expect(again?.hookSpecificOutput).toBeUndefined();
    // After auto-compaction the context is gone, so recall may speak again.
    await runHook('pre-compact', { session_id: 'r1', cwd, transcript_path: cur });
    const after: any = await runHook('user-prompt', { session_id: 'r1', cwd, prompt, transcript_path: cur });
    expect(after.hookSpecificOutput.additionalContext).toContain('idempotent');
  });

  it('stays quiet for trivial or unrelated prompts, respects the token cap and the toggle', async () => {
    const cwd = await setup();
    await runHook('session-start', { session_id: 'r2', cwd, source: 'startup' });
    for (const prompt of ['ok', 'yes go ahead', 'write a haiku about autumn leaves falling']) {
      const out: any = await runHook('user-prompt', { session_id: 'r2', cwd, prompt });
      expect(out?.hookSpecificOutput).toBeUndefined();
    }
    const { setConfigValue } = await import('../src/config.js');
    expect(() => setConfigValue('autoRecall.maxTokens', '50')).toThrow(/between 100 and 4000/);
    expect(() => setConfigValue('autoRecall.enabled', 'maybe')).toThrow(/true or false/);
    expect(() => setConfigValue('graphContext.mapTokens', '99999')).toThrow(/between/);
    setConfigValue('autoRecall.maxTokens', '120');
    const small: any = await runHook('user-prompt', { session_id: 'r3', cwd, prompt: 'the stripe webhook signature check fails, see verifyStripeSignature' });
    const { estimateTokens } = await import('../src/tokens.js');
    expect(estimateTokens(small.hookSpecificOutput.additionalContext)).toBeLessThanOrEqual(120);
    setConfigValue('autoRecall.enabled', 'false');
    const off: any = await runHook('user-prompt', { session_id: 'r4', cwd, prompt: 'the stripe webhook signature check fails, see verifyStripeSignature' });
    expect(JSON.stringify(off || {})).not.toContain('possibly relevant notes');
  });

  it('stays fast on a large synthetic history', async () => {
    const { historyHits, warmHistory } = await import('../src/history.js');
    const { autoRecall } = await import('../src/recall.js');
    const { loadConfig } = await import('../src/config.js');
    const cwd = codeProject('big');
    const words = 'alpha beta gamma delta build deploy cache queue worker retry schema index router token parser module'.split(' ');
    for (let f = 0; f < 20; f++) {
      const ls: string[] = [];
      for (let i = 0; i < 1200; i++) {
        const w = Array.from({ length: 60 }, (_, j) => words[(i * 7 + j * 3 + f) % words.length]).join(' ');
        ls.push(line(i % 2 ? 'assistant' : 'user', i % 2 ? [{ type: 'text', text: w }] : w));
      }
      if (f === 7) ls.push(line('assistant', [{ type: 'text', text: 'Root cause: the flux capacitor overheats when QUANTUM_MODE is on.' }]));
      writeTranscript(cwd, `s${f}.jsonl`, ls);
    }
    // Cold, with a time budget: returns within budget-ish, marks the result partial.
    const t0 = Date.now();
    const cold = historyHits(cwd, 'flux capacitor overheats', { budgetMs: 30 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(cold.partial).toBe(true);
    warmHistory(cwd); // what `grug warm` does in the background at session start
    const t1 = Date.now();
    const r = autoRecall({ cfg: loadConfig(), sessionId: 'lat', cwd, prompt: 'why does the flux capacitor overheat with QUANTUM_MODE' });
    const ms = Date.now() - t1;
    expect(r?.text).toContain('flux capacitor overheats');
    expect(ms).toBeLessThan(400); // typical is well under 150ms; loose bound for slow CI
  });
});

describe('graph-first code context', () => {
  it('injects a compact code map and tool guidance at session start, only for code projects', async () => {
    const cwd = codeProject('mapped');
    const out: any = await runHook('session-start', { session_id: 'g1', cwd, source: 'startup' });
    const ctx: string = out.hookSpecificOutput.additionalContext;
    expect(ctx).toContain('[grugbrain code map');
    expect(ctx).toMatch(/Grep for the symbol, then Read with offset\/limit/);
    expect(ctx).toContain('webhook.ts');
    expect(ctx).toContain('db.ts (');
    const { estimateTokens } = await import('../src/tokens.js');
    expect(estimateTokens(ctx.slice(ctx.indexOf('[grugbrain code map')))).toBeLessThanOrEqual(640);
    expect(readActivity().some((a: any) => a.kind === 'graph')).toBe(true);
    const plain = path.join(tmp, 'notes');
    fs.mkdirSync(plain);
    const none: any = await runHook('session-start', { session_id: 'g2', cwd: plain, source: 'startup' });
    expect(JSON.stringify(none || {})).not.toContain('code map');
    const { setConfigValue } = await import('../src/config.js');
    setConfigValue('graphContext.enabled', 'false');
    const off: any = await runHook('session-start', { session_id: 'g3', cwd, source: 'startup' });
    expect(JSON.stringify(off || {})).not.toContain('code map');
  });
});

describe('durable fact capture', () => {
  it('extracts decisions, root causes, preferences and working commands at handoff time, deduped', async () => {
    const cwd = path.join(tmp, 'facts');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'f.jsonl');
    const bash = (id: string, command: string) => ({ type: 'tool_use', id, name: 'Bash', input: { command } });
    const result = (id: string, content: string, is_error = false) => ({ type: 'tool_result', tool_use_id: id, content, is_error });
    fs.writeFileSync(t, [
      line('user', 'Please always use pnpm in this repo, never npm.'),
      line('assistant', [{ type: 'text', text: "Let me run the tests." }, bash('b1', 'pnpm test')]),
      line('user', [result('b1', 'FAILED src/cart.test.ts\nexit code 1', true)]),
      line('assistant', [{ type: 'text', text: 'The failure happens because the cart total is rounded before tax is applied. We chose to round only at checkout to match the invoice service.' }, bash('b2', 'pnpm test')]),
      line('user', [result('b2', 'Tests 42 passed')]),
      line('assistant', [bash('b3', 'export API_TOKEN=abc123 && pnpm run deploy')]),
      line('user', [result('b3', 'ok')])
    ].join('\n') + '\n');
    await runHook('session-start', { session_id: 'f1', cwd, source: 'startup' });
    await runHook('user-prompt', { session_id: 'f1', cwd, prompt: 'fix the cart rounding bug' });
    await runHook('pre-compact', { session_id: 'f1', cwd, transcript_path: t });
    await runHook('session-end', { session_id: 'f1', cwd, transcript_path: t });
    const factEvents = readBuffer('f1').filter((e: any) => e.t === 'facts');
    expect(factEvents.length).toBe(1); // the second handoff found nothing new
    const texts = (factEvents[0] as any).items.map((f: any) => f.text).join('\n');
    expect(texts).toContain('User preference: Please always use pnpm');
    expect(texts).toMatch(/Root cause: The failure happens because the cart total is rounded/);
    expect(texts).toContain('We chose to round only at checkout');
    expect(texts).toContain('Command that works here: `pnpm test`');
    expect(texts).not.toContain('abc123'); // secrets never stored
    const db = loadMemory();
    ingestSession(db, 'f1');
    ingestSession(db, 'f1'); // idempotent
    const notes = Object.values(db.nodes).filter((n) => n.type === 'note' && n.data?.kind);
    expect(notes.map((n) => n.data.kind).sort()).toEqual(['cause', 'command', 'decision', 'preference']);
    expect(notes.every((n) => n.touches === 0)).toBe(true);
    // No pile-up: auto facts are capped per project, pinned notes untouched.
    const p = projectKey(cwd);
    for (let i = 0; i < 90; i++) addNote(db, p, `Decision number ${i} about subsystem ${'xyzw'.repeat(i % 7)} ${i * 13} zone${i}`, Date.now() - i * 1000, { kind: 'decision' });
    addNote(db, p, 'pinned: keep this forever please', Date.now(), { pinned: true });
    consolidate(db, defaultConfig().memory);
    const left = Object.values(db.nodes).filter((n) => n.type === 'note' && n.project === p);
    expect(left.filter((n) => n.data?.kind && !n.data?.pinned).length).toBeLessThanOrEqual(60); // the auto-pinned standing rule (always use pnpm) is exempt
    expect(left.some((n) => n.data?.pinned)).toBe(true);
    // Recall picks the captured fact up later.
    fs.writeFileSync(paths.memory(), JSON.stringify(db));
    const r: any = await runHook('user-prompt', { session_id: 'f2', cwd, prompt: 'the cart total rounding looks wrong again before tax' });
    expect(r.hookSpecificOutput.additionalContext).toContain('rounded before tax');
  });
});

describe('dashboard shows auto-recall and graph usage', () => {
  it('counts the new activity kinds with average tokens', async () => {
    const { recordActivity } = await import('../src/stats.js');
    recordActivity({ kind: 'auto-recall', msg: 'x', tokens: -300 });
    recordActivity({ kind: 'auto-recall', msg: 'y', tokens: -100 });
    recordActivity({ kind: 'graph', msg: 'z', tokens: -500 });
    const s = summarize();
    expect(s.countByKind['auto-recall']).toBe(2);
    expect(s.savedByKind['graph']).toBe(-500);
    const { renderOnce } = await import('../src/tui/dashboard.js');
    const text = renderOnce({ tab: 1 } as any, 160, 80).replace(/\u001b\[[0-9;]*m/g, '');
    expect(text).toMatch(/auto-recall injections.*2×.*avg 200 tok/);
    expect(text).toMatch(/graph context: maps \+ code hints.*1×/);
  });
});

// ---------------------------------------------------------------- v2.8 features
function seedNotes(cwd: string, notes: string[]) {
  const db = loadMemory();
  for (const n of notes) addNote(db, projectKey(cwd), n, Date.now(), { kind: 'decision' });
  fs.mkdirSync(paths.home(), { recursive: true });
  fs.writeFileSync(paths.memory(), JSON.stringify(db));
}

describe('session-wide recall budget', () => {
  const NOTES = [
    'Invoice PDFs are rendered by wkhtmltopdf inside the billing worker container',
    'Kafka consumer offsets must be committed only after the database write succeeds',
    'Feature flags live in LaunchDarkly and are cached for sixty seconds per process',
    'Nightly reports run through the cron scheduler on the analytics cluster'
  ];
  const PROMPTS = [
    'how are invoice PDFs rendered inside the billing worker',
    'when do kafka consumer offsets get committed after the database write',
    'where do the feature flags live and how long are they cached',
    'which cluster runs the nightly reports through the cron scheduler'
  ];

  it('caps everything recall injects into one session and resets after compaction', async () => {
    const { setConfigValue } = await import('../src/config.js');
    expect(() => setConfigValue('autoRecall.sessionTokens', '10')).toThrow(/between 200 and 20000/);
    setConfigValue('autoRecall.sessionTokens', '200');
    const cwd = path.join(tmp, 'budget');
    fs.mkdirSync(cwd);
    seedNotes(cwd, NOTES); // no session-start here: the brief would already have shown these notes
    const got: boolean[] = [];
    for (const prompt of PROMPTS) {
      const out: any = await runHook('user-prompt', { session_id: 'b1', cwd, prompt });
      got.push(!!out?.hookSpecificOutput?.additionalContext);
    }
    expect(got[0]).toBe(true);
    expect(got[3]).toBe(false); // budget spent: silence beats an ever-growing context
    const spent = (readBuffer('b1') as any[]).filter((e) => e.t === 'recall').reduce((s, e) => s + e.tokens, 0);
    expect(spent).toBeLessThanOrEqual(200);
    await runHook('pre-compact', { session_id: 'b1', cwd });
    const again: any = await runHook('user-prompt', { session_id: 'b1', cwd, prompt: PROMPTS[3] });
    expect(again.hookSpecificOutput.additionalContext).toContain('cron scheduler');
  });

  it('raises the relevance bar as the budget fills', async () => {
    const { autoRecall } = await import('../src/recall.js');
    const { loadConfig } = await import('../src/config.js');
    const cwd = path.join(tmp, 'bar');
    fs.mkdirSync(cwd);
    seedNotes(cwd, ['Invoice PDFs are rendered by wkhtmltopdf inside the billing worker container']);
    // Weak match: 2 of 5 prompt words. Fine on a fresh session...
    const weak = 'invoice billing reports summary statistics';
    expect(autoRecall({ cfg: loadConfig(), sessionId: 'bar-a', cwd, prompt: weak })).not.toBeNull();
    // ...but not once most of the budget is already in context.
    appendBuffer('bar-b', { t: 'recall', ts: Date.now(), keys: [], tokens: 2000 });
    expect(autoRecall({ cfg: loadConfig(), sessionId: 'bar-b', cwd, prompt: weak })).toBeNull();
  });
});

describe('recall usefulness tuning', () => {
  it('scores hinted files that were then used (built-in and grug tools), once, and adjusts strictness', async () => {
    const { loadTune, nextStrictness, scoreRecalls } = await import('../src/recalltune.js');
    const { buildGraphIndex } = await import('../src/graph.js');
    const cwd = codeProject('tune');
    buildGraphIndex(cwd);
    const prompt = 'the stripe webhook signature check is failing in verifyStripeSignature';
    const hinted = async (sid: string) => {
      await runHook('session-start', { session_id: sid, cwd, source: 'startup' });
      const out: any = await runHook('user-prompt', { session_id: sid, cwd, prompt });
      expect(out.hookSpecificOutput.additionalContext).toContain('src/webhook.ts');
      expect((readBuffer(sid) as any[]).find((e) => e.t === 'recall').files).toContain('src/webhook.ts');
    };
    await hinted('t1');
    await runHook('post-tool', { session_id: 't1', cwd, tool_name: 'mcp__grugbrain__read_symbol', tool_input: { path: path.join(cwd, 'src/webhook.ts'), name: 'verifyStripeSignature' } });
    await runHook('session-end', { session_id: 't1', cwd, reason: 'other' });
    expect(loadTune()).toMatchObject({ codeShown: 1, codeHit: 1 });
    expect(scoreRecalls('t1', cwd).shown).toBe(0); // already scored: never double counted
    await hinted('t2'); // hinted, but Claude never touched the file
    await runHook('post-tool', { session_id: 't2', cwd, tool_name: 'Read', tool_input: { file_path: path.join(cwd, 'src/cart.ts') } });
    await runHook('pre-compact', { session_id: 't2', cwd });
    await runHook('session-end', { session_id: 't2', cwd });
    expect(loadTune()).toMatchObject({ codeShown: 2, codeHit: 1 });
    // Strictness only moves with enough evidence, in small bounded steps.
    expect(nextStrictness({ codeShown: 5, codeHit: 0, strictness: 1 })).toBe(1);
    expect(nextStrictness({ codeShown: 20, codeHit: 1, strictness: 1 })).toBe(1.1);
    expect(nextStrictness({ codeShown: 20, codeHit: 15, strictness: 1 })).toBe(0.9);
    expect(nextStrictness({ codeShown: 20, codeHit: 1, strictness: 1.6 })).toBe(1.6);
    expect(nextStrictness({ codeShown: 20, codeHit: 15, strictness: 0.8 })).toBe(0.8);
    fs.writeFileSync(path.join(paths.home(), 'recall-tune.json'), JSON.stringify({ strictness: 9, codeShown: 'x' }));
    expect(loadTune()).toEqual({ codeShown: 0, codeHit: 0, strictness: 1.6 });
    const { renderOnce } = await import('../src/tui/dashboard.js');
    expect(renderOnce({ tab: 1 } as any, 160, 80).replace(/\u001b\[[0-9;]*m/g, '')).toMatch(/recall usefulness.*strictness ×1\.60/);
  });
});

describe('code graph stays fresh during a session', () => {
  it('finds a symbol from a file created a moment ago, before any rescan', async () => {
    const { buildGraphIndex, refreshGraphSoon } = await import('../src/graph.js');
    const cwd = codeProject('fresh');
    buildGraphIndex(cwd);
    fs.writeFileSync(path.join(cwd, 'src', 'refund.ts'), `export function issueRefundLedgerEntry(orderId: string) {\n  return orderId;\n}\n`);
    await runHook('session-start', { session_id: 'fr1', cwd, source: 'startup' });
    const prompt = 'add a refund ledger entry when we issue a refund for an order';
    const before: any = await runHook('user-prompt', { session_id: 'fr1', cwd, prompt });
    expect(JSON.stringify(before || {})).not.toContain('refund.ts'); // not indexed yet, nothing edited via Claude
    await runHook('post-tool', { session_id: 'fr1', cwd, tool_name: 'Write', tool_input: { file_path: path.join(cwd, 'src', 'refund.ts') } });
    const after: any = await runHook('user-prompt', { session_id: 'fr1', cwd, prompt: prompt + ' please' });
    expect(after.hookSpecificOutput.additionalContext).toMatch(/src\/refund\.ts.*issueRefundLedgerEntry\(\) L1-3/);
    // The background rescan is debounced: once per window per project.
    const t0 = Date.now();
    expect(refreshGraphSoon(cwd, t0 + 3600_000)).toBe(true);
    expect(refreshGraphSoon(cwd, t0 + 3600_000 + 10_000)).toBe(false);
    expect(refreshGraphSoon(cwd, t0 + 3600_000 + 60_000)).toBe(true);
  });

  it('forgets a deleted file instead of hinting at it', async () => {
    const { buildGraphIndex, loadGraphIndex, overlayFresh } = await import('../src/graph.js');
    const cwd = codeProject('gone');
    buildGraphIndex(cwd);
    fs.unlinkSync(path.join(cwd, 'src', 'cart.ts'));
    const idx = overlayFresh(loadGraphIndex(cwd)!, ['src/cart.ts']);
    expect(idx.files.some((f) => f.rel === 'src/cart.ts')).toBe(false);
  });
});

describe('incremental fact capture', () => {
  const filler = (n: number) => Array.from({ length: n }, () => line('user', [{ type: 'tool_result', tool_use_id: 'x', content: 'y'.repeat(50_000) }]));
  const say = (text: string) => line('assistant', [{ type: 'text', text }]);

  it('captures facts as the session goes, reading each byte once, even past the tail window', async () => {
    const cwd = path.join(tmp, 'inc');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'inc.jsonl');
    fs.writeFileSync(t, [say('We chose to keep the job queue in Redis because ordering matters more than throughput.'), ...filler(1)].join('\n') + '\n');
    await runHook('session-start', { session_id: 'i1', cwd, source: 'startup' });
    await runHook('user-prompt', { session_id: 'i1', cwd, prompt: 'set up the job queue' });
    await runHook('stop', { session_id: 'i1', cwd, transcript_path: t });
    const facts = () => (readBuffer('i1') as any[]).filter((e) => e.t === 'facts').flatMap((e) => e.items.map((f: any) => f.text));
    expect(facts().join('\n')).toContain('keep the job queue in Redis');
    // Six more megabytes: the old decision is far outside the 4 MB tail a final-only pass would read.
    fs.appendFileSync(t, [...filler(120), say('Decided: use Postgres advisory locks for the nightly billing job.'), ...filler(1)].join('\n') + '\n');
    await runHook('stop', { session_id: 'i1', cwd, transcript_path: t });
    expect(facts().join('\n')).toContain('Postgres advisory locks');
    expect(facts().filter((x) => x.includes('Redis')).length).toBe(1); // not re-captured
    const n = facts().length;
    await runHook('pre-compact', { session_id: 'i1', cwd, transcript_path: t });
    await runHook('session-end', { session_id: 'i1', cwd, transcript_path: t });
    expect(facts().length).toBe(n); // nothing new, nothing duplicated
    const db = loadMemory();
    ingestSession(db, 'i1');
    const notes = Object.values(db.nodes).filter((x) => x.type === 'note').map((x) => x.label).join('\n');
    expect(notes).toContain('Redis');
    expect(notes).toContain('advisory locks');
  });

  it('does not rescan on every Stop: small growth waits for enough new transcript', async () => {
    const cwd = path.join(tmp, 'inc2');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'inc2.jsonl');
    fs.writeFileSync(t, say('We chose to deploy on Fridays only because support is staffed then.') + '\n');
    await runHook('session-start', { session_id: 'i2', cwd, source: 'startup' });
    await runHook('stop', { session_id: 'i2', cwd, transcript_path: t });
    expect((readBuffer('i2') as any[]).some((e) => e.t === 'facts')).toBe(false); // <24 KB: skipped
    await runHook('pre-compact', { session_id: 'i2', cwd, transcript_path: t });
    expect((readBuffer('i2') as any[]).some((e) => e.t === 'facts')).toBe(true); // handoff time always scans
  });

  it('caps facts per session', async () => {
    const cwd = path.join(tmp, 'inc3');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'inc3.jsonl');
    const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
    const rows: string[] = [];
    for (let i = 0; i < 60; i++) rows.push(say(`We chose ${words[i % 10]} number ${i} for subsystem ${words[(i * 3) % 10]}${i} because reasons differ ${i * 7}.`));
    fs.writeFileSync(t, rows.join('\n') + '\n');
    await runHook('session-start', { session_id: 'i3', cwd, source: 'startup' });
    for (let i = 0; i < 12; i++) {
      fs.appendFileSync(t, filler(1).join('\n') + '\n' + say(`Decided: option ${words[i % 10]}${i} wins for area ${i * 11} today ok.`) + '\n');
      await runHook('stop', { session_id: 'i3', cwd, transcript_path: t });
      await runHook('pre-compact', { session_id: 'i3', cwd, transcript_path: t });
    }
    const total = (readBuffer('i3') as any[]).filter((e) => e.t === 'facts').reduce((s, e) => s + e.items.length, 0);
    expect(total).toBeLessThanOrEqual(30);
  });
});

// ---------------------------------------------------------------- v2.9 features
describe('cache-expiry notice', () => {
  const reply = (id: string, minutesAgo: number, ctx: number, tier: '1h' | '5m') =>
    JSON.stringify({
      type: 'assistant',
      timestamp: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      message: {
        id,
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: 'done' }],
        usage: { input_tokens: 5, cache_read_input_tokens: ctx - 5000, cache_creation_input_tokens: 5000, cache_creation: tier === '1h' ? { ephemeral_1h_input_tokens: 5000 } : { ephemeral_5m_input_tokens: 5000 }, output_tokens: 10 }
      }
    });
  const ask = (sid: string, cwd: string, t: string, prompt = 'now add the refund endpoint to the orders api') => runHook('user-prompt', { session_id: sid, cwd, transcript_path: t, prompt }) as Promise<any>;

  it('warns the user (only) once per idle gap when a big session went cold, and readies a handoff', async () => {
    const cwd = path.join(tmp, 'idle');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'idle.jsonl');
    fs.writeFileSync(t, reply('a1', 120, 200000, '1h') + '\n'); // 2 h ago, 1-hour tier: expired
    await runHook('session-start', { session_id: 'c1', cwd, source: 'startup' });
    const out = await ask('c1', cwd, t);
    expect(out.systemMessage).toMatch(/idle 2 h.*cache expired.*200k tokens/);
    expect(out.systemMessage).toMatch(/\$1\.6\d instead of ~\$0\.\d+/); // 200k x $4 x 2 vs x 0.1
    expect(out.systemMessage).toContain('/clear');
    expect(JSON.stringify(out.hookSpecificOutput || {})).not.toMatch(/expired/); // never sent to Claude
    const { loadHandoff } = await import('../src/handoff.js');
    expect(loadHandoff(projectKey(cwd))?.text).toContain('now add the refund endpoint');
    expect((await ask('c1', cwd, t, 'and also update the docs for it'))?.systemMessage).toBeUndefined(); // same gap: once
    fs.appendFileSync(t, reply('a2', 90, 205000, '1h') + '\n'); // a new, later gap
    expect((await ask('c1', cwd, t, 'why does the checkout total look wrong'))?.systemMessage).toMatch(/idle 90 min/);
    expect(readActivity().some((a: any) => a.kind === 'idle-alert')).toBe(true);
  });

  it('stays quiet while the cache is warm, when the session is small, or when it is switched off', async () => {
    await quietSummary();
    const cwd = path.join(tmp, 'idle2');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'idle2.jsonl');
    fs.writeFileSync(t, reply('b1', 30, 200000, '1h') + '\n'); // 30 min on the 1-hour tier: still warm
    expect((await ask('c2', cwd, t))?.systemMessage).toBeUndefined();
    fs.writeFileSync(t, reply('b2', 10, 200000, '5m') + '\n'); // 10 min on the 5-minute tier: expired
    expect((await ask('c3', cwd, t))?.systemMessage).toMatch(/cache expired/);
    fs.writeFileSync(t, reply('b3', 600, 20000, '1h') + '\n'); // long idle but tiny context: not worth a notice
    expect((await ask('c4', cwd, t))?.systemMessage).toBeUndefined();
    const { setConfigValue } = await import('../src/config.js');
    setConfigValue('idleAlert.enabled', 'false');
    fs.writeFileSync(t, reply('b4', 600, 200000, '1h') + '\n');
    expect((await ask('c5', cwd, t))?.systemMessage).toBeUndefined();
  });
});

// ---------------------------------------------------------------- v2.10 features: media
import * as zlib from 'node:zlib';
import { decodePng, encodePng, estimateImageTokens, imageSizeOf, shrinkImage, imageSizeOfFile } from '../src/media.js';

function pngFile(file: string, w: number, h: number, pattern: 'solid' | 'checker' | 'gradient' = 'gradient', ch = 3): string {
  const data = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let c = 0; c < ch; c++) {
        const v = pattern === 'solid' ? 90 : pattern === 'checker' ? ((x >> 3) + (y >> 3)) % 2 ? 250 : 10 : (x * 255) / w + c * 10;
        data[(y * w + x) * ch + c] = Math.min(255, Math.round(v));
      }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePng({ w, h, channels: ch, data }));
  return file;
}

/** Enough of a PNG for a header parse (dimensions) without allocating pixels. */
const fakeImageB64 = (w: number, h: number) => {
  const b = Buffer.alloc(200);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b.toString('base64');
};

function stubBin(scripts: Record<string, string>): string {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, body] of Object.entries(scripts)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  return bin;
}

const scratch = () => path.join(tmp, 'scratchpad');
const preRead = (sid: string, cwd: string, file: string, extra: any = {}) => runHook('pre-tool', { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: file, ...extra }, scratchpad_dir: scratch() }) as Promise<any>;
const postRead = (sid: string, cwd: string, file: string) =>
  runHook('post-tool', { session_id: sid, cwd, tool_name: 'Read', tool_input: { file_path: file }, tool_response: { type: 'image', file: { base64: fakeImageB64(...(((s) => [s!.w, s!.h])(imageSizeOfFile(file))) as [number, number]) } } });

describe('image parsing and PNG resizing', () => {
  it('reads dimensions from PNG, JPEG, GIF and WebP headers and estimates tokens like the API', () => {
    const p = Buffer.alloc(40);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(p);
    p.writeUInt32BE(1000, 16);
    p.writeUInt32BE(625, 20);
    expect(imageSizeOf(p)).toEqual({ w: 1000, h: 625, type: 'png' });
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x02, 0x71, 0x03, 0xe8, 0x03, 0x01, 0x11, 0x00, 0x00, 0x00, 0x00]);
    expect(imageSizeOf(jpg)).toEqual({ w: 1000, h: 625, type: 'jpeg' });
    const gif = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)]);
    expect(imageSizeOf(gif)).toEqual({ w: 320, h: 240, type: 'gif' });
    const webp = Buffer.alloc(40);
    webp.write('RIFF', 0, 'latin1');
    webp.write('WEBP', 8, 'latin1');
    webp.write('VP8X', 12, 'latin1');
    webp.writeUIntLE(799, 24, 3);
    webp.writeUIntLE(599, 27, 3);
    expect(imageSizeOf(webp)).toEqual({ w: 800, h: 600, type: 'webp' });
    expect(imageSizeOf(Buffer.from('not an image at all, just text'))).toBeNull();
    // measured in Claude Code 2.1: ~1 token per 880 px, capped at ~1.3 megapixels (~1.5k tokens)
    expect(estimateImageTokens(400, 250)).toBe(114);
    expect(estimateImageTokens(1000, 625)).toBe(710);
    expect(estimateImageTokens(2400, 1500)).toBe(estimateImageTokens(1568, 980));
    expect(estimateImageTokens(2400, 1500)).toBeGreaterThan(1400);
    expect(estimateImageTokens(2400, 1500)).toBeLessThan(1550);
  });

  it('decodes every PNG filter type and shrinks with area averaging', () => {
    const w = 64;
    const h = 40;
    const stride = w * 3;
    const px = new Uint8Array(stride * h);
    for (let i = 0; i < px.length; i++) px[i] = (i * 7 + (i >> 5) * 13) & 0xff;
    // encode by hand with a different filter on each row: None, Sub, Up, Average, Paeth
    const raw = Buffer.alloc((stride + 1) * h);
    const paeth = (a: number, b: number, c: number) => {
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    };
    for (let y = 0; y < h; y++) {
      const f = y % 5;
      raw[y * (stride + 1)] = f;
      for (let x = 0; x < stride; x++) {
        const cur = px[y * stride + x];
        const a = x >= 3 ? px[y * stride + x - 3] : 0;
        const b = y > 0 ? px[(y - 1) * stride + x] : 0;
        const c = x >= 3 && y > 0 ? px[(y - 1) * stride + x - 3] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        raw[y * (stride + 1) + 1 + x] = (cur - pred) & 0xff;
      }
    }
    const chunk = (t: string, d: Buffer) => {
      const head = Buffer.alloc(8);
      head.writeUInt32BE(d.length, 0);
      head.write(t, 4, 'latin1');
      return Buffer.concat([head, d, Buffer.alloc(4)]); // CRC is not checked by the decoder
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0);
    ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const file = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
    const dec = decodePng(file)!;
    expect(dec.w).toBe(64);
    expect(Buffer.from(dec.data).equals(Buffer.from(px))).toBe(true);
    // our own encoder round-trips
    expect(Buffer.from(decodePng(encodePng(dec))!.data).equals(Buffer.from(px))).toBe(true);
    // 16-bit and interlaced PNGs are declined (left untouched), not mangled
    const deep = Buffer.from(file);
    deep[8 + 8 + 8] = 16;
    expect(decodePng(deep)).toBeNull();

    const solid = shrinkImage({ w: 400, h: 200, channels: 3, data: new Uint8Array(400 * 200 * 3).fill(90) }, 100);
    expect([solid.w, solid.h]).toEqual([100, 50]);
    expect(new Set(solid.data)).toEqual(new Set([90]));
    const checker = decodePng(fs.readFileSync(pngFile(path.join(tmp, 'chk.png'), 160, 160, 'checker')))!;
    const small = shrinkImage(checker, 20); // 8x8 blocks averaged over a 2x2 block grid -> mid grey
    const mean = small.data.reduce((a, b) => a + b, 0) / small.data.length;
    expect(Math.abs(mean - 130)).toBeLessThan(12);
    expect(shrinkImage(checker, 4000)).toBe(checker); // never upscales
  });
});

describe('image reads: shrink and de-duplicate', () => {
  const setup = (name: string, w = 2400, h = 1500) => {
    const cwd = path.join(tmp, name);
    fs.mkdirSync(cwd);
    const img = pngFile(path.join(cwd, 'shot.png'), w, h);
    return { cwd, img };
  };

  it('reads a shrunken copy of a big image from the scratchpad, the full one on request, and skips a repeat', async () => {
    const { cwd, img } = setup('imgs');
    const first = await preRead('m1', cwd, img);
    const out = first.hookSpecificOutput;
    expect(out.permissionDecision).toBeUndefined(); // no permission bypass: only the path changes
    const copy: string = out.updatedInput.file_path;
    expect(copy.startsWith(scratch())).toBe(true);
    expect(imageSizeOfFile(copy)).toMatchObject({ w: 1200, h: 750 });
    expect(imageSizeOfFile(img)).toMatchObject({ w: 2400, h: 1500 }); // the original is untouched
    expect(out.additionalContext).toMatch(/shrunk to 1200x750.*repeat the same Read/);
    const act = readActivity().find((a: any) => a.kind === 'media' && /Shrunk/.test(a.msg)) as any;
    expect(act.tokens).toBeGreaterThanOrEqual(250);
    await postRead('m1', cwd, copy);
    // Repeating the Read asks for the full-size image: allowed untouched.
    expect(await preRead('m1', cwd, img)).toBeNull();
    await postRead('m1', cwd, img);
    // Now it is in context at full size: a third Read is a pure repeat.
    const third = await preRead('m1', cwd, img);
    expect(third.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(third.hookSpecificOutput.permissionDecisionReason).toMatch(/already in your context/);
    expect(await preRead('m1', cwd, img)).toBeNull(); // asked again: allowed
    // After compaction the context is gone: shrinking starts over.
    await runHook('pre-compact', { session_id: 'm1', cwd });
    expect((await preRead('m1', cwd, img)).hookSpecificOutput.updatedInput.file_path).toBe(copy); // cached copy reused
  });

  it('leaves small images, files outside the project and disabled setups alone; skips only true repeats', async () => {
    const { cwd, img } = setup('imgs2', 1000, 625);
    expect(await preRead('m2', cwd, img)).toBeNull(); // 710 tokens: nothing to save
    await postRead('m2', cwd, img);
    const again = await preRead('m2', cwd, img);
    expect(again.hookSpecificOutput.permissionDecision).toBe('deny');
    await new Promise((r) => setTimeout(r, 15));
    fs.appendFileSync(img, Buffer.alloc(1)); // edited on disk: not a repeat
    expect(await preRead('m2', cwd, img)).toBeNull();
    const outside = pngFile(path.join(tmp, 'elsewhere', 'big.png'), 2400, 1500);
    expect(await preRead('m3', cwd, outside)).toBeNull(); // outside the project: normal permission flow
    const { cwd: cwd2, img: img2 } = setup('imgs3');
    const { setConfigValue } = await import('../src/config.js');
    expect(() => setConfigValue('mediaGuard.imageMaxEdge', '100')).toThrow(/0 \(never shrink\) or between 512 and 4096/);
    setConfigValue('mediaGuard.imageMaxEdge', '0');
    expect(await preRead('m4', cwd2, img2)).toBeNull();
    setConfigValue('mediaGuard.dedupeImageReads', 'false');
    await postRead('m4', cwd2, img2);
    expect(await preRead('m4', cwd2, img2)).toBeNull();
    setConfigValue('mediaGuard.enabled', 'false');
    setConfigValue('mediaGuard.dedupeImageReads', 'true');
    expect(await preRead('m4', cwd2, img2)).toBeNull();
  });

  it('shrinks other formats through sips/ImageMagick when present, and is silent when nothing can', async () => {
    const cwd = path.join(tmp, 'jpgs');
    fs.mkdirSync(cwd);
    const jpg = path.join(cwd, 'photo.jpg');
    const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x05, 0xdc, 0x09, 0x60, 0x03, 0x01, 0x11, 0x00]); // 2400x1500
    fs.writeFileSync(jpg, Buffer.concat([head, Buffer.alloc(2000)]));
    expect(imageSizeOfFile(jpg)).toMatchObject({ w: 2400, h: 1500, type: 'jpeg' });
    expect(await preRead('j1', cwd, jpg)).toBeNull(); // no tool: left alone
    stubBin({ sips: 'while [ $# -gt 0 ]; do case "$1" in --out) out="$2";; esac; last="$1"; shift; done; cp "$src" "$out" 2>/dev/null || true; :', });
    // stub that copies the file (first non-flag arg after -Z N)
    stubBin({ sips: 'src="$3"; out="$5"; cp "$src" "$out"' });
    const r = await preRead('j2', cwd, jpg);
    expect(r.hookSpecificOutput.updatedInput.file_path).toMatch(/grug-img-.*\.jpg$/);
    expect(fs.existsSync(r.hookSpecificOutput.updatedInput.file_path)).toBe(true);
  });
});

describe('screenshot guard', () => {
  const shot = (sid: string, cwd: string, name = 'mcp__browser__take_screenshot', input: any = {}) => runHook('pre-tool', { session_id: sid, cwd, tool_name: name, tool_input: input }) as Promise<any>;
  const done = (sid: string, cwd: string, name = 'mcp__browser__take_screenshot', input: any = {}) =>
    runHook('post-tool', { session_id: sid, cwd, tool_name: name, tool_input: input, tool_response: { content: [{ type: 'image', mimeType: 'image/png', data: fakeImageB64(1568, 980) }] } }) as Promise<any>;
  const act = (sid: string, cwd: string, name: string, input: any = {}) => runHook('post-tool', { session_id: sid, cwd, tool_name: name, tool_input: input, tool_response: { content: [{ type: 'text', text: 'ok' }] } });
  const cwd = () => {
    const c = path.join(tmp, 'web');
    fs.mkdirSync(c, { recursive: true });
    return c;
  };

  it('skips an identical screenshot when nothing changed, allows it after a change or when asked again', async () => {
    const c = cwd();
    expect(await shot('s1', c)).toBeNull();
    const g: any = await done('s1', c);
    expect(g.hookSpecificOutput.additionalContext).toMatch(/text\/DOM snapshot/); // one-time hint
    expect(((await done('s1', c)) as any)?.hookSpecificOutput).toBeUndefined(); // only once
    await act('s1', c, 'mcp__browser__browser_snapshot'); // read-only: page unchanged
    const denied = await shot('s1', c);
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denied.hookSpecificOutput.permissionDecisionReason).toMatch(/nothing has changed since your identical screenshot/);
    expect(await shot('s1', c)).toBeNull(); // asked again: allowed
    const saved = (readActivity().filter((a: any) => a.kind === 'media') as any[])[0];
    expect(saved.tokens).toBeGreaterThan(1500); // ~1.5k image + call overhead

    await done('s1', c);
    await act('s1', c, 'mcp__browser__browser_click', { ref: 'e5' }); // the page changed
    expect(await shot('s1', c)).toBeNull();
    await done('s1', c);
    await runHook('post-tool', { session_id: 's1', cwd: c, tool_name: 'Edit', tool_input: { file_path: path.join(c, 'a.css') } }); // code changed
    expect(await shot('s1', c)).toBeNull();
    await done('s1', c);
    await runHook('post-tool', { session_id: 's1', cwd: c, tool_name: 'Bash', tool_input: { command: 'npm run build' } });
    expect(await shot('s1', c)).toBeNull();
  });

  it('treats different requests, stale shots and other sessions/contexts as new', async () => {
    const c = cwd();
    await done('s2', c, 'mcp__browser__take_screenshot', { fullPage: true });
    expect(await shot('s2', c, 'mcp__browser__take_screenshot', { fullPage: false })).toBeNull(); // different request
    expect((await shot('s2', c, 'mcp__browser__take_screenshot', { fullPage: true })).hookSpecificOutput.permissionDecision).toBe('deny');
    // computer-use style: the action decides
    await done('s3', c, 'mcp__computer__computer', { action: 'screenshot' });
    await act('s3', c, 'mcp__computer__computer', { action: 'left_click', coordinate: [1, 2] });
    expect(await shot('s3', c, 'mcp__computer__computer', { action: 'screenshot' })).toBeNull();
    // older than two minutes the page may have changed on its own
    const file = path.join(paths.sessions(), 's4.jsonl');
    fs.mkdirSync(paths.sessions(), { recursive: true });
    await done('s4', c);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"ts":\d+/g, `"ts":${Date.now() - 5 * 60000}`));
    expect(await shot('s4', c)).toBeNull();
    // after compaction the earlier screenshot is out of context
    await done('s5', c);
    await runHook('pre-compact', { session_id: 's5', cwd: c });
    expect(await shot('s5', c)).toBeNull();
    expect((((await done('s5', c)) as any)?.hookSpecificOutput?.additionalContext || '')).toMatch(/snapshot/); // hint again in the new context
    const { setConfigValue } = await import('../src/config.js');
    setConfigValue('mediaGuard.dedupeScreenshots', 'false');
    expect(await shot('s5', c)).toBeNull();
  });

  it('tells the user (only) when images pile up in the context, once per level', async () => {
    await quietSummary();
    const c = cwd();
    const t = path.join(tmp, 'imgs.jsonl');
    fs.writeFileSync(t, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'z', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, cache_read_input_tokens: 60000, output_tokens: 5 } } }) + '\n');
    for (let i = 0; i < 12; i++) await done('s6', c, 'mcp__browser__take_screenshot', { i });
    const ask = (p: string) => runHook('user-prompt', { session_id: 's6', cwd: c, transcript_path: t, prompt: p }) as Promise<any>;
    expect((await ask('and now check the login page layout again'))?.systemMessage).toBeUndefined(); // 12 x ~1.5k < 20k
    for (let i = 12; i < 15; i++) await done('s6', c, 'mcp__browser__take_screenshot', { i });
    const out = await ask('and now check the login page layout again');
    expect(out.systemMessage).toMatch(/15 images\/screenshots \(~2\dk tokens.*re-read on every reply.*\/clear/);
    expect(JSON.stringify(out.hookSpecificOutput || {})).not.toMatch(/images\/screenshots/); // never sent to Claude
    expect((await ask('one more tweak to the header spacing please'))?.systemMessage).toBeUndefined();
  });
});

describe('PDFs and video', () => {
  const pdf = (name = 'report.pdf', pages = 12) => {
    const f = path.join(tmp, 'docs', name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `%PDF-1.4\n1 0 obj << /Type /Pages /Kids [] /Count ${pages} >> endobj\n%%EOF`);
    return f;
  };
  const PDFTOTEXT = `while [ $# -gt 0 ]; do case "$1" in -f) f="$2"; shift;; -l) l="$2"; shift;; esac; shift; done
i=$f; while [ $i -le $l ]; do if [ $i -eq 3 ]; then printf '  \\n'; else printf 'Page %s ledger balances reconcile against the bank statement totals.\\nSecond line of page %s with more words to read.\\n' $i $i; fi; printf '\\f'; i=$((i+1)); done`;

  it('points big PDF page reads at the text tool once, and leaves small ones alone', async () => {
    const f = pdf();
    const cwd = path.join(tmp, 'pdfs');
    fs.mkdirSync(cwd);
    expect(await preRead('p0', cwd, f, { pages: '1-10' })).toBeNull(); // no pdftotext: nothing better to offer
    stubBin({ pdftotext: PDFTOTEXT });
    const d = await preRead('p1', cwd, f, { pages: '1-10' });
    expect(d.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(d.hookSpecificOutput.permissionDecisionReason).toMatch(/12 pages.*asks for 10.*pdf_text.*repeat the same Read/);
    expect(await preRead('p1', cwd, f, { pages: '1-10' })).toBeNull(); // repeat: allowed
    expect(await preRead('p1', cwd, f, { pages: '2-3' })).toBeNull(); // small request
    expect(await preRead('p1', cwd, f, { pages: '5' })).toBeNull();
    expect((await preRead('p2', cwd, f, {}))?.hookSpecificOutput.permissionDecision).toBe('deny'); // whole 12-page PDF
  });

  it('pdf_text returns page text, flags image-only pages and reports the saving', () => {
    stubBin({ pdftotext: PDFTOTEXT });
    const f = pdf();
    const r = handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'pdf_text', arguments: { path: f, pages: '2-5' } } });
    const text: string = r.result.content[0].text;
    expect(text).toContain('12 pages, showing 2-5');
    expect(text).toContain('--- page 2 ---\nPage 2 ledger balances reconcile');
    expect(text).toContain('--- page 3 ---\n(no text: scan or figure)');
    expect(text).toMatch(/Read these as images with pages="N": 3\./);
    expect(text).toMatch(/7 more page\(s\) after 5; ask for pages="6-12"/);
    const saved = (readActivity().find((a: any) => a.kind === 'media' && /pdf_text/.test(a.msg)) as any).tokens;
    expect(saved).toBeGreaterThan(4000);
    // without poppler the tool says how to get it instead of failing
    process.env.PATH = '/usr/bin:/bin';
    const none = handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'pdf_text', arguments: { path: f } } });
    expect(none.result.content[0].text).toMatch(/pdftotext is not installed.*Read with a pages range/);
  });

  it('turns a video Read into a frame-sheet suggestion, and video_frames returns one image via MCP', async () => {
    const cwd = path.join(tmp, 'vids');
    fs.mkdirSync(cwd);
    const v = path.join(cwd, 'demo.mp4');
    fs.writeFileSync(v, Buffer.alloc(5000));
    const noff = await preRead('v0', cwd, v);
    expect(noff.hookSpecificOutput.permissionDecisionReason).toMatch(/ffmpeg is not installed/);
    stubBin({
      ffprobe: 'echo 12.5',
      ffmpeg: 'for a; do last="$a"; done; printf "FAKEJPEGDATA" > "$last"'
    });
    const d = await preRead('v1', cwd, v);
    expect(d.hookSpecificOutput.permissionDecisionReason).toMatch(/video_frames/);
    expect(await preRead('v1', cwd, v)).toBeNull(); // repeat allowed
    const r = handleMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'video_frames', arguments: { path: v, count: 4 } } });
    const [text, img] = r.result.content;
    expect(text.text).toMatch(/demo\.mp4, 12\.5 s: contact sheet of 4 frames/);
    expect(text.text).toContain('Frame times (s): 1.6, 4.7, 7.8, 10.9');
    expect(img).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(Buffer.from(img.data, 'base64').toString()).toBe('FAKEJPEGDATA');
    expect(readActivity().some((a: any) => a.kind === 'media' && /video_frames/.test(a.msg))).toBe(true);
  });

  it('media_info says what a file costs and the cheapest way in', () => {
    const info = (p: string) => handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'media_info', arguments: { path: p } } }).result.content[0].text as string;
    const big = pngFile(path.join(tmp, 'mi', 'big.png'), 2400, 1500);
    expect(info(big)).toMatch(/png 2400x1500.*≈ 1\d\d\d tokens.*shrunk to 1200px/);
    expect(info(pdf('a.pdf', 20))).toMatch(/20 pages.*30000–60000 tokens.*as text ≈ 10000/);
    expect(info(path.join(tmp, 'nope.png'))).toMatch(/No such file/);
    const list = handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/list' }).result.tools.map((t: any) => t.name);
    expect(list).toEqual(expect.arrayContaining(['pdf_text', 'video_frames', 'media_info']));
  });
});

describe('media wiring', () => {
  it('registers the hooks for MCP tools too, and shows media savings on the dashboard', async () => {
    installClaudeCode(false);
    const s = JSON.parse(fs.readFileSync(path.join(tmp, '.claude', 'settings.json'), 'utf8'));
    expect(s.hooks.PreToolUse[0].matcher).toBe('Read|Grep|mcp__.*');
    expect(s.hooks.PostToolUse[0].matcher).toContain('mcp__.*');
    const { recordActivity } = await import('../src/stats.js');
    recordActivity({ kind: 'media', msg: 'Skipped a repeat screenshot', tokens: 1800 });
    recordActivity({ kind: 'media', msg: 'Shrunk shot.png', tokens: 700 });
    const { renderOnce } = await import('../src/tui/dashboard.js');
    const dash = renderOnce({ tab: 1 } as any, 160, 80).replace(/\u001b\[[0-9;]*m/g, '');
    expect(dash).toMatch(/media: repeats skipped\/shrunk.*~2500 tok.*2×/);
    const { setConfigValue } = await import('../src/config.js');
    expect(() => setConfigValue('mediaGuard.imageAlertTokens', '100')).toThrow(/0 \(off\) or between 5000 and 500000/);
    expect(() => setConfigValue('mediaGuard.pdfPages', '0')).toThrow(/between 1 and 100/);
  });
});

// ---------------------------------------------------------------- v2.11 features: graph-first hints, adoption, /clear help
import { grepSymbol } from '../src/navhint.js';
import { looksLikeNewTask } from '../src/taskshift.js';
import { analyzeTranscript, topConsumers } from '../src/ctxbreak.js';

function bigCodeProject(name: string) {
  const cwd = path.join(tmp, name);
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}');
  let body = '';
  for (let i = 0; i < 150; i++) body += `export function orderHelper${i}(a: number, b: number) {\n  const total = a * ${i + 2} + b;\n  const discount = total > ${i * 10} ? total - ${i} : total + ${i};\n  const rounded = Math.round(discount * 100) / 100;\n  if (rounded < 0) throw new Error('negative total for helper ${i}');\n  const label = 'order-helper-${i}-' + String(rounded);\n  return { label, rounded, total, discount };\n}\n\n`;
  body += `export function reconcileRefundLedger(entries: Array<{ id: string; cents: number }>) {\n  const byId = new Map<string, number>();\n  for (const e of entries) byId.set(e.id, (byId.get(e.id) || 0) + e.cents);\n  return [...byId.keys()];\n}\n`;
  fs.writeFileSync(path.join(cwd, 'src', 'orders.ts'), body);
  fs.writeFileSync(path.join(cwd, 'src', 'tiny.ts'), 'export const tiny = 1;\n');
  return { cwd, big: path.join(cwd, 'src', 'orders.ts'), tiny: path.join(cwd, 'src', 'tiny.ts') };
}

describe('graph-first hints', () => {
  const pre = (sid: string, cwd: string, tool: string, input: any) => runHook('pre-tool', { session_id: sid, cwd, tool_name: tool, tool_input: input }) as Promise<any>;

  it('extracts the symbol a Grep is looking for', () => {
    expect(grepSymbol('reconcileRefundLedger')).toBe('reconcileRefundLedger');
    expect(grepSymbol('\\breconcileRefundLedger\\b')).toBe('reconcileRefundLedger');
    expect(grepSymbol('function reconcileRefundLedger')).toBe('reconcileRefundLedger');
    expect(grepSymbol('reconcileRefundLedger\\(')).toBe('reconcileRefundLedger');
    expect(grepSymbol('TODO|FIXME')).toBeNull();
    expect(grepSymbol('foo.*bar')).toBeNull();
    expect(grepSymbol('ab')).toBeNull();
  });

  it('tells Claude where a searched symbol lives without blocking the search, once', async () => {
    const { buildGraphIndex } = await import('../src/graph.js');
    const { cwd } = bigCodeProject('nav1');
    buildGraphIndex(cwd);
    const out = await pre('n1', cwd, 'Grep', { pattern: 'reconcileRefundLedger' });
    const h = out.hookSpecificOutput;
    expect(h.permissionDecision).toBeUndefined(); // the search still runs
    expect(h.additionalContext).toMatch(/`reconcileRefundLedger` is defined at src\/orders\.ts L\d+-\d+/);
    expect(await pre('n1', cwd, 'Grep', { pattern: 'reconcileRefundLedger' })).toBeNull(); // once
    expect(await pre('n1', cwd, 'Grep', { pattern: 'noSuchSymbolAnywhere' })).toBeNull();
    expect(await pre('n1', cwd, 'Grep', { pattern: 'orders|cart' })).toBeNull();
    const { setConfigValue } = await import('../src/config.js');
    setConfigValue('graphContext.hints', 'false');
    expect(await pre('n2', cwd, 'Grep', { pattern: 'orderHelper5' })).toBeNull();
  });

  it('suggests the outline once before a full read of a mid-size code file, never for small, ranged or worked-on files', async () => {
    const { cwd, big, tiny } = bigCodeProject('nav2');
    const d = await pre('n3', cwd, 'Read', { file_path: big });
    expect(d.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(d.hookSpecificOutput.permissionDecisionReason).toMatch(/orders\.ts is ~\d+ tokens; its outline is only ~\d+.*offset\/limit.*(satisfies Edit).*repeat the same Read/);
    expect(await pre('n3', cwd, 'Read', { file_path: big })).toBeNull(); // repeat allowed
    expect(await pre('n4', cwd, 'Read', { file_path: big, offset: 10, limit: 40 })).toBeNull(); // ranged
    expect(await pre('n4', cwd, 'Read', { file_path: tiny })).toBeNull(); // small
    await runHook('post-tool', { session_id: 'n5', cwd, tool_name: 'Edit', tool_input: { file_path: big } });
    expect(await pre('n5', cwd, 'Read', { file_path: big })).toBeNull(); // being edited: needs the real file
    const { setConfigValue } = await import('../src/config.js');
    expect(() => setConfigValue('graphContext.readHintBytes', '100')).toThrow(/0 \(off\) or between 4000 and 60000/);
    setConfigValue('graphContext.readHintBytes', '0');
    expect(await pre('n6', cwd, 'Read', { file_path: big })).toBeNull();
  });

  it('counts what Claude uses, and whether a hint was followed by a ranged read', async () => {
    const { buildGraphIndex } = await import('../src/graph.js');
    const { loadAdoption } = await import('../src/adoption.js');
    const { cwd, big } = bigCodeProject('nav3');
    buildGraphIndex(cwd);
    await runHook('session-start', { session_id: 'a1', cwd, source: 'startup' });
    const use = (tool: string, input: any) => runHook('post-tool', { session_id: 'a1', cwd, tool_name: tool, tool_input: input, tool_response: { content: [] } });
    await pre('a1', cwd, 'Grep', { pattern: 'reconcileRefundLedger' }); // hint shown
    await use('Grep', { pattern: 'reconcileRefundLedger' });
    await use('Read', { file_path: big, offset: 1, limit: 20 }); // followed
    await use('Glob', { pattern: '**/*.ts' });
    await use('mcp__grugbrain__outline', { path: big });
    await use('Read', { file_path: path.join(cwd, 'package.json') });
    await runHook('pre-compact', { session_id: 'a1', cwd });
    await runHook('session-end', { session_id: 'a1', cwd }); // second scoring adds nothing
    expect(loadAdoption()).toMatchObject({ grug: 1, read: 2, grep: 1, glob: 1, navShown: 1, navFollowed: 1 });
    const { renderOnce } = await import('../src/tui/dashboard.js');
    expect(renderOnce({ tab: 1 } as any, 160, 80).replace(/\u001b\[[0-9;]*m/g, '')).toMatch(/graph-first hints.*100% followed by a ranged read; grug tools 1 vs Read\/Grep\/Glob 4/);
  });
});

describe('what fills the context, and when to /clear', () => {
  const asst = (content: any[], ts = new Date().toISOString()) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id: 'x' + Math.random(), model: 'claude-opus-5-5', content, usage: { input_tokens: 5, cache_read_input_tokens: 90000, output_tokens: 5 } } });
  const user = (content: any) => JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content } });
  const call = (id: string, name: string, input: any) => asst([{ type: 'tool_use', id, name, input }]);
  const result = (id: string, text: string) => user([{ type: 'tool_result', tool_use_id: id, content: text }]);

  it('breaks a transcript down by kind and names the biggest items', () => {
    const t = path.join(tmp, 'brk.jsonl');
    fs.writeFileSync(t, [
      user('please look at the failing build'),
      call('t1', 'Bash', { command: 'npm run build' }),
      result('t1', 'error TS2322 '.repeat(2000)),
      call('t2', 'Read', { file_path: 'a.ts' }),
      result('t2', 'const a = 1;\n'.repeat(500)),
      asst([{ type: 'text', text: 'The build fails because of a type error in a.ts.' }, { type: 'thinking', thinking: 'hmm '.repeat(50) }]),
      JSON.stringify({ type: 'user', isCompactSummary: true, timestamp: new Date().toISOString(), message: { role: 'user', content: 'summary of everything before' } }),
      call('t3', 'Bash', { command: 'ls' }),
      result('t3', 'x'.repeat(30000))
    ].join('\n') + '\n');
    const b = analyzeTranscript(t);
    expect(b.buckets[0].label).toBe('Bash results'); // only what is after the compaction summary
    expect(b.buckets.some((x) => x.label === 'Read results')).toBe(false);
    expect(b.buckets.find((x) => x.label === 'Bash results')!.tokens).toBeGreaterThan(6000);
    expect(b.biggest[0].label).toMatch(/^Bash results/);
    expect(topConsumers(b)).toMatch(/^Bash results \d+%/);
    expect(analyzeTranscript(path.join(tmp, 'missing.jsonl')).total).toBe(0);
    // the same transcript without a compaction summary shows the earlier Bash and Read output too
    fs.writeFileSync(t, fs.readFileSync(t, 'utf8').split('\n').filter((l) => !l.includes('isCompactSummary')).join('\n'));
    expect(analyzeTranscript(t).buckets.map((x) => x.label)).toEqual(expect.arrayContaining(['Bash results', 'Read results', 'Claude thinking', 'your messages']));
  });

  it('says what fills the context in the size alert', async () => {
    const cwd = path.join(tmp, 'alertwhy');
    fs.mkdirSync(cwd);
    const t = path.join(tmp, 'alertwhy.jsonl');
    fs.mkdirSync(paths.home(), { recursive: true });
    fs.writeFileSync(paths.config(), JSON.stringify({ autoCompact: { windowTokens: 0 } }));
    fs.writeFileSync(t, [call('q1', 'Bash', { command: 'npm test' }), result('q1', 'FAIL '.repeat(20000)), asst([{ type: 'text', text: 'ok' }])].join('\n') + '\n');
    await runHook('session-start', { session_id: 'w1', cwd, source: 'startup' });
    fs.appendFileSync(t, asst([{ type: 'text', text: 'again' }]).replace('90000', '400000') + '\n');
    const out: any = await runHook('user-prompt', { session_id: 'w1', cwd, transcript_path: t, prompt: 'add coupon support to checkout' });
    expect(out.systemMessage).toMatch(/Mostly: Bash results \d+%/);
  });

  it('suggests /clear on a new task with a big context, but not on follow-ups or small contexts', async () => {
    const cwd = path.join(tmp, 'shift');
    fs.mkdirSync(cwd);
    const { loadConfig, saveConfig } = await import('../src/config.js');
    const c0 = loadConfig();
    c0.appSummary.enabled = false; // this test is about the task-shift notice only
    saveConfig(c0);
    const t = path.join(tmp, 'shift.jsonl');
    const at = (ctx: number) => fs.writeFileSync(t, asst([{ type: 'text', text: 'ok' }]).replace('90000', String(ctx)) + '\n');
    at(120000);
    await runHook('session-start', { session_id: 'x1', cwd, source: 'startup' });
    const ask = (p: string) => runHook('user-prompt', { session_id: 'x1', cwd, transcript_path: t, prompt: p }) as Promise<any>;
    for (const p of ['fix the stripe webhook retry handling in the payments worker', 'the webhook signature check still fails for retried events', 'add a test for the stripe webhook retry path']) expect((await ask(p))?.systemMessage).toBeUndefined();
    // follow-ups of the same work
    for (const p of ['also make the retry delay configurable in the payments worker', 'and update the readme section for the stripe webhook', 'now run the webhook tests again']) expect((await ask(p))?.systemMessage).toBeUndefined();
    const shift = await ask('translate the onboarding email templates into spanish and german');
    expect(shift.systemMessage).toMatch(/looks like a new task.*120k tokens.*\/clear.*Ignore this if it continues/);
    expect(JSON.stringify(shift.hookSpecificOutput || {})).not.toMatch(/new task/); // never sent to Claude
    expect((await ask('rewrite the pricing page copy for the annual plan discount'))?.systemMessage).toBeUndefined(); // not again right away
    expect(readActivity().some((a: any) => a.kind === 'task-shift')).toBe(true);
    at(30000);
    expect((await runHook('user-prompt', { session_id: 'x2', cwd, transcript_path: t, prompt: 'design a database schema for the loyalty points ledger' }) as any)?.systemMessage).toBeUndefined();
  });

  it('classifies topic switches vs continuations on a labelled set', () => {
    const base = ['refactor the checkout cart totals to use integer cents', 'the coupon discount is applied after tax, fix the order of operations', 'add unit tests for the cart totals module'].map((text, i) => ({ t: 'prompt' as const, ts: i, text }));
    const files = [{ t: 'file' as const, ts: 9, path: '/x/src/cart.ts', op: 'edit' as const }];
    const events = [...base, ...files];
    const same = [
      'also handle the rounding for the shipping cost in the cart',
      'the totals still look wrong when a coupon is combined with tax',
      'can you add a test for negative cart totals',
      'update the checkout totals docs to mention integer cents',
      'now run the cart tests',
      'why does the coupon code get applied twice'
    ];
    const other = [
      'write a bash script that backs up the postgres database every night',
      'explain how kubernetes ingress controllers route traffic',
      'draft a changelog entry announcing the new dark mode theme',
      'set up eslint and prettier for the frontend monorepo',
      'generate a python script that resizes all the marketing photos'
    ];
    const falseAlarms = same.filter((p) => looksLikeNewTask(p, events));
    const hits = other.filter((p) => looksLikeNewTask(p, events));
    expect(falseAlarms).toEqual([]);
    expect(hits.length).toBeGreaterThanOrEqual(4);
    expect(looksLikeNewTask('ok', events)).toBe(false);
    expect(looksLikeNewTask('write a bash script that backs up the database', base.slice(0, 2))).toBe(false); // too little history
  });

  it('gives the session brief an explicit check-memory-first instruction', async () => {
    const cwd = path.join(tmp, 'briefdir');
    fs.mkdirSync(cwd);
    seedNotes(cwd, ['Deploys go through fly.io, never from a laptop']);
    const out: any = await runHook('session-start', { session_id: 'b9', cwd, source: 'startup' });
    expect(out.hookSpecificOutput.additionalContext).toMatch(/Check these notes \(and the code map\) before re-exploring/);
  });
});

describe('command rules and JSON compaction', () => {
  it('reads MCP text-block results and ignores blocks with images', async () => {
    const { toolOutputText } = await import('../src/hooks.js');
    const base: any = { tool_name: 'mcp__x__y', tool_input: {} };
    expect(toolOutputText({ ...base, tool_response: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('a\nb');
    expect(toolOutputText({ ...base, tool_response: [{ type: 'text', text: 'a' }, { type: 'image', source: {} }] })).toBeNull();
  });
  it('drops install/build progress but keeps errors, warnings and the result', async () => {
    const { applyCommandRules } = await import('../src/compress/cmdrules.js');
    const pip = [...Array.from({ length: 40 }, (_, i) => `Collecting pkg${i}`), ...Array.from({ length: 40 }, (_, i) => `  Downloading pkg${i}-1.0.whl (12 kB)`), 'ERROR: Could not find a version that satisfies the requirement nope', 'Successfully installed a-1 b-2'].join('\n');
    const r = applyCommandRules('pip install -r req.txt', pip);
    expect(r.changed).toBe(true);
    expect(r.text).toContain('ERROR: Could not find a version');
    expect(r.text).toContain('Successfully installed a-1 b-2');
    expect(r.text).not.toContain('Collecting pkg7');
    const cargo = [...Array.from({ length: 30 }, (_, i) => `   Compiling crate${i} v1.0.0`), 'warning: unused variable: `x`', ' --> src/main.rs:3:9', '  |', '3 |     let x = 1;', '    Finished `dev` profile in 4s'].join('\n');
    const c = applyCommandRules('cargo build', cargo, 100);
    expect(c.text).toContain('warning: unused variable');
    expect(c.text).toContain('src/main.rs:3:9');
    expect(c.text).not.toContain('Compiling crate5');
  });

  it('leaves unknown commands and small output alone', async () => {
    const { applyCommandRules } = await import('../src/compress/cmdrules.js');
    const big = Array.from({ length: 200 }, (_, i) => `Collecting line ${i}`).join('\n');
    expect(applyCommandRules('echo hi', big).changed).toBe(false);
    expect(applyCommandRules('pip install x', 'Collecting a\nSuccessfully installed a').changed).toBe(false);
  });

  it('compacts big uniform JSON arrays and keeps identity of every item', async () => {
    const { compactJson } = await import('../src/compress/jsoncompact.js');
    const items = Array.from({ length: 80 }, (_, i) => ({ id: 1000 + i, number: i, title: `Issue ${i}`, state: 'open', body: null, labels: [], avatar_url: 'https://api.example.com/u/' + i, html_url: `https://example.com/i/${i}`, extra: 'x'.repeat(200) }));
    const raw = JSON.stringify(items);
    const r = compactJson(raw, 1000);
    expect(r.changed).toBe(true);
    expect(r.text.length).toBeLessThan(raw.length * 0.5);
    expect(r.text).not.toContain('avatar_url');
    expect(r.text).toContain('title=Issue 79');
    expect(r.text).toContain('html_url');
  });

  it('does not touch JSON it cannot summarise safely', async () => {
    const { compactJson } = await import('../src/compress/jsoncompact.js');
    expect(compactJson(JSON.stringify(Array.from({ length: 3000 }, (_, i) => i)), 100).changed).toBe(false);
    expect(compactJson('{"a":' + '1,'.repeat(10) + '"not json', 10).changed).toBe(false);
    expect(compactJson(JSON.stringify({ a: { b: 'x'.repeat(20000) } })).changed).toBe(false);
  });
});

describe('savings headline, visuals, status line', () => {
  it('computes a conservative net savings percentage', async () => {
    const { recordRequest, recordActivity } = await import('../src/stats.js');
    const { computeSavings } = await import('../src/savings.js');
    expect(computeSavings().pct).toBe(0);
    recordRequest({ ts: Date.now(), model: 'claude-opus-5-5', usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 200000, cache_creation_input_tokens: 0 }, status: 200, trimmedTokens: 0, cacheBreakpointsAdded: 0 });
    recordActivity({ kind: 'cmdrules', msg: 'x', tokens: 50000 });
    recordActivity({ kind: 'brief', msg: 'cost', tokens: -10000 });
    const s = computeSavings();
    const price = 4 / 1e6;
    expect(s.savedUsd).toBeCloseTo(50000 * price, 5);
    expect(s.costUsd).toBeCloseTo(10000 * price, 5);
    expect(s.netUsd).toBeCloseTo(40000 * price, 5);
    expect(s.pct).toBeCloseTo(s.netUsd / (s.spendUsd + s.netUsd), 6);
    expect(s.parts.find((p) => p.key === 'cmdrules')?.count).toBe(1);
  });

  it('draws big digits and a donut of the right size', async () => {
    const { bigText, donut, ease } = await import('../src/tui/visual.js');
    const b = bigText('34%');
    expect(b).toHaveLength(5);
    expect(b[0].length).toBeGreaterThanOrEqual(10);
    const d = donut([{ value: 3, color: 1 }, { value: 1, color: 2 }], 20, 10, 0.25).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    expect(d).toHaveLength(10);
    expect(d.every((l) => [...l].length === 20)).toBe(true);
    expect(d.join('')).toMatch(/[⠁-⣿]/);
    expect(ease(0, 10)).toBeGreaterThan(0);
    expect(ease(9.9999, 10)).toBe(10);
  });

  it('dashboard shows the headline, live strip and the new features', async () => {
    const { recordActivity } = await import('../src/stats.js');
    recordActivity({ kind: 'cmdrules', msg: 'Dropped pip progress noise', tokens: 800 });
    recordActivity({ kind: 'json', msg: 'Compacted JSON', tokens: 2000 });
    const { renderOnce } = await import('../src/tui/dashboard.js');
    const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
    const o = strip(renderOnce({ tab: 0 } as any, 160, 80));
    expect(o).toContain('GRUG SAVED');
    expect(o).toContain('LIVE');
    const sv = strip(renderOnce({ tab: 1 } as any, 160, 80));
    expect(sv).toMatch(/install\/build noise dropped\s+~800 tok/);
    expect(sv).toMatch(/compacted big JSON results\s+~2000 tok/);
    expect(sv).toContain('IN THE CLAUDE APP');
  });

  it('status line: clear notice, cache timer, tips, and never throws', async () => {
    const { composeLine, renderStatusLine } = await import('../src/statusline.js');
    const strip = (t: string) => t.replace(/\x1b\[[0-9;]*m/g, '');
    const base = { model: 'claude-opus-5-5', idleMs: 1000, oneHour: false, windowTokens: 200000, firstTokens: 150000, tips: true, now: 1000 };
    expect(strip(composeLine({ ...base, tokens: 170000 }))).toMatch(/⚠ context growing: \/clear/);
    expect(strip(composeLine({ ...base, tokens: 300000 }))).toMatch(/\/clear when this task is done/);
    expect(strip(composeLine({ ...base, tokens: 100000, idleMs: 5 * 60000 - 20000 }))).toMatch(/cache expires in 20s/);
    expect(strip(composeLine({ ...base, tokens: 100000, idleMs: 6 * 60000 }))).toMatch(/cache cold: next reply re-writes 100k/);
    const calm = strip(composeLine({ ...base, tokens: 20000, savedPct: 0.31 }));
    expect(calm).toMatch(/Tip:/);
    expect(calm).toContain('saved ~31%');
    expect(strip(composeLine({ ...base, tokens: 20000, tips: false }))).not.toMatch(/Tip:/);
    expect(strip(composeLine({ ...base, tokens: 20000, model: 'claude-sonnet-5-5', now: 0 }))).not.toMatch(/\/model sonnet/);
    expect(() => renderStatusLine('not json')).not.toThrow();
    expect(() => renderStatusLine('{"transcript_path":"/nope"}')).not.toThrow();
  });

  it('install puts the status line in, wraps the user\'s own, and restores it', async () => {
    const { applyStatusLine } = await import('../src/install.js');
    const { defaultConfig } = await import('../src/config.js');
    const cfg = defaultConfig();
    const state: any = {};
    const settings: any = { statusLine: { type: 'command', command: 'echo mine' } };
    applyStatusLine(settings, cfg, state);
    expect(settings.statusLine.command).toContain(MARK);
    expect(state.prevStatusLine.command).toBe('echo mine');
    expect(cfg.statusLine.wrap).toBe('echo mine');
    applyStatusLine(settings, cfg, state); // idempotent
    expect(state.prevStatusLine.command).toBe('echo mine');
    cfg.statusLine.enabled = false;
    applyStatusLine(settings, cfg, state);
    expect(settings.statusLine.command).toBe('echo mine');
    const empty: any = {};
    cfg.statusLine.enabled = true;
    applyStatusLine(empty, cfg, {} as any);
    expect(empty.statusLine.command).toContain('statusline');
    cfg.statusLine.enabled = false;
    applyStatusLine(empty, cfg, {} as any);
    expect(empty.statusLine).toBeUndefined();
  });
});

describe('status line panel', () => {
  it('draws an animated panel with a savings bar and context bar', async () => {
    const { composePanel, barCells } = await import('../src/statusline.js');
    expect(barCells(0.04, 10).trim().length).toBeGreaterThan(0);
    expect(barCells(1, 4)).toBe('████');
    const idle = composePanel({ now: 1000, active: false, savedPct: 0.04, netUsd: 2.35, tokens: 0, limit: 160000 });
    expect(idle).toContain('idle');
    expect(idle).toContain('~4%');
    const a = composePanel({ now: 1000, active: true, savedPct: 0.5, tokens: 200000, limit: 160000, recent: { ts: 1, msg: 'Trimmed npm output' } });
    const b = composePanel({ now: 2000, active: true, savedPct: 0.5, tokens: 200000, limit: 160000 });
    expect(a).toContain('working');
    expect(a).toContain('125%');
    expect(a).toContain('Trimmed npm output');
    expect(a.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 12)).not.toBe(b.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 12));
  });
  it('installs refreshInterval so the panel keeps moving', async () => {
    const { applyStatusLine } = await import('../src/install.js');
    const cfg = defaultConfig();
    const settings: any = {};
    applyStatusLine(settings, cfg, {} as any);
    expect(settings.statusLine.refreshInterval).toBe(2);
  });
});

// ---------------------------------------------------------------- v2.15 handoff v2, archive, pinned rules
describe('handoff v2', () => {
  const tool = (id: string, command: string) => line('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }]);
  const result = (id: string, text: string) => line('user', [{ type: 'tool_result', tool_use_id: id, content: text }]);

  it('reports the last check result', async () => {
    const { lastCheck } = await import('../src/handoff.js');
    const es = [tool('a', 'npm test'), result('a', 'Tests 2 failed | 10 passed\nFAIL x')].map((l) => JSON.parse(l));
    expect(lastCheck(es)).toMatch(/npm test.*FAILED/);
    const ok = [tool('b', 'npm test'), result('b', 'Tests 12 passed (12)')].map((l) => JSON.parse(l));
    expect(lastCheck(ok)).toMatch(/npm test.*passed/);
    expect(lastCheck([])).toBeNull();
  });

  it('uses the latest request as goal, keeps rules, and stays inside the budget', async () => {
    const { buildHandoff } = await import('../src/handoff.js');
    const { estimateTokens } = await import('../src/tokens.js');
    const cwd = path.join(tmp, 'hproj');
    fs.mkdirSync(cwd, { recursive: true });
    const t = writeTranscript(cwd, 'h.jsonl', [
      line('user', 'build the billing export feature for the admin page'),
      line('assistant', [{ type: 'text', text: 'Working on it. ' + 'x'.repeat(400) }]),
      tool('c', 'npm test'), result('c', 'Tests 1 failed | 4 passed')
    ]);
    const sid = 'hv2';
    appendBuffer(sid, { t: 'start', ts: Date.now(), cwd });
    appendBuffer(sid, { t: 'prompt', ts: Date.now(), text: 'build the billing export feature for the admin page' });
    appendBuffer(sid, { t: 'prompt', ts: Date.now(), text: 'never commit to main, always open a pull request' });
    appendBuffer(sid, { t: 'prompt', ts: Date.now(), text: 'now fix the csv escaping bug in the export module' });
    for (let i = 0; i < 40; i++) appendBuffer(sid, { t: 'file', ts: Date.now(), path: path.join(cwd, `src/file${i}.ts`), op: 'edit' });
    const h = buildHandoff(sid, t, cwd, 1200)!;
    expect(h.text).toContain('Goal: now fix the csv escaping bug');
    expect(h.text).toContain('Started with: build the billing export');
    expect(h.text).toContain('never commit to main');
    expect(h.text).toContain('npm test');
    expect(estimateTokens(h.text)).toBeLessThanOrEqual(1200);
    const tiny = buildHandoff(sid, t, cwd, 150)!;
    expect(tiny.text).toContain('Goal:');
    expect(estimateTokens(tiny.text)).toBeLessThanOrEqual(260);
  });
});

// ---------------------------------------------------------------- v2.19 handoff restore quality
describe('handoff restore quality (v2.19)', () => {
  const tool = (id: string, command: string, ts?: string) => line('assistant', [{ type: 'tool_use', id, name: 'Bash', input: { command } }], ts);
  const result = (id: string, text: string, ts?: string) => line('user', [{ type: 'tool_result', tool_use_id: id, content: text }], ts);
  const parse = (...ls: string[]) => ls.map((l) => JSON.parse(l));
  const iso = (ms: number) => new Date(ms).toISOString();

  const git = (cwd: string, ...a: string[]) => {
    const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
    return r.stdout;
  };
  /** A commit dated `whenMs` (git's --since looks at the committer date). */
  const gitAt = (cwd: string, whenMs: number, ...a: string[]) => {
    const d = new Date(whenMs).toISOString();
    const r = spawnSync('git', ['-c', 'user.email=t@t.t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: d, GIT_AUTHOR_DATE: d } });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  };
  function gitRepo(name: string): string {
    const cwd = path.join(tmp, name);
    fs.mkdirSync(cwd, { recursive: true });
    git(cwd, 'init', '-q', '-b', 'main');
    return cwd;
  }

  describe('squeeze', () => {
    it('keeps short prose whole and strips markdown', async () => {
      const { squeeze } = await import('../src/handoff.js');
      expect(squeeze('## Result\n\n**Done.** All green.', 200)).toBe('Result Done. All green.');
      expect(squeeze('Look:\n```ts\nconst a = 1;\n```\nThat is it.', 200)).toContain('[code]');
      expect(squeeze('- one\n- two', 200)).toBe('· one · two');
    });

    it('keeps the start and the ending of a long reply, cut at sentence boundaries', async () => {
      const { squeeze } = await import('../src/handoff.js');
      const body = Array.from({ length: 30 }, (_, i) => `Step ${i} of the long investigation found nothing odd.`).join(' ');
      const text = `Start: the parser is the problem. ${body} End: raise the buffer to 64k and ship it.`;
      const out = squeeze(text, 300);
      expect(out.length).toBeLessThanOrEqual(310);
      expect(out).toContain('Start: the parser is the problem.');
      expect(out).toContain('End: raise the buffer to 64k and ship it.');
      expect(out).toContain('[…]');
      expect(out).not.toMatch(/\w…$/); // no mid-word cut at the end
    });

    it('still keeps the end when one sentence is longer than the whole budget', async () => {
      const { squeeze } = await import('../src/handoff.js');
      const out = squeeze('word '.repeat(200) + 'final answer is 42', 120);
      expect(out.length).toBeLessThanOrEqual(130);
      expect(out).toContain('final answer is 42');
    });
  });

  describe('pendingQuestion', () => {
    it('returns the question the last reply ended on', async () => {
      const { pendingQuestion } = await import('../src/handoff.js');
      const es = parse(
        line('user', 'add the export feature'),
        line('assistant', [{ type: 'text', text: 'I can do this two ways. Which one do you want: CSV or JSON? Tell me and I start.' }])
      );
      expect(pendingQuestion(es)).toContain('CSV or JSON?');
    });

    it('is null when the last reply asked nothing', async () => {
      const { pendingQuestion } = await import('../src/handoff.js');
      const es = parse(line('user', 'add it'), line('assistant', [{ type: 'text', text: 'Done. All tests pass.' }]));
      expect(pendingQuestion(es)).toBeNull();
    });

    it('is null once the user answered, or once the assistant kept working', async () => {
      const { pendingQuestion } = await import('../src/handoff.js');
      const asked = line('assistant', [{ type: 'text', text: 'Shall I go ahead and delete the old table?' }]);
      expect(pendingQuestion(parse(asked, line('user', 'yes go ahead')))).toBeNull();
      expect(pendingQuestion(parse(asked, line('assistant', [{ type: 'tool_use', id: 'x', name: 'Bash', input: { command: 'ls' } }])))).toBeNull();
      expect(pendingQuestion(parse(asked, line('user', [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])))).toBeNull();
    });

    it('ignores injected hook text and meta entries when deciding whether the user answered', async () => {
      const { pendingQuestion } = await import('../src/handoff.js');
      const asked = line('assistant', [{ type: 'text', text: 'Want me to open the pull request?' }]);
      const injected = line('user', '<system-reminder>something injected</system-reminder>');
      expect(pendingQuestion(parse(asked, injected))).toContain('pull request?');
    });
  });

  describe('checkSegment', () => {
    it('finds the check inside compound commands and strips the noise around it', async () => {
      const { checkSegment } = await import('../src/handoff.js');
      expect(checkSegment('cd /repo && npm test 2>&1 | tail -20')).toBe('npm test');
      expect(checkSegment('git add -A && CI=1 npx vitest run tests/a.test.ts')).toBe('npx vitest run tests/a.test.ts');
      expect(checkSegment('npm run build; ls dist')).toBe('npm run build');
    });

    it('does not treat a message that merely mentions a check as a check', async () => {
      const { checkSegment } = await import('../src/handoff.js');
      expect(checkSegment('git commit -m "make npm test pass"')).toBeNull();
      expect(checkSegment('echo npm test')).toBeNull();
      expect(checkSegment('grep -rn "pytest" src')).toBeNull();
    });

    it('skips heredocs, multi-line and very long commands', async () => {
      const { checkSegment } = await import('../src/handoff.js');
      expect(checkSegment('python3 - <<EOF\nnpm test\nEOF')).toBeNull();
      expect(checkSegment('npm test ' + 'x'.repeat(300))).toBeNull();
    });
  });

  describe('lastCheck', () => {
    it('says "no failure output" instead of "passed" when nothing proves a pass', async () => {
      const { lastCheck } = await import('../src/handoff.js');
      const es = parse(tool('a', 'npm run build 2>&1 | tail -3'), result('a', '> tsup\nBuild done'));
      const out = lastCheck(es)!;
      expect(out).toContain('`npm run build`');
      expect(out).toContain('no failure output');
      expect(out).not.toContain('passed');
    });

    it('quotes the pass evidence when there is one', async () => {
      const { lastCheck } = await import('../src/handoff.js');
      const out = lastCheck(parse(tool('a', 'npm test'), result('a', 'Test Files  2 passed (2)\n      Tests  126 passed (126)')))!;
      expect(out).toMatch(/→ passed \(.*126 passed/);
    });

    it('names the failing test and the count', async () => {
      const { lastCheck } = await import('../src/handoff.js');
      const out = lastCheck(parse(tool('a', 'npm test'), result('a', ' FAIL  tests/csv.test.ts > escapes quotes\nAssertionError: expected 1 to be 2\n Tests  3 failed | 40 passed (43)')))!;
      expect(out).toContain('FAILED');
      expect(out).toContain('escapes quotes');
      expect(out).toContain('3 failed');
    });

    it('does not call "0 failed" a failure', async () => {
      const { lastCheck } = await import('../src/handoff.js');
      const out = lastCheck(parse(tool('a', 'npm test'), result('a', 'Tests  0 failed | 12 passed (12)')))!;
      expect(out).toContain('passed');
      expect(out).not.toContain('FAILED');
    });

    it('notes edits made after the check (from edit events, and from uncommitted files newer than it)', async () => {
      const { lastCheck } = await import('../src/handoff.js');
      const t0 = Date.now() - 600000;
      const es = parse(tool('a', 'npm test', iso(t0)), result('a', 'Tests 5 passed', iso(t0 + 1000)));
      expect(lastCheck(es, [t0 + 5000, t0 + 9000])).toContain('; 2 file edits since');
      expect(lastCheck(es, [t0 - 5000])).not.toContain('since');
      expect(lastCheck(es, [], [t0 + 60000])).toContain('; files changed since');
      expect(lastCheck(es, [], [t0 - 60000])).not.toContain('since');
    });

    it('uses the last check, even when it came after a failing one', async () => {
      const { lastCheck } = await import('../src/handoff.js');
      const es = parse(tool('a', 'npm test'), result('a', 'Tests 2 failed | 3 passed'), tool('b', 'npm test'), result('b', 'Tests 5 passed (5)'));
      expect(lastCheck(es)).toContain('passed');
      expect(lastCheck(es)).not.toContain('FAILED');
    });
  });

  describe('meaningfulCommands', () => {
    it('drops heredocs, file-reading and other looking around', async () => {
      const { meaningfulCommands } = await import('../src/handoff.js');
      const out = meaningfulCommands([
        "python3 - <<'PY'\nprint(1)\nPY",
        'cat src/a.ts',
        'git status',
        'grep -rn foo src',
        'sed -n 1,20p src/a.ts',
        'npm test'
      ]);
      expect(out).toEqual(['npm test']);
    });

    it('keeps the doing part of compound commands and removes pipes and redirects', async () => {
      const { meaningfulCommands } = await import('../src/handoff.js');
      const out = meaningfulCommands(['cd /repo && git add -A && git commit -m "x" 2>&1 | tail -3', 'ls && npm run build 2>&1 | tail -5']);
      expect(out).toEqual(['git add -A && git commit -m "x"', 'npm run build']);
    });

    it('dedupes (newest position wins) and caps the list', async () => {
      const { meaningfulCommands } = await import('../src/handoff.js');
      expect(meaningfulCommands(['npm test', 'npm run build', 'npm test'])).toEqual(['npm run build', 'npm test']);
      const many = Array.from({ length: 12 }, (_, i) => `npm run job${i}`);
      const out = meaningfulCommands(many, 5);
      expect(out.length).toBe(5);
      expect(out[4]).toBe('npm run job11');
    });
  });

  describe('git state', () => {
    it('reads branch, uncommitted files made by the shell, and the last commit', async () => {
      const { gitState, gitLine } = await import('../src/handoff.js');
      const cwd = gitRepo('gitA');
      fs.writeFileSync(path.join(cwd, 'a.ts'), 'export const a = 1;\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'first commit');
      fs.writeFileSync(path.join(cwd, 'a.ts'), 'export const a = 2;\n'); // edited "by sed", not by a file tool
      fs.writeFileSync(path.join(cwd, 'new file.ts'), 'x\n');
      const g = gitState(cwd)!;
      expect(g.branch).toBe('main');
      expect(g.dirty).toEqual(expect.arrayContaining(['a.ts', 'new file.ts']));
      expect(g.ahead).toBe(-1); // no upstream
      const l = gitLine(g);
      expect(l).toContain('branch `main`');
      expect(l).toContain('no upstream (not pushed)');
      expect(l).toContain('2 uncommitted: ');
      expect(l).toMatch(/last commit [0-9a-f]{7,} "first commit"/);
    });

    it('says the tree is clean, and reports unpushed commits and commits since the session began', async () => {
      const { gitState, gitLine, commitsLine } = await import('../src/handoff.js');
      const remote = path.join(tmp, 'gitB-remote.git');
      fs.mkdirSync(remote);
      git(remote, 'init', '-q', '--bare', '-b', 'main');
      const cwd = gitRepo('gitB');
      fs.writeFileSync(path.join(cwd, 'a.ts'), '1\n');
      git(cwd, 'add', '-A');
      gitAt(cwd, Date.now() - 3600000, 'commit', '-q', '-m', 'before the session');
      git(cwd, 'remote', 'add', 'origin', remote);
      git(cwd, 'push', '-q', '-u', 'origin', 'main');
      const began = Date.now() - 5000;
      fs.writeFileSync(path.join(cwd, 'b.ts'), '2\n');
      fs.writeFileSync(path.join(cwd, 'c.ts'), '3\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'add b and c');
      const g = gitState(cwd, began)!;
      expect(g.ahead).toBe(1);
      expect(g.dirty).toEqual([]);
      expect(gitLine(g)).toContain('1 commit not pushed');
      expect(gitLine(g)).toContain('working tree clean');
      const c = commitsLine(g);
      expect(c).toContain('Committed this session:');
      expect(c).toContain('"add b and c"');
      expect(c).toContain('b.ts');
      expect(c).toContain('c.ts');
      expect(c).not.toContain('a.ts');
    });

    it('is null outside a git repository and never throws', async () => {
      const { gitState } = await import('../src/handoff.js');
      const cwd = path.join(tmp, 'not-a-repo');
      fs.mkdirSync(cwd, { recursive: true });
      expect(gitState(cwd)).toBeNull();
      expect(gitState(path.join(tmp, 'does-not-exist'))).toBeNull();
    });

    it('gives up within its time budget when git is slow, instead of eating the hook timeout', async () => {
      const { gitState } = await import('../src/handoff.js');
      const cwd = gitRepo('gitSlow');
      const bin = path.join(tmp, 'slowbin');
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\nexec sleep 10\n', { mode: 0o755 });
      const was = process.env.PATH;
      process.env.PATH = `${bin}:${was}`;
      try {
        const t0 = Date.now();
        expect(gitState(cwd, Date.now() - 1000, 400)).toBeNull();
        expect(Date.now() - t0).toBeLessThan(2000);
      } finally {
        process.env.PATH = was;
      }
    });

    it('leaves the repository untouched (no lock, no index refresh)', async () => {
      const { gitState } = await import('../src/handoff.js');
      const cwd = gitRepo('gitC');
      fs.writeFileSync(path.join(cwd, 'a.ts'), '1\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'c');
      const idx = path.join(cwd, '.git', 'index');
      const before = fs.statSync(idx).mtimeMs;
      fs.utimesSync(path.join(cwd, 'a.ts'), new Date(), new Date(Date.now() + 1000)); // stat-dirty, same content
      gitState(cwd);
      expect(fs.statSync(idx).mtimeMs).toBe(before);
      expect(fs.existsSync(path.join(cwd, '.git', 'index.lock'))).toBe(false);
    });
  });

  describe('quoted mentions are not facts', () => {
    it('quotedOnly: true when every trigger sits inside double quotes', async () => {
      const { quotedOnly } = await import('../src/handoff.js');
      const cause = /\b(root cause|caused by|the fix)\b/i;
      expect(quotedOnly('Claude\'s "root cause" lines are noisy.', cause)).toBe(true);
      expect(quotedOnly('Decisions come from "decided / root cause" lines.', cause)).toBe(true);
      expect(quotedOnly('The root cause was a missing await.', cause)).toBe(false);
      expect(quotedOnly('The "root cause" label was wrong, the root cause was a race.', cause)).toBe(false);
      expect(quotedOnly('No trigger word here at all.', cause)).toBe(false);
      expect(quotedOnly('Root cause: the "fix" phrase is quoted.', /\b(the fix|fix)\b/i)).toBe(true);
    });

    it('the fact scan skips a sentence that only mentions the words', async () => {
      const { extractFacts } = await import('../src/facts.js');
      const cwd = path.join(tmp, 'factq');
      const t = writeTranscript(cwd, 'fq.jsonl', [
        line('user', 'how will the memory pick decisions up?'),
        line('assistant', [{ type: 'text', text: 'Decisions would come from your "no / don\'t / instead" messages and Claude\'s "decided / root cause" lines.' }]),
        line('assistant', [{ type: 'text', text: 'The root cause was that the webhook handler skipped the signature check.' }])
      ]);
      const texts = extractFacts(t).map((f) => f.text).join('\n');
      expect(texts).not.toContain('decided / root cause');
      expect(texts).toContain('webhook handler skipped the signature check');
    });
  });

  describe('buildHandoff', () => {
    const sid = (n: string) => `hq-${n}`;

    function session(name: string, withRepo = true) {
      const cwd = withRepo ? gitRepo(name) : path.join(tmp, name);
      fs.mkdirSync(cwd, { recursive: true });
      const t0 = Date.now() - 3600000;
      return { cwd, t0 };
    }

    it('restores the latest short message with what it answered, the open question, git, the failing check and the rules', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { estimateTokens } = await import('../src/tokens.js');
      const { cwd, t0 } = session('rq1');
      fs.writeFileSync(path.join(cwd, 'export.ts'), 'export const x = 1;\n');
      git(cwd, 'add', '-A');
      git(cwd, 'commit', '-q', '-m', 'base');
      const s = sid('1');
      const goal = 'make the csv export escape quotes and commas correctly in the admin page';
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      appendBuffer(s, { t: 'prompt', ts: t0 + 1000, text: 'always open a pull request, never push to main' });
      appendBuffer(s, { t: 'prompt', ts: t0 + 2000, text: goal });
      appendBuffer(s, { t: 'prompt', ts: t0 + 600000, text: 'yes go with option B' });
      const t = writeTranscript(cwd, 'rq1.jsonl', [
        line('user', goal, iso(t0 + 2000)),
        line('assistant', [{ type: 'text', text: 'There are two options. Option A rewrites the serializer. Option B patches only the quoting step. I suggest option B because it is smaller. Should I go with option B?' }], iso(t0 + 60000)),
        line('user', 'yes go with option B', iso(t0 + 600000)),
        line('assistant', [{ type: 'tool_use', id: 'c1', name: 'Bash', input: { command: 'cd ' + cwd + ' && npm test 2>&1 | tail -20' } }], iso(t0 + 610000)),
        line('user', [{ type: 'tool_result', tool_use_id: 'c1', content: ' FAIL  tests/csv.test.ts > escapes commas\n Tests  1 failed | 9 passed (10)' }], iso(t0 + 620000)),
        line('assistant', [{ type: 'text', text: 'The comma case still fails because the quote state resets per field. I am fixing that next. Does the header row also need quoting?' }], iso(t0 + 630000))
      ]);
      fs.writeFileSync(path.join(cwd, 'export.ts'), 'export const x = 2;\n'); // a shell edit after the check
      fs.utimesSync(path.join(cwd, 'export.ts'), new Date(t0 + 700000), new Date(t0 + 700000));
      const h = buildHandoff(s, t, cwd, 1200)!;
      expect(h.text).toContain('Goal: make the csv export escape quotes');
      expect(h.text).toContain('Latest message: "yes go with option B"');
      expect(h.text).toContain('replying to:');
      expect(h.text).toContain('Should I go with option B?'); // what "yes" answered is the end of that reply
      expect(h.text).toContain('Waiting on the user, the last reply asked: ');
      expect(h.text).toContain('Does the header row also need quoting?');
      expect(h.text).toContain('always open a pull request');
      expect(h.text).toMatch(/Git: branch `main`.*1 uncommitted: export\.ts/);
      expect(h.text).toMatch(/Last check: `npm test` → FAILED.*escapes commas.*1 failed/);
      expect(h.text).toContain('files changed since');
      expect(estimateTokens(h.text)).toBeLessThanOrEqual(1200);
    });

    it('no latest-message line when the last message is the goal itself, or a slash command', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { cwd, t0 } = session('rq2');
      const s = sid('2');
      const goal = 'refactor the billing module to use the new tax rates table';
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      appendBuffer(s, { t: 'prompt', ts: t0 + 1000, text: goal });
      const t = writeTranscript(cwd, 'rq2.jsonl', [line('user', goal, iso(t0 + 1000)), line('assistant', [{ type: 'text', text: 'Reading the module now, then I will change it. '.repeat(6) }], iso(t0 + 2000))]);
      expect(buildHandoff(s, t, cwd)!.text).not.toContain('Latest message');
      appendBuffer(s, { t: 'prompt', ts: t0 + 5000, text: '/clear' });
      expect(buildHandoff(s, t, cwd)!.text).not.toContain('Latest message');
    });

    it('takes the replies from after the goal, not from an earlier task', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { cwd, t0 } = session('rq3');
      const s = sid('3');
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      appendBuffer(s, { t: 'prompt', ts: t0 + 1000, text: 'fix the login redirect loop on the settings page' });
      appendBuffer(s, { t: 'prompt', ts: t0 + 500000, text: 'now add dark mode to the dashboard header component' });
      const t = writeTranscript(cwd, 'rq3.jsonl', [
        line('user', 'fix the login redirect loop on the settings page', iso(t0 + 1000)),
        line('assistant', [{ type: 'text', text: 'The redirect loop came from the session cookie being set twice. I removed the duplicate middleware. '.repeat(3) }], iso(t0 + 2000)),
        line('user', 'now add dark mode to the dashboard header component', iso(t0 + 500000)),
        line('assistant', [{ type: 'text', text: 'Dark mode: I added a theme token file and switched the header to read it. The toggle is next. '.repeat(3) }], iso(t0 + 510000))
      ]);
      const text = buildHandoff(s, t, cwd)!.text;
      expect(text).toContain('Where it got to');
      expect(text).toContain('Dark mode: I added a theme token file');
      expect(text).not.toContain('session cookie being set twice');
    });

    it('labels replies from before the goal when nothing came after it', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { cwd, t0 } = session('rq4');
      const s = sid('4');
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      appendBuffer(s, { t: 'prompt', ts: t0 + 1000, text: 'fix the login redirect loop on the settings page' });
      appendBuffer(s, { t: 'prompt', ts: t0 + 500000, text: 'now add dark mode to the dashboard header component' });
      const t = writeTranscript(cwd, 'rq4.jsonl', [
        line('user', 'fix the login redirect loop on the settings page', iso(t0 + 1000)),
        line('assistant', [{ type: 'text', text: 'The redirect loop came from the session cookie being set twice. I removed the duplicate middleware. '.repeat(3) }], iso(t0 + 2000)),
        line('user', 'now add dark mode to the dashboard header component', iso(t0 + 500000))
      ]);
      const text = buildHandoff(s, t, cwd)!.text;
      expect(text).toContain('Last replies (before the goal above, about the previous task):');
      expect(text).not.toContain('Where it got to');
    });

    it('keeps the ending of a long last reply', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { cwd, t0 } = session('rq5');
      const s = sid('5');
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      appendBuffer(s, { t: 'prompt', ts: t0 + 1000, text: 'investigate why the nightly import job is slow' });
      const long = 'I profiled the import job and looked at each stage in turn. '.repeat(30) + 'Conclusion: the N+1 query in loadCustomers is the cause, batch it with one IN query.';
      const t = writeTranscript(cwd, 'rq5.jsonl', [line('user', 'investigate why the nightly import job is slow', iso(t0 + 1000)), line('assistant', [{ type: 'text', text: long }], iso(t0 + 2000))]);
      const text = buildHandoff(s, t, cwd)!.text;
      expect(text).toContain('the N+1 query in loadCustomers is the cause, batch it with one IN query.');
    });

    it('withGit=false leaves git out and falls back to the files the edit events saw', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { cwd, t0 } = session('rq6');
      fs.writeFileSync(path.join(cwd, 'dirty.ts'), 'x\n');
      const s = sid('6');
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      appendBuffer(s, { t: 'prompt', ts: t0 + 1000, text: 'write the retry wrapper for the payment client' });
      appendBuffer(s, { t: 'file', ts: t0 + 2000, path: path.join(cwd, 'src/retry.ts'), op: 'edit' });
      const t = writeTranscript(cwd, 'rq6.jsonl', [line('user', 'write the retry wrapper for the payment client', iso(t0 + 1000)), line('assistant', [{ type: 'text', text: 'Started the wrapper in src/retry.ts. '.repeat(8) }], iso(t0 + 2000))]);
      const off = buildHandoff(s, t, cwd, 1200, false)!.text;
      expect(off).not.toContain('Git:');
      expect(off).not.toContain('dirty.ts');
      expect(off).toContain('Files changed: src/retry.ts');
      const on = buildHandoff(s, t, cwd, 1200, true)!.text;
      expect(on).toContain('Git: branch `main`');
      expect(on).toContain('dirty.ts');
    });

    it('works outside a git repository', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { cwd, t0 } = session('rq7', false);
      const s = sid('7');
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      appendBuffer(s, { t: 'prompt', ts: t0 + 1000, text: 'write the retry wrapper for the payment client' });
      const t = writeTranscript(cwd, 'rq7.jsonl', [line('user', 'write the retry wrapper for the payment client', iso(t0 + 1000)), line('assistant', [{ type: 'text', text: 'Started the wrapper. '.repeat(10) }], iso(t0 + 2000))]);
      const text = buildHandoff(s, t, cwd)!.text;
      expect(text).toContain('Goal:');
      expect(text).not.toContain('Git:');
    });

    it('stays inside every cap, and the goal survives the tightest one', async () => {
      const { buildHandoff } = await import('../src/handoff.js');
      const { estimateTokens } = await import('../src/tokens.js');
      const { cwd, t0 } = session('rq8');
      const s = sid('8');
      appendBuffer(s, { t: 'start', ts: t0, cwd });
      for (let i = 0; i < 6; i++) appendBuffer(s, { t: 'prompt', ts: t0 + 1000 * (i + 1), text: `request number ${i}: please change the module ${'alpha '.repeat(30)}` });
      appendBuffer(s, { t: 'prompt', ts: t0 + 50000, text: 'yes do that' });
      for (let i = 0; i < 20; i++) appendBuffer(s, { t: 'cmd', ts: t0 + 1000 * i, cmd: `npm run job${i} --flag ${'z'.repeat(60)}` });
      for (let i = 0; i < 30; i++) appendBuffer(s, { t: 'file', ts: t0 + 1000 * i, path: path.join(cwd, `src/f${i}.ts`), op: i % 2 ? 'edit' : 'read' });
      const t = writeTranscript(cwd, 'rq8.jsonl', [
        line('user', 'request number 5: please change the module', iso(t0 + 6000)),
        line('assistant', [{ type: 'text', text: 'I changed the module. '.repeat(80) + 'Should I also update the docs?' }], iso(t0 + 7000)),
        line('user', 'yes do that', iso(t0 + 50000))
      ]);
      for (const cap of [150, 300, 600, 1200]) {
        const h = buildHandoff(s, t, cwd, cap)!;
        expect(h.text).toContain('Goal:');
        expect(estimateTokens(h.text)).toBeLessThanOrEqual(cap === 150 ? 260 : cap);
      }
    });
  });

  describe('handoffText', () => {
    it('is unchanged for a fresh handoff and notes the age of an old one', async () => {
      const { handoffText } = await import('../src/handoff.js');
      const base = { sessionId: 's', project: 'p', contextTokens: 1000, text: '[grugbrain handoff: continuing work.]\nGoal: x\nfooter' };
      const now = Date.now();
      expect(handoffText({ ...base, ts: now - 2 * 60000 }, now)).toBe(base.text);
      const hour = handoffText({ ...base, ts: now - 3 * 3600000 }, now);
      expect(hour.split('\n')[0]).toBe('[grugbrain handoff: continuing work. Saved 3 h ago: git and check status below may have changed since.]');
      expect(hour.split('\n').slice(1).join('\n')).toBe('Goal: x\nfooter');
      expect(handoffText({ ...base, ts: now - 30 * 60000 }, now)).toContain('Saved 30 min ago');
      expect(handoffText({ ...base, ts: now - 40 * 3600000 }, now)).toContain('Saved 40 h ago');
    });
  });

  describe('config', () => {
    it('reads git state by default and the cap is unchanged', () => {
      const c = defaultConfig();
      expect(c.handoff.git).toBe(true);
      expect(c.handoff.maxTokens).toBe(1200);
    });
  });
});

describe('archive', () => {
  it('keeps text only, appends incrementally, and feeds deep history after the live transcript is gone', async () => {
    const { archiveSession, archiveDir } = await import('../src/archive.js');
    const { searchHistory } = await import('../src/history.js');
    const cwd = path.join(tmp, 'arch app');
    const t = writeTranscript(cwd, 'old1.jsonl', [
      line('user', 'why does the invoice worker crash on zorblax payloads'),
      line('assistant', [{ type: 'text', text: 'Root cause: zorblax payloads overflow the parser buffer.' }, { type: 'tool_use', id: 'q', name: 'Bash', input: { command: 'secret-tool-call' } }]),
      line('user', [{ type: 'tool_result', tool_use_id: 'q', content: 'HUGE TOOL OUTPUT' }])
    ]);
    expect(archiveSession(cwd, 'old1', t)).toBe(2);
    expect(archiveSession(cwd, 'old1', t)).toBe(0); // nothing new
    fs.appendFileSync(t, line('assistant', [{ type: 'text', text: 'Fixed by raising the buffer to 64k.' }]) + '\n');
    expect(archiveSession(cwd, 'old1', t)).toBe(1);
    const stored = fs.readFileSync(path.join(archiveDir(cwd), 'old1.jsonl'), 'utf8');
    expect(stored).toContain('zorblax');
    expect(stored).not.toContain('HUGE TOOL OUTPUT');
    expect(stored).not.toContain('secret-tool-call');
    fs.rmSync(t); // Claude Code cleaned its copy up
    const out = searchHistory(cwd, 'zorblax parser buffer');
    expect(out).toContain('overflow the parser buffer');
  });

  it('prunes the oldest sessions past the size cap', async () => {
    const { archiveSession, archiveDir } = await import('../src/archive.js');
    const cwd = path.join(tmp, 'prune app');
    const big = 'lorem ipsum dolor sit amet '.repeat(100);
    for (const [i, n] of ['a', 'b', 'c'].entries()) {
      const t = writeTranscript(cwd, `${n}.jsonl`, Array.from({ length: 40 }, () => line('user', big)));
      archiveSession(cwd, n, t, 0.1);
      const f = path.join(archiveDir(cwd), `${n}.jsonl`);
      if (fs.existsSync(f)) fs.utimesSync(f, new Date(Date.now() + i * 1000), new Date(Date.now() + i * 1000));
    }
    const left = fs.readdirSync(archiveDir(cwd)).filter((f) => f.endsWith('.jsonl'));
    expect(left.length).toBeLessThan(3);
  });
});

describe('auto-pinned rules', () => {
  it('recognises standing rules only', async () => {
    const { isStandingRule } = await import('../src/memory/store.js');
    expect(isStandingRule({ kind: 'preference', text: 'User preference: never merge until I say merge it' })).toBe(true);
    expect(isStandingRule({ kind: 'preference', text: 'User preference: please add a button to the page' })).toBe(false);
    expect(isStandingRule({ kind: 'decision', text: 'never merge until I say merge it' })).toBe(false);
  });

  it('caps auto pins and leaves manual pins alone', async () => {
    const { capAutoPins, MAX_AUTO_PINS, addNote: add, loadMemory: load } = await import('../src/memory/store.js');
    const db = load();
    const p = 'proj';
    const manual = add(db, p, 'manual pinned note about deploys', 1, { pinned: true });
    for (let i = 0; i < MAX_AUTO_PINS + 3; i++) add(db, p, `never do thing number ${i} alpha${i} beta${i * 7}`, 100 + i, { pinned: true, auto: true });
    capAutoPins(db, p);
    const autos = Object.values(db.nodes).filter((n) => n.data?.pinned && n.data?.auto);
    expect(autos.length).toBe(MAX_AUTO_PINS);
    expect(db.nodes[manual.id].data?.pinned).toBe(true);
  });
});

// ---------------------------------------------------------------- v2.16 app summary line
describe('app summary line', () => {
  it('composes a plain one-line summary with savings and context bars', async () => {
    const { composeAppLine } = await import('../src/statusline.js');
    const l = composeAppLine({ savedPct: 0.42, netUsd: 120, tokens: 90000, limit: 120000, recent: 'Trimmed npm output' });
    expect(l).toContain('🪨 grug');
    expect(l).toMatch(/saved [█▏▎▍▌▋▊▉░]{10} ~42%/);
    expect(l).toContain('75% of /clear limit (90k)');
    expect(l).toContain('last: Trimmed npm output');
    expect(l).not.toContain('\x1b');
    expect(l).not.toContain('\n');
    expect(composeAppLine({ savedPct: 0.1, tokens: 130000, limit: 120000 })).toContain('/clear soon');
  });

  it('is sent to the user on every Nth prompt, not on the others, and is off when disabled', async () => {
    const { saveConfig, loadConfig } = await import('../src/config.js');
    const cwd = path.join(tmp, 'sumproj');
    fs.mkdirSync(cwd, { recursive: true });
    const cfg = loadConfig();
    cfg.appSummary = { enabled: true, everyPrompts: 3 };
    saveConfig(cfg);
    const t = path.join(tmp, 'sum.jsonl');
    fs.writeFileSync(t, JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { id: 'a1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, cache_read_input_tokens: 90000, output_tokens: 5 } } }) + '\n');
    const msgs: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) {
      const out: any = await runHook('user-prompt', { session_id: 'sum1', cwd, transcript_path: t, prompt: `please explain the billing module part ${i}` });
      msgs.push(out?.systemMessage);
    }
    expect(msgs[0] || '').toContain('🪨 grug'); // the first prompt always shows it
    expect(msgs[1] || '').not.toContain('🪨 grug');
    expect(msgs[2] || '').toContain('🪨 grug');
    cfg.appSummary.enabled = false;
    saveConfig(cfg);
    for (let i = 0; i < 3; i++) {
      const out: any = await runHook('user-prompt', { session_id: 'sum2', cwd, prompt: `please explain the billing module part ${i}` });
      expect(out?.systemMessage || '').not.toContain('🪨 grug');
    }
  });
});

describe('dashboard in plain words', () => {
  it('overview explains the numbers without jargon', async () => {
    const { renderOnce } = await import('../src/tui/dashboard.js');
    const o = renderOnce({ tab: 0 } as any, 150, 60).replace(/\u001b\[[0-9;]*m/g, '');
    for (const w of ['IN PLAIN WORDS', 'WHERE IT CAME FROM', 'YOUR USAGE', 'Chat size re-read every reply', 'IF THIS CONTINUES', 'grug is working']) {
      expect(o.includes(w) || w === 'grug is working').toBe(true);
    }
    expect(o).not.toMatch(/MEASURED|PROJECTION|avg context per reply/);
  });
});

describe('headline is the overall saving', () => {
  it('handoffs carry no dollar value of their own; the smaller chat is counted with its tier', async () => {
    const { recordActivity, recordRequest } = await import('../src/stats.js');
    const { computeSavings } = await import('../src/savings.js');
    recordActivity({ kind: 'handoff', msg: 'restored', tokens: 50000 });
    recordRequest({ ts: Date.now(), model: 'claude-opus-5-5', usage: { input_tokens: 10, cache_read_input_tokens: 100000, output_tokens: 10 }, status: 200, trimmedTokens: 0, cacheBreakpointsAdded: 0, ctxCutTokens: 300000 });
    const sv = computeSavings(0);
    expect(sv.parts.find((p) => p.key === 'handoff')?.usd ?? 0).toBe(0);
    const c = sv.parts.find((p) => p.key === 'context')!;
    expect(c.tier).toBe('derived');
    expect(c.usd).toBeCloseTo((300000 * 4 * 0.1) / 1e6, 6);
    expect(sv.netUsd).toBeGreaterThan(0);
    expect(sv.pct).toBeGreaterThan(sv.measuredPct);
    expect(sv.measuredNetUsd).toBe(0);
  });

  it('credits a compaction only near the window, never beyond the usual chat size', async () => {
    const { ctxCut } = await import('../src/meter.js');
    const st: { prevCtx?: number; carry?: number } = {};
    const W = 150000;
    const B = 500000;
    expect(ctxCut(st, 100000, W, B)).toBe(0); // no compaction yet
    expect(ctxCut(st, 140000, W, B)).toBe(0);
    expect(ctxCut(st, 30000, W, B)).toBe(110000); // compacted near the window: chat is 110k smaller
    expect(ctxCut(st, 60000, W, B)).toBe(110000); // still smaller on later replies
    const far: { prevCtx?: number; carry?: number } = {};
    ctxCut(far, 600000, W, B);
    expect(ctxCut(far, 50000, W, B)).toBe(0); // a drop far from the window is not grug's
    const cap: { prevCtx?: number; carry?: number } = { prevCtx: 140000, carry: 900000 };
    expect(ctxCut(cap, 400000, W, B)).toBe(100000); // never above the 500k baseline
  });
});

async function quietSummary(): Promise<void> {
  const { loadConfig, saveConfig } = await import('../src/config.js');
  const c = loadConfig();
  c.appSummary.enabled = false; // the test below is about another notice only
  c.autoCompact.windowTokens = 200000; // keep the context alert quiet at the 200k sizes these tests use
  saveConfig(c);
}
