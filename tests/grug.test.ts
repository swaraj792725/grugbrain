import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';

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
    expect(s1.autoCompactWindow).toBe(200000);
    expect(s1.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('200000');
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
    expect(ctx).toContain('read_symbol');
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
    expect(left.filter((n) => n.data?.kind).length).toBeLessThanOrEqual(60);
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
    const text = renderOnce({ tab: 0 } as any, 160, 80).replace(/\u001b\[[0-9;]*m/g, '');
    expect(text).toMatch(/auto-recall injections.*2×.*avg 200 tok/);
    expect(text).toMatch(/graph context: maps \+ code hints.*1×/);
  });
});
