/**
 * Local pass-through proxy for the Anthropic API (point ANTHROPIC_BASE_URL at it).
 *  - Forwards every request and header untouched except POST /v1/messages bodies,
 *    which get the deterministic transforms in transform.ts.
 *  - Fail-open: if a transform throws, or upstream rejects a transformed body with 400,
 *    the original bytes are sent instead.
 *  - Reads real `usage` numbers from JSON and SSE streams for the dashboard.
 */

import * as http from 'node:http';
import * as https from 'node:https';
import { URL } from 'node:url';
import { GrugConfig, VERSION } from '../config.js';
import { recordActivity, recordRequest } from '../stats.js';
import { Usage } from '../tokens.js';
import { guessProject, transformRequest, TransformReport } from './transform.js';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer',
  'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding'
]);

export interface ProxyHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export function startProxy(cfg: GrugConfig, port = cfg.port, host = '127.0.0.1'): Promise<ProxyHandle> {
  const upstream = new URL(cfg.upstream);
  const client = upstream.protocol === 'http:' ? http : https;
  const started = Date.now();
  let served = 0;

  const server = http.createServer((req, res) => {
    if (req.url === '/__grug/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, name: 'grugbrain', version: VERSION, uptimeMs: Date.now() - started, served }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      served++;
      const original = Buffer.concat(chunks);
      let body = original;
      let report: TransformReport | null = null;
      let model = '';
      let project: string | undefined;
      const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(req.url || '');
      if (isMessages && cfg.proxy.enabled) {
        try {
          const json = JSON.parse(original.toString('utf8'));
          model = json.model || '';
          project = guessProject(json);
          report = transformRequest(json, {
            autoCache: cfg.proxy.autoCache,
            trimToolResults: cfg.proxy.trimToolResults,
            dedupeReads: cfg.proxy.dedupeReads,
            trim: {
              thresholdChars: cfg.proxy.trimThresholdChars,
              keepHeadChars: cfg.proxy.trimKeepHeadChars,
              keepTailChars: cfg.proxy.trimKeepTailChars
            }
          });
          if (report.changed) body = Buffer.from(JSON.stringify(json), 'utf8');
        } catch {
          report = null;
          body = original;
        }
      }
      forward(body, report !== null && report.changed);

      function forward(payload: Buffer, transformed: boolean) {
        const headers: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
        headers['host'] = upstream.host;
        headers['accept-encoding'] = 'identity';
        if (payload.length || req.method === 'POST') headers['content-length'] = String(payload.length);
        const basePath = upstream.pathname.replace(/\/$/, '');
        const up = client.request(
          {
            protocol: upstream.protocol,
            hostname: upstream.hostname,
            port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443),
            method: req.method,
            path: basePath + (req.url || '/'),
            headers
          },
          (upRes) => {
            const status = upRes.statusCode || 502;
            // Our transform caused a 400? Retry once with the client's original bytes.
            if (transformed && status === 400) {
              upRes.resume();
              recordActivity({ kind: 'fallback', msg: 'Upstream rejected optimized request (400); resent original untouched', project });
              forward(original, false);
              return;
            }
            const outHeaders = { ...upRes.headers };
            delete outHeaders['content-length'];
            delete outHeaders['transfer-encoding'];
            res.writeHead(status, outHeaders);
            const isSse = String(upRes.headers['content-type'] || '').includes('event-stream');
            const usage: Usage = {};
            let sseBuf = '';
            const jsonChunks: Buffer[] = [];
            upRes.on('data', (chunk: Buffer) => {
              res.write(chunk);
              if (!isMessages) return;
              if (isSse) {
                sseBuf += chunk.toString('utf8');
                let nl: number;
                while ((nl = sseBuf.indexOf('\n')) >= 0) {
                  const line = sseBuf.slice(0, nl).trim();
                  sseBuf = sseBuf.slice(nl + 1);
                  if (line.startsWith('data:')) readUsage(line.slice(5).trim(), usage, (m) => (model = m || model));
                }
              } else jsonChunks.push(chunk);
            });
            upRes.on('end', () => {
              res.end();
              if (!isMessages) return;
              if (!isSse) {
                try {
                  const j = JSON.parse(Buffer.concat(jsonChunks).toString('utf8'));
                  Object.assign(usage, j.usage || {});
                  model = j.model || model;
                } catch {
                  /* not JSON */
                }
              }
              recordRequest({
                ts: Date.now(),
                model,
                usage,
                status,
                trimmedTokens: transformed && report ? report.trimmedTokens : 0,
                cacheBreakpointsAdded: transformed && report ? report.breakpointsAdded : 0,
                fallback: !transformed && report?.changed ? true : undefined,
                project
              });
              if (transformed && report && status < 400) {
                if (report.trimmedResults)
                  recordActivity({ kind: 'trim', msg: `Trimmed ${report.trimmedResults} long tool output(s)`, tokens: report.trimmedTokens, project });
                if (report.dedupedResults)
                  recordActivity({ kind: 'dedupe', msg: `Replaced ${report.dedupedResults} duplicate tool output(s)`, project });
                if (report.breakpointsAdded)
                  recordActivity({ kind: 'cache', msg: `Added ${report.breakpointsAdded} prompt-cache breakpoint(s)`, project });
              }
            });
            upRes.on('error', () => res.destroy());
          }
        );
        up.on('error', (err) => {
          if (!res.headersSent) {
            res.writeHead(502, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `grugbrain proxy: upstream error: ${err.message}` } }));
          } else res.destroy();
        });
        req.on('aborted', () => up.destroy());
        res.on('close', () => {
          if (!res.writableFinished) up.destroy();
        });
        up.end(payload);
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, port: actual, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function readUsage(data: string, usage: Usage, setModel: (m: string) => void) {
  if (!data || data === '[DONE]') return;
  try {
    const ev = JSON.parse(data);
    if (ev.type === 'message_start' && ev.message) {
      setModel(ev.message.model);
      Object.assign(usage, ev.message.usage || {});
    } else if (ev.type === 'message_delta' && ev.usage) {
      for (const [k, v] of Object.entries(ev.usage)) if (typeof v === 'number') (usage as any)[k] = v;
    }
  } catch {
    /* partial or non-JSON line */
  }
}

export async function proxyHealth(port: number, timeoutMs = 800): Promise<any | null> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/__grug/health', timeout: timeoutMs }, (res) => {
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(t));
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}
