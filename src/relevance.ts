/**
 * Small, model-free relevance scoring shared by history search and auto-recall.
 * BM25-style: a term that shows up everywhere ("test", "file") counts for little, a rare one
 * (an error code, a function name) counts for a lot. Matching is substring-based and case-free,
 * so "undici" finds "undici's" and "searchHistory" finds "searchhistory".
 */

const STOP = new Set(
  ('the and for with that this from what have has had was were are you your but not can could should would will how why when where which ' +
    'into about there their then than just also please make sure want need like let lets get got now here some any all each more most other ' +
    'such only own same very really still again maybe okay yes yeah its it\'s our out use using used one two new way thing things stuff ' +
    'does did done doing been being them they him her she his who whom whose above below over under after before while because since ' +
    'i\'m i\'d i\'ll we\'re don\'t doesn\'t didn\'t isn\'t can\'t won\'t lets see look try show tell give take put keep know think go going ' +
    'thanks thank hey hello hi ok good great nice cool fine sure right well much many lot little bit something anything everything ' +
    'quickly early often sometimes actually basically exactly currently properly correctly come comes came happen happens happened')
    .split(' ')
);

const TRIVIAL = /^\s*(ok(ay)?|k|yes|yep|yeah|no|nope|y|n|sure|thanks?( you)?|ty|thx|go( ahead| on)?|continue|proceed|do it|lgtm|done|next|great|nice|cool|perfect|good|right|please|again|retry|try again|keep going|sounds good|looks good|ship it|merge it)[\s.!?]*$/i;

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith('ed') && !w.endsWith('eed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

/** Content words of a query: lowercased, stop words dropped, identifiers kept whole and split into parts. */
export function queryTerms(text: string, max = 12): string[] {
  const out: string[] = [];
  const add = (w: string) => {
    w = w.toLowerCase().replace(/^[./-]+|[./-]+$/g, '');
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) return;
    const s = /[./_-]/.test(w) ? w : stem(w);
    if (s.length >= 3 && !out.includes(s)) out.push(s);
  };
  for (const raw of text.match(/[A-Za-z0-9_][A-Za-z0-9_./-]*/g) || []) {
    add(raw);
    // camelCase / snake_case / path parts
    const parts = raw.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s_./-]+/);
    if (parts.length > 1) for (const p of parts) add(p);
  }
  return out.slice(0, max);
}

/**
 * Developer vocabulary that means the same thing in a prompt and in a note ("authentication" vs
 * "login"). A prompt word with no direct hit in a note can still match through its group, at
 * reduced credit, so paraphrases find their note while the relevance gate stays as strict.
 */
const SYNONYM_GROUPS: string[][] = [
  ['auth', 'login', 'signin', 'sign-in', 'authenticate', 'authentication', 'logon', 'sso', 'oauth'],
  ['password', 'credential', 'passphrase'],
  ['hash', 'argon', 'bcrypt', 'encrypt', 'salt'],
  ['expire', 'expiry', 'expiration', 'ttl', 'timeout'],
  ['database', 'db', 'sql', 'postgres', 'postgresql', 'mysql', 'sqlite', 'schema', 'migration', 'migrate'],
  ['webhook', 'callback', 'hook'],
  ['duplicate', 'dedupe', 'idempotent', 'idempotency', 'twice', 'double'],
  ['slow', 'latency', 'performance', 'speed', 'faster', 'optimize', 'optimise', 'sluggish', 'throughput'],
  ['config', 'configuration', 'settings', 'environment', 'env', 'dotenv'],
  ['test', 'spec', 'unittest', 'suite', 'jest', 'vitest', 'pytest'],
  ['log', 'logs', 'logger', 'logging', 'trace', 'tracing', 'pino', 'winston'],
  ['job', 'worker', 'queue', 'task', 'background'],
  ['retry', 'retries', 'retried', 'backoff', 'attempt'],
  ['deploy', 'release', 'publish', 'ship', 'rollout', 'prod', 'production'],
  ['flag', 'toggle', 'launchdarkly', 'experiment'],
  ['cache', 'cached', 'caching', 'refresh', 'invalidate', 'stale', 'cdn', 'bust'],
  ['avatar', 'picture', 'image', 'photo', 'thumbnail', 'profile'],
  ['resize', 'scale', 'shrink', 'crop'],
  ['translation', 'translate', 'language', 'locale', 'english', 'i18n', 'l10n'],
  ['schedule', 'scheduler', 'cron', 'nightly', 'daily', 'periodic'],
  ['memory', 'ram', 'heap', 'leak'],
  ['socket', 'websocket'],
  ['server', 'gateway', 'backend'],
  ['lint', 'eslint', 'prettier', 'warning'],
  ['error', 'exception', 'crash', 'fail', 'failure', 'bug', 'broken'],
  ['delete', 'remove', 'drop'],
  ['dependency', 'package', 'library'],
  ['api', 'endpoint', 'route', 'rest'],
  ['email', 'mail', 'smtp', 'postmark']
];

