/**
 * Transcript metering: real per-reply token usage read from Claude Code's session transcript.
 * Works where the proxy can't see traffic (e.g. the Claude desktop app's Code tab, which manages
 * its own API connection). Called from the Stop / SessionEnd / PreCompact hooks.
 *
 * - Reads only the bytes appended since the last call (offset kept per session).
 * - A reply appears once per content block with identical usage: de-duplicated by message id.
 * - If the proxy already recorded calls in the same time window, nothing is recorded here,
 *   so the same traffic is never counted twice.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, paths, readJson, writeJsonAtomic } from './config.js';
import { readRequests, recordRequest } from './stats.js';
import { Usage } from './tokens.js';

interface MeterState {
  offset: number;
  ids: string[];
}

const MAX_READ = 16 * 1024 * 1024;

const stateFile = (sid: string) => path.join(paths.home(), 'meter', `${sid.replace(/[^\w.-]/g, '_')}.json`);

export interface MeterResult {
  replies: number;
  recorded: number;
  skippedProxy: number;
}

export function meterTranscript(sessionId: string, transcriptPath: string | undefined, project?: string): MeterResult {
  const res: MeterResult = { replies: 0, recorded: 0, skippedProxy: 0 };
  if (!transcriptPath) return res;
  let size = 0;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch {
    return res;
  }
  const r = readJson<MeterState>(stateFile(sessionId));
  const st: MeterState = r.ok && r.value && typeof r.value.offset === 'number' ? r.value : { offset: 0, ids: [] };
  if (size < st.offset) st.offset = 0; // transcript rewritten
  if (size === st.offset) return res;

  const len = Math.min(size - st.offset, MAX_READ);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    fs.readSync(fd, buf, 0, len, st.offset);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString('utf8');
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return res; // partial line only; wait for more
  const complete = text.slice(0, lastNl);

  const seen = new Set(st.ids);
  const replies = new Map<string, { model: string; usage: Usage; ts: number }>();
  for (const line of complete.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const m = e?.message;
    if (e?.type !== 'assistant' || !m?.id || !m.usage || seen.has(m.id)) continue;
    replies.set(m.id, { model: m.model || '', usage: m.usage, ts: Date.parse(e.timestamp) || Date.now() });
  }
  st.offset += Buffer.byteLength(complete, 'utf8') + 1;
  res.replies = replies.size;

  if (replies.size) {
    const first = Math.min(...[...replies.values()].map((x) => x.ts));
    // Proxy already saw calls in this window? Then it counted this traffic; don't double count.
    const proxied = readRequests().some((q) => !q.tag && q.source !== 'transcript' && q.ts >= first - 60000);
    for (const [id, rep] of replies) {
      seen.add(id);
      if (proxied) {
        res.skippedProxy++;
        continue;
      }
      recordRequest({
        ts: rep.ts,
        model: rep.model,
        usage: {
          input_tokens: rep.usage.input_tokens,
          output_tokens: rep.usage.output_tokens,
          cache_read_input_tokens: rep.usage.cache_read_input_tokens,
          cache_creation_input_tokens: rep.usage.cache_creation_input_tokens,
          cache_creation: rep.usage.cache_creation
        },
        status: 200,
        trimmedTokens: 0,
        cacheBreakpointsAdded: 0,
        project,
        source: 'transcript',
        ...(process.env.GRUG_TAG ? { tag: process.env.GRUG_TAG } : {})
      });
      res.recorded++;
    }
  }
  ensureDir(path.dirname(stateFile(sessionId)));
  writeJsonAtomic(stateFile(sessionId), { offset: st.offset, ids: [...seen].slice(-3000) });
  return res;
}
