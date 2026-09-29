/**
 * Token estimation and pricing.
 * Estimates are only used where no real count exists; the proxy records real `usage` numbers.
 */

/** Rough token estimate. Code and symbols tokenize denser than prose. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const len = text.length;
  const sample = text.length > 4000 ? text.slice(0, 4000) : text;
  const symbols = (sample.match(/[{}()[\];=<>+\-*/\\|&^%$#@!~`"',.:]/g) || []).length;
  const ratio = symbols / sample.length > 0.08 ? 3.2 : 4.0;
  return Math.ceil(len / ratio);
}

export interface ModelPrice {
  input: number; // $ per 1M tokens
  output: number;
}

// Order matters: first prefix match wins.
const PRICES: Array<[string, ModelPrice]> = [
  ['claude-fable', { input: 10, output: 50 }],
  ['claude-mythos', { input: 10, output: 50 }],
  ['claude-opus-5-5', { input: 4, output: 20 }],
  ['claude-opus', { input: 5, output: 25 }],
  ['claude-sonnet-5', { input: 2, output: 10 }],
  ['claude-sonnet', { input: 3, output: 15 }],
  ['claude-haiku', { input: 1, output: 5 }]
];

export function priceFor(model: string | undefined): ModelPrice {
  const m = (model || '').replace(/^(us\.|eu\.)?anthropic\./, '');
  for (const [prefix, price] of PRICES) if (m.startsWith(prefix)) return price;
  return { input: 3, output: 15 };
}

export const CACHE_READ_MULT = 0.1;
export const CACHE_WRITE_MULT = 1.25; // 5-minute TTL
export const CACHE_WRITE_1H_MULT = 2; // 1-hour TTL

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

/** Cache-write cost multiplier weighted by TTL mix (1h writes cost 2x, 5m writes 1.25x). */
export function cacheWriteMult(u: Usage): number {
  const total = u.cache_creation_input_tokens || 0;
  const h1 = u.cache_creation?.ephemeral_1h_input_tokens || 0;
  if (!total || !h1) return CACHE_WRITE_MULT;
  const m5 = Math.max(0, total - h1);
  return (h1 * CACHE_WRITE_1H_MULT + m5 * CACHE_WRITE_MULT) / total;
}

/** Actual $ cost of a request. */
export function costOf(model: string | undefined, u: Usage): number {
  const p = priceFor(model);
  const inp = (u.input_tokens || 0) * p.input;
  const read = (u.cache_read_input_tokens || 0) * p.input * CACHE_READ_MULT;
  const write = (u.cache_creation_input_tokens || 0) * p.input * cacheWriteMult(u);
  const out = (u.output_tokens || 0) * p.output;
  return (inp + read + write + out) / 1e6;
}

/** $ saved by cache reads vs. paying full input price for those tokens. */
export function cacheSavingsOf(model: string | undefined, u: Usage): number {
  const p = priceFor(model);
  return ((u.cache_read_input_tokens || 0) * p.input * (1 - CACHE_READ_MULT)) / 1e6;
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

export function fmtUsd(n: number): string {
  if (n >= 100) return '$' + n.toFixed(0);
  if (n >= 1) return '$' + n.toFixed(2);
  return '$' + n.toFixed(4);
}