/** Suffix-insensitive key so "pictures"/"picture", "scaled"/"scale", "retries"/"retry" meet. */
function loose(w: string): string {
  if (/[./_-]/.test(w)) return w;
  return stem(w).replace(/[aeiouy]+$/, '') || w;
}

const GROUP_OF = new Map<string, number[]>();
SYNONYM_GROUPS.forEach((g, i) => {
  for (const w of g) {
    const k = loose(w);
    GROUP_OF.set(k, [...(GROUP_OF.get(k) || []), i]);
  }
});

/** Other words of the same concept(s) as `term` (stemmed like query terms), never the term itself. */
export function alternatives(term: string): string[] {
  const out: string[] = [];
  for (const gi of GROUP_OF.get(loose(term)) || []) {
    for (const w of SYNONYM_GROUPS[gi]) {
      const k = /[./_-]/.test(w) ? w : stem(w);
      if (loose(k) !== loose(term) && !out.includes(k)) out.push(k);
    }
  }
  return out;
}

/** "ok", "yes", "go ahead", or fewer than 3 content words: nothing worth recalling. */
export function isTrivialPrompt(prompt: string): boolean {
  const p = prompt.trim();
  if (!p || TRIVIAL.test(p)) return true;
  if (p.startsWith('/')) return true; // slash commands
  const words = (p.match(/[A-Za-z0-9_][A-Za-z0-9_./-]*/g) || []).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()));
  return words.length < 3;
}

function countIn(hay: string, term: string): number {
  let n = 0;
  let i = hay.indexOf(term);
  while (i >= 0 && n < 20) {
    // very short terms must start a word ("log" should not match "catalog")
    if (term.length > 3 || i === 0 || !/[a-z0-9]/.test(hay[i - 1])) n++;
    i = hay.indexOf(term, i + term.length);
  }
  return n;
}

export interface Ranked {
  index: number;
  score: number;
  /** Distinct query terms found (a synonym counts 0.6). */
  matched: number;
  /** How many query terms the score was computed against (a clause, or the whole prompt). */
  nTerms: number;
  /** Share of the query's total rarity (idf) that this doc covers, 0..1. */
  coverage: number;
  /** Position of the rarest matched term (for excerpts). */
  pos: number;
}

/**
 * BM25 over `docs` (already lowercased). `weights[i]` multiplies doc i's score.
 * Returns only docs matching at least one term, best first.
 */
const ALT_CREDIT = 0.6;

export interface RankOptions {
  /** Count synonyms of unmatched terms at reduced credit. */
  alternatives?: boolean;
  /** Per-term counts, shared by several rank() calls over the same docs (the clauses of one prompt). */
  cache?: Map<string, { f: Uint8Array; df: number }>;
}

