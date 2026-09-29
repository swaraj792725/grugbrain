/**
 * Cache-miss detective.
 * Remembers a fingerprint of the last request in each conversation. When a follow-up request
 * pays a big cache WRITE instead of a cache READ, it finds what changed in the prefix:
 * model switch, tool list, system prompt (with the differing snippet), an edited earlier message,
 * or simply an expired cache (idle longer than the TTL).
 */

import { createHash } from 'node:crypto';
import { cacheWriteMult, CACHE_READ_MULT, priceFor, Usage } from '../tokens.js';

interface Fingerprint {
  ts: number;
  model: string;
  tools: string;
  toolNames: string[];
  system: string;
  systemText: string;
  msgs: string[];
}

export interface CacheMiss {
  culprit: 'model-switch' | 'tools-changed' | 'system-changed' | 'history-edited' | 'expired' | 'unknown';
  detail: string;
  wastedUsd: number;
  tokens: number;
}

const h = (v: unknown) => createHash('sha1').update(typeof v === 'string' ? v : JSON.stringify(v ?? null)).digest('hex').slice(0, 16);

function systemTextOf(system: any): string {
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) return system.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  return '';
}

/** Strip cache_control so moving a breakpoint alone doesn't look like a content change. */
function clean(v: any): any {
  return JSON.parse(JSON.stringify(v ?? null, (k, val) => (k === 'cache_control' ? undefined : val)));
}

export function fingerprint(body: any): Fingerprint {
  const tools = clean(body.tools || []);
  return {
    ts: Date.now(),
    model: body.model || '',
    tools: h(tools),
    toolNames: (Array.isArray(tools) ? tools : []).map((t: any) => t?.name).filter(Boolean),
    system: h(clean(body.system)),
    systemText: systemTextOf(body.system).slice(0, 60000),
    msgs: (body.messages || []).map((m: any) => h(clean(m)))
  };
}

/** Conversation identity: the first user message (stable for the whole conversation). */
export function conversationKey(body: any): string | null {
  const first = (body.messages || [])[0];
  if (!first) return null;
  return h(clean(first.content));
}

function firstDiff(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const s = Math.max(0, i - 40);
  const was = a.slice(s, i + 60).replace(/\s+/g, ' ');
  const now = b.slice(s, i + 60).replace(/\s+/g, ' ');
  const volatile = /\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}|[0-9a-f]{8}-[0-9a-f]{4}|\b\d{10,13}\b/i.test(now + was);
  return `…${was}… → …${now}…${volatile ? ' (looks like a timestamp/ID that changes every request: move it after the last cache breakpoint)' : ''}`;
}

export class CacheWatch {
  private last = new Map<string, Fingerprint>();
  constructor(private maxStreams = 300) {}

  /** Call after the response; returns a diagnosis when a preventable miss happened. */
  observe(body: any, usage: Usage): CacheMiss | null {
    const key = conversationKey(body);
    if (!key) return null;
    const fp = fingerprint(body);
    const prev = this.last.get(key);
    this.last.delete(key);
    this.last.set(key, fp);
    if (this.last.size > this.maxStreams) this.last.delete(this.last.keys().next().value as string);
    if (!prev) return null;

    const write = usage.cache_creation_input_tokens || 0;
    const read = usage.cache_read_input_tokens || 0;
    // Healthy: most of the prefix was read from cache; the write is just the new turn.
    if (write < 4000 || write < read * 0.5) return null;

    const p = priceFor(fp.model);
    const wastedUsd = (write * p.input * (cacheWriteMult(usage) - CACHE_READ_MULT)) / 1e6;
    const base = { wastedUsd, tokens: write };
    const ttlMs = usage.cache_creation?.ephemeral_1h_input_tokens ? 60 * 60000 : 5 * 60000;
    const idle = fp.ts - prev.ts;

    if (prev.model !== fp.model) return { culprit: 'model-switch', detail: `model changed ${prev.model} → ${fp.model}; caches are per model`, ...base };
    if (prev.tools !== fp.tools) {
      const added = fp.toolNames.filter((n) => !prev.toolNames.includes(n));
      const removed = prev.toolNames.filter((n) => !fp.toolNames.includes(n));
      const order = !added.length && !removed.length ? ' (same tools, different order/definition)' : '';
      return {
        culprit: 'tools-changed',
        detail: `tool list changed${added.length ? ` +${added.slice(0, 5).join(', ')}` : ''}${removed.length ? ` -${removed.slice(0, 5).join(', ')}` : ''}${order}`,
        ...base
      };
    }
    if (prev.system !== fp.system) return { culprit: 'system-changed', detail: `system prompt changed: ${firstDiff(prev.systemText, fp.systemText)}`, ...base };
    for (let i = 0; i < Math.min(prev.msgs.length, fp.msgs.length); i++) {
      if (prev.msgs[i] !== fp.msgs[i]) return { culprit: 'history-edited', detail: `earlier message #${i + 1} was modified, so everything after it was re-cached`, ...base };
    }
    if (idle > ttlMs) return { culprit: 'expired', detail: `idle ${Math.round(idle / 60000)} min, longer than the ${ttlMs / 60000}-min cache lifetime`, ...base };
    return { culprit: 'unknown', detail: 'prefix looked identical; breakpoints may have moved or the prefix is below the minimum cacheable size', ...base };
  }
}
