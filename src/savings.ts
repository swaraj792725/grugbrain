/**
 * One headline number: what grug saved overall, as a share of what you would have spent.
 * saved = tokens grug kept out of context (valued once at the input price of the model you use most)
 *       + the smaller chat from auto-compaction (tokens not re-read on later replies, at cache-read price)
 *       + prompt-cache savings on requests where grug added the cache
 *       - what grug's own additions cost (memory briefs, recalls, code hints, avoidable cache misses).
 * Each part carries a tier so the UI can say how sure it is:
 *   measured = content grug really removed (sizes are real, tokens estimated from text length);
 *   derived  = computed from real context-size drops in your transcripts, assuming the chat would
 *              otherwise have stayed that big (capped at your usual chat size);
 *   estimate = prompt-cache attribution.
 * Conservative: memory's benefit is not counted. The handoff after /clear or compact has no dollar value of its
 * own (the smaller-chat part already counts the benefit; counting both would double count it).
 */

import { summarize, Summary } from './stats.js';
import { priceFor } from './tokens.js';

export interface SavingPart {
  key: string;
  label: string;
  usd: number;
  tokens: number;
  count: number;
  /** How sure: measured (really removed), derived (from real context drops), estimate (modeled). */
  tier: 'measured' | 'derived' | 'estimate';
  measured: boolean;
}

export interface Savings {
  spendUsd: number;
  /** All savings before grug's own costs. */
  savedUsd: number;
  costUsd: number;
  /** Headline: overall savings minus grug's costs. */
  netUsd: number;
  /** net / (spend + net), 0..1 */
  pct: number;
  /** Of the gross savings, the part that is not plain measured text cutting (derived + estimate). */
  estimatedUsd: number;
  /** Headline restricted to measured text cutting only, for "of which". */
  measuredNetUsd: number;
  measuredPct: number;
  parts: SavingPart[];
  requests: number;
}

const GROUPS: Array<{ key: string; label: string; kinds: string[] }> = [
  { key: 'trim', label: 'Shortened long tool output', kinds: ['trim', 'dedupe'] },
  { key: 'cmdrules', label: 'Cut install/build clutter', kinds: ['cmdrules'] },
  { key: 'testsum', label: 'Summarised test results', kinds: ['testsum'] },
  { key: 'json', label: 'Shrunk big JSON data', kinds: ['json'] },
  { key: 'reads', label: 'Avoided re-reading files', kinds: ['read-guard', 'reread', 'outline'] },
  { key: 'media', label: 'Smaller images, PDFs, video', kinds: ['media'] },
  { key: 'handoff', label: 'Kept the work after /clear or compact', kinds: ['handoff'] }
];

/** Counted for how often it happened, not priced (see the header note). */
const UNPRICED = new Set(['handoff']);

function topModel(s: Summary): string {
  const top = Object.entries(s.byModel).sort((a, b) => b[1].costUsd - a[1].costUsd)[0];
  return top ? top[0] : 'claude-sonnet-5-5';
}

export function computeSavings(sinceMs = 0, s: Summary = summarize(sinceMs)): Savings {
  const price = priceFor(topModel(s)).input / 1e6;
  const parts: SavingPart[] = [];
  for (const g of GROUPS) {
    let tokens = g.kinds.reduce((n, k) => n + Math.max(0, s.savedByKind[k] || 0), 0);
    if (g.key === 'trim') tokens += s.trimmedTokens;
    const count = g.kinds.reduce((n, k) => n + (s.countByKind[k] || 0), 0);
    const usd = UNPRICED.has(g.key) ? 0 : tokens * price;
    parts.push({ key: g.key, label: g.label, tokens: UNPRICED.has(g.key) ? 0 : tokens, usd, count, tier: 'measured', measured: true });
  }
  parts.push({ key: 'context', label: 'Smaller chat (auto-compaction)', tokens: s.ctxCutTokens, usd: s.ctxCutUsd, count: 0, tier: 'derived', measured: false });
  parts.push({ key: 'cache', label: 'Better prompt caching', tokens: 0, usd: s.grugCacheSavedUsd, count: 0, tier: 'estimate', measured: false });
  const spentTokens = Object.values(s.savedByKind).reduce((n, v) => n + (v < 0 ? -v : 0), 0);
  const costUsd = spentTokens * price;
  const savedUsd = parts.reduce((n, p) => n + p.usd, 0);
  const measuredUsd = parts.filter((p) => p.measured).reduce((n, p) => n + p.usd, 0);
  const netUsd = Math.max(0, savedUsd - costUsd);
  const measuredNetUsd = Math.max(0, measuredUsd - costUsd);
  const share = (n: number) => (s.costUsd + n > 0 ? n / (s.costUsd + n) : 0);
  return {
    spendUsd: s.costUsd,
    savedUsd,
    estimatedUsd: savedUsd - measuredUsd,
    costUsd,
    netUsd,
    pct: share(netUsd),
    measuredNetUsd,
    measuredPct: share(measuredNetUsd),
    parts: parts.filter((p) => p.usd > 0 || p.count > 0),
    requests: s.requests
  };
}
