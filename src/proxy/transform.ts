/**
 * Request transforms applied by the proxy to POST /v1/messages bodies.
 * Rules:
 *  - Deterministic: the same conversation always transforms to the same bytes, so the
 *    prompt-cache prefix stays stable turn after turn.
 *  - Assistant turns (and thinking blocks) are never modified.
 *  - Never adds cache breakpoints when the client already manages caching.
 */

import { createHash } from 'node:crypto';
import { trimToolOutput, TrimOptions } from '../compress/trim.js';
import { estimateTokens } from '../tokens.js';

export interface TransformOptions {
  autoCache: boolean;
  trimToolResults: boolean;
  dedupeReads: boolean;
  trim: TrimOptions;
}

export interface TransformReport {
  changed: boolean;
  breakpointsAdded: number;
  trimmedChars: number;
  trimmedResults: number;
  dedupedResults: number;
  trimmedTokens: number;
}

const MAX_BREAKPOINTS = 4;
const CACHEABLE_TYPES = new Set(['text', 'image', 'tool_use', 'tool_result', 'document']);

function countBreakpoints(body: any): number {
  let n = 0;
  const visit = (blocks: any) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      if (b && b.cache_control) n++;
      if (b && Array.isArray(b.content)) visit(b.content);
    }
  };
  visit(body.tools);
  visit(body.system);
  for (const m of body.messages || []) visit(m.content);
  return n;
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && c.type === 'text' ? c.text : '')).join('');
  return '';
}

export function transformRequest(body: any, opts: TransformOptions): TransformReport {
  const report: TransformReport = {
    changed: false,
    breakpointsAdded: 0,
    trimmedChars: 0,
    trimmedResults: 0,
    dedupedResults: 0,
    trimmedTokens: 0
  };
  if (!body || !Array.isArray(body.messages)) return report;

  // 1+2. Trim and dedupe tool results in user turns.
  const seen = new Map<string, number>();
  body.messages.forEach((msg: any, mi: number) => {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return;
    for (const block of msg.content) {
      if (!block || block.type !== 'tool_result') continue;
      const apply = (get: () => string, set: (s: string) => void) => {
        const original = get();
        if (!original) return;
        if (opts.dedupeReads && original.length >= 2000) {
          const h = createHash('sha1').update(original).digest('hex');
          const first = seen.get(h);
          if (first !== undefined && first !== mi) {
            const note = `[grug: identical to an earlier tool result in this conversation (message #${first + 1}); refer to that copy. Starts: ${original.slice(0, 80).replace(/\s+/g, ' ')}…]`;
            set(note);
            report.dedupedResults++;
            report.trimmedChars += original.length - note.length;
            return;
          }
          if (first === undefined) seen.set(h, mi);
        }
        if (opts.trimToolResults) {
          const r = trimToolOutput(original, opts.trim);
          if (r.changed) {
            set(r.text);
            report.trimmedResults++;
            report.trimmedChars += r.removedChars;
          }
        }
      };
      if (typeof block.content === 'string') {
        apply(
          () => block.content,
          (s) => (block.content = s)
        );
      } else if (Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner && inner.type === 'text' && typeof inner.text === 'string') {
            apply(
              () => inner.text,
              (s) => (inner.text = s)
            );
          }
        }
      }
    }
  });

  // 3. Cache breakpoints, only when the client set none.
  if (opts.autoCache && !body.cache_control && countBreakpoints(body) === 0) {
    const staticText =
      JSON.stringify(body.tools || '') + (typeof body.system === 'string' ? body.system : JSON.stringify(body.system || ''));
    const staticTokens = estimateTokens(staticText);
    let budget = MAX_BREAKPOINTS;

    if (Array.isArray(body.tools) && body.tools.length && staticTokens >= 1024 && budget > 0) {
      body.tools[body.tools.length - 1].cache_control = { type: 'ephemeral' };
      report.breakpointsAdded++;
      budget--;
    }
    if (body.system && staticTokens >= 1024 && budget > 0) {
      if (typeof body.system === 'string') body.system = [{ type: 'text', text: body.system }];
      const last = [...body.system].reverse().find((b: any) => b && b.type === 'text' && b.text);
      if (last) {
        last.cache_control = { type: 'ephemeral' };
        report.breakpointsAdded++;
        budget--;
      }
    }
    // Conversation breakpoint on the last user turn: only worth a cache write when the
    // conversation will be continued (multi-turn) or the prefix is big.
    const convoTokens = estimateTokens(JSON.stringify(body.messages));
    if (budget > 0 && (body.messages.length >= 3 || convoTokens + staticTokens >= 4096)) {
      for (let i = body.messages.length - 1; i >= 0; i--) {
        const m = body.messages[i];
        if (m.role !== 'user') continue;
        if (typeof m.content === 'string') {
          if (!m.content) break;
          m.content = [{ type: 'text', text: m.content }];
        }
        const target = [...m.content].reverse().find(
          (b: any) => b && CACHEABLE_TYPES.has(b.type) && !(b.type === 'text' && !b.text)
        );
        if (target) {
          target.cache_control = { type: 'ephemeral' };
          report.breakpointsAdded++;
        }
        break;
      }
    }
  }

  report.trimmedTokens = Math.round(report.trimmedChars / 3.6);
  report.changed = report.breakpointsAdded > 0 || report.trimmedResults > 0 || report.dedupedResults > 0;
  return report;
}

/** Project label for stats: first cwd-looking path in the system prompt, if any. */
export function guessProject(body: any): string | undefined {
  const sys = typeof body?.system === 'string' ? body.system : textOf(body?.system);
  const m = sys.match(/Working directory:\s*(\S+)/i) || sys.match(/\bcwd[:=]\s*(\S+)/i);
  return m ? m[1].split('/').filter(Boolean).pop() : undefined;
}
