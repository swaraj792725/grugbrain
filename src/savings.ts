/**
 * One honest headline number: what grug saved, as a share of what you would have spent.
 * saved = tokens grug kept out of context (valued once at the input price of the model you use most)
 *       - what grug's own additions cost (memory briefs, recalls, code hints, avoidable cache misses).
 * The headline counts only MEASURED savings: content grug actually removed before it entered context
 * (sizes before/after are real; tokens are estimated from text length). Modeled savings (a handoff
 * replacing an old context, prompt-cache attribution) are reported separately as `estimatedUsd` and never
 * enter the headline. Conservative: the later replies that no longer re-read those tokens are not counted, and neither
 * is the benefit of memory. Estimates, labelled as such in the UI.
 */

import { summarize, Summary } from './stats.js';
import { priceFor } from './tokens.js';

export interface SavingPart {
  key: string;
  label: string;
  usd: number;
  tokens: number;
  count: number;
  /** false = modeled (assumes what would have happened); excluded from the headline. */
  measured: boolean;
}

export interface Savings {
  spendUsd: number;
  /** Measured savings before grug's own costs. */
  savedUsd: number;
  costUsd: number;
  /** Headline: measured savings minus grug's costs. */
  netUsd: number;
  /** net / (spend + net), 0..1 */
  pct: number;
  /** Modeled extra (handoff, cache attribution), not in the headline. */
  estimatedUsd: number;
  parts: SavingPart[];
  requests: number;
}

const MODELED = new Set(['handoff', 'cache']);
const GROUPS: Array<{ key: string; label: string; kinds: string[] }> = [
  { key: 'trim', label: 'Shortened long tool output', kinds: ['trim', 'dedupe'] },
  { key: 'cmdrules', label: 'Cut install/build clutter', kinds: ['cmdrules'] },
  { key: 'testsum', label: 'Summarised test results', kinds: ['testsum'] },
  { key: 'json', label: 'Shrunk big JSON data', kinds: ['json'] },
  { key: 'reads', label: 'Avoided re-reading files', kinds: ['read-guard', 'reread', 'outline'] },
  { key: 'media', label: 'Smaller images, PDFs, video', kinds: ['media'] },
  { key: 'handoff', label: 'Kept the work after /clear or compact', kinds: ['handoff'] }
];

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
    parts.push({ key: g.key, label: g.label, tokens, usd: tokens * price, count, measured: !MODELED.has(g.key) });
  }
  parts.push({ key: 'cache', label: 'Better prompt caching', tokens: 0, usd: s.grugCacheSavedUsd, count: 0, measured: false });
  const spentTokens = Object.values(s.savedByKind).reduce((n, v) => n + (v < 0 ? -v : 0), 0);
  const costUsd = spentTokens * price;
  const savedUsd = parts.filter((p) => p.measured).reduce((n, p) => n + p.usd, 0);
  const estimatedUsd = parts.filter((p) => !p.measured).reduce((n, p) => n + p.usd, 0);
  const netUsd = Math.max(0, savedUsd - costUsd);
  const denom = s.costUsd + netUsd;
  return { spendUsd: s.costUsd, savedUsd, estimatedUsd, costUsd, netUsd, pct: denom > 0 ? netUsd / denom : 0, parts: parts.filter((p) => p.usd > 0 || p.count > 0), requests: s.requests };
}
