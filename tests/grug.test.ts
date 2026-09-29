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
import { readRequests, summarize } from '../src/stats.js';
import { runHook } from '../src/hooks.js';
import { costOf } from '../src/tokens.js';

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
