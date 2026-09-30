/**
 * One honest headline number: what grug saved, as a share of what you would have spent.
 * saved = tokens grug kept out of context (valued once at the input price of the model you use most)
 *       + prompt-cache savings on requests where grug added the cache
 *       - what grug's own additions cost (memory briefs, recalls, code hints, avoidable cache misses).
 * Conservative: the later replies that no longer re-read those tokens are not counted, and neither
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
}

export interface Savings {
  spendUsd: number;
  savedUsd: number;
  costUsd: number;
  netUsd: number;
  /** net / (spend + net), 0..1 */
  pct: number;
  parts: SavingPart[];
  requests: number;
}

const GROUPS: Array<{ key: string; label: string; kinds: string[] }> = [
  { key: 'trim', label: 'Trimmed tool output', kinds: ['trim', 'dedupe'] },
  { key: 'cmdrules', label: 'Install/build noise', kinds: ['cmdrules'] },
  { key: 'testsum', label: 'Test summaries', kinds: ['testsum'] },
  { key: 'json', label: 'Compact JSON', kinds: ['json'] },
  { key: 'reads', label: 'Read guards', kinds: ['read-guard', 'reread', 'outline'] },
  { key: 'media', label: 'Images/PDF/video', kinds: ['media'] },
  { key: 'handoff', label: 'Handoff after /clear', kinds: ['handoff'] }
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
    parts.push({ key: g.key, label: g.label, tokens, usd: tokens * price, count });
  }
  parts.push({ key: 'cache', label: 'Prompt cache (added by grug)', tokens: 0, usd: s.grugCacheSavedUsd, count: 0 });
  const spentTokens = Object.values(s.savedByKind).reduce((n, v) => n + (v < 0 ? -v : 0), 0);
  const costUsd = spentTokens * price;
  const savedUsd = parts.reduce((n, p) => n + p.usd, 0);
  const netUsd = Math.max(0, savedUsd - costUsd);
  const denom = s.costUsd + netUsd;
  return { spendUsd: s.costUsd, savedUsd, costUsd, netUsd, pct: denom > 0 ? netUsd / denom : 0, parts: parts.filter((p) => p.usd > 0 || p.count > 0), requests: s.requests };
}