export function rank(docs: string[], terms: string[], weights?: number[], phrase?: string, opts: RankOptions | boolean = {}): Ranked[] {
  const o: RankOptions = typeof opts === 'boolean' ? { alternatives: opts } : opts;
  const N = docs.length;
  if (!N || !terms.length) return [];
  const alts = terms.map((t) => (o.alternatives ? alternatives(t).filter((a) => !terms.includes(a)) : []));
  const k1 = 1.2;
  const b = 0.75;
  let total = 0;
  for (const d of docs) total += d.length;
  const avg = Math.max(1, total / N);
  const cache = o.cache ?? new Map<string, { f: Uint8Array; df: number }>();
  const counts = terms.map((term) => {
    let c = cache.get(term);
    if (!c) {
      const f = new Uint8Array(N);
      let df = 0;
      for (let i = 0; i < N; i++) {
        const n = docs[i].includes(term) ? countIn(docs[i], term) : 0;
        if (n) {
          f[i] = n;
          df++;
        }
      }
      c = { f, df };
      cache.set(term, c);
    }
    return c;
  });
  const idf = counts.map((c) => Math.log(1 + (N - c.df + 0.5) / (c.df + 0.5)));
  const idfSum = idf.reduce((a, x) => a + x, 0) || 1;
  const out: Ranked[] = [];
  for (let i = 0; i < N; i++) {
    let score = 0;
    let matched = 0;
    let cov = 0;
    let pos = -1;
    let best = -1;
    const norm = k1 * (1 - b + (b * docs[i].length) / avg);
    for (let t = 0; t < terms.length; t++) {
      let f = counts[t].f[i];
      let credit = 1;
      let hitTerm = terms[t];
      if (!f && alts[t].length) {
        // No direct hit: the best-matching word of the same concept counts at reduced credit.
        for (const a of alts[t]) {
          if (!docs[i].includes(a)) continue;
          const c = countIn(docs[i], a);
          if (c > f) {
            f = c;
            hitTerm = a;
          }
        }
        credit = ALT_CREDIT;
      }
      if (!f) continue;
      matched += credit;
      cov += idf[t] * credit;
      score += (credit * (idf[t] * f * (k1 + 1))) / (f + norm);
      if (idf[t] * credit > best) {
        best = idf[t] * credit;
        pos = docs[i].indexOf(hitTerm);
      }
    }
    if (!matched) continue;
    if (phrase && phrase.length > 8 && docs[i].includes(phrase)) score += idfSum / terms.length;
    out.push({ index: i, score: score * (weights ? weights[i] ?? 1 : 1), matched, nTerms: terms.length, coverage: cov / idfSum, pos });
  }
  return out.sort((a, c) => c.score - a.score);
}

/**
 * The whole prompt's terms, plus each clause's when the prompt has several parts ("why does X
 * expire? also tidy the docs"). Extra words dilute a relevance score, so a question buried in a
 * long prompt is also scored on its own; every clause must still clear the same gate by itself.
 */
export function promptSegments(prompt: string, maxSegments = 4): string[][] {
  const whole = queryTerms(prompt);
  const out: string[][] = [whole];
  const clauses = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/(?<=[.?!;:])\s+|\n+/)
    .map((c) => queryTerms(c))
    .filter((t) => t.length >= 2 && t.length < whole.length);
  for (const t of clauses) {
    if (out.length >= maxSegments) break;
    if (!out.some((o) => o.length === t.length && o.every((x, i) => x === t[i]))) out.push(t);
  }
  return out;
}

/** rank() over every segment of the prompt; each doc keeps the segment that explains it best. */
export function rankPrompt(docs: string[], prompt: string, weights?: number[]): Ranked[] {
  const segs = promptSegments(prompt);
  const phrase = prompt.toLowerCase().trim();
  const best = new Map<number, Ranked>();
  const cache = new Map<string, { f: Uint8Array; df: number }>();
  segs.forEach((terms, k) => {
    for (const r of rank(docs, terms, weights, k === 0 ? phrase : undefined, { alternatives: true, cache })) {
      const cur = best.get(r.index);
      if (!cur || r.coverage * Math.min(2, r.matched) > cur.coverage * Math.min(2, cur.matched)) best.set(r.index, r);
    }
  });
  return [...best.values()].sort((a, c) => c.score - a.score);
}

/**
 * Relevance gate for auto-injection: clearly on-topic, not a lone common word.
 * Coverage (rarity-weighted) works on big corpora; on tiny ones (a handful of memory notes) idf is
 * noisy, so a doc sharing at least a third of the prompt's content words also qualifies.
 */
export function isRelevant(r: Ranked, nTerms: number, minCoverage = 0.4, minShare = 0.34): boolean {
  // 1.5+ = at least two concepts matched, one of them directly (a synonym alone is worth 0.6).
  if (r.matched >= 1.5 && (r.coverage >= minCoverage || r.matched / nTerms >= minShare)) return true;
  return nTerms <= 3 && r.matched >= 1 && r.coverage >= 0.6;
}
