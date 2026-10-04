/**
 * SessionStart also fires on --resume (and when the app reopens a session). The conversation comes back whole, so
 * grug's start context (output style, batch rule, memory brief, code map) is already in it; sending it again
 * measured ~8k extra tokens of code map alone over a 6-prompt bench session, plus cache writes for each copy.
 * This finds which of grug's start blocks are still in the conversation (after the last compaction).
 */

import { readTail } from './handoff.js';
import { BATCH_RULE } from './batching.js';

export type StartBlock = 'style' | 'batch' | 'memory' | 'map';

const MARKERS: [StartBlock, string][] = [
  ['style', 'Output style (set by grugbrain'],
  ['batch', BATCH_RULE.slice(0, 60)],
  ['memory', '[grugbrain memory:'],
  ['map', '[grugbrain code map:']
];

/** Grug start blocks already present in the conversation since its last compaction (empty when unsure). */
export function startBlocksInContext(transcript: string | undefined, maxBytes = 48 * 1024 * 1024): Set<StartBlock> {
  const found = new Set<StartBlock>();
  if (!transcript) return found;
  for (const line of readTail(transcript, maxBytes).split('\n')) {
    if (line.includes('"compact_boundary"') || line.includes('"isCompactSummary":true')) {
      found.clear(); // everything before a compaction is gone from the conversation
      continue;
    }
    if (!line.includes('hook_additional_context') || !line.includes('grugbrain')) continue;
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e?.attachment?.type !== 'hook_additional_context') continue;
    const c = e.attachment.content;
    const text = Array.isArray(c) ? c.join('\n') : String(c ?? '');
    for (const [k, m] of MARKERS) if (text.includes(m)) found.add(k);
  }
  return found;
}
