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
    'thanks thank hey hello hi ok good great nice cool fine sure right well much many lot little bit something anything everything')
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
  /** Distinct query terms found. */
  matched: number;
  /** Share of the query's total rarity (idf) that this doc covers, 0..1. */
  coverage: number;
  /** Position of the rarest matched term (for excerpts). */
  pos: number;
}

/**
 * BM25 over `docs` (already lowercased). `weights[i]` multiplies doc i's score.
 * Returns only docs matching at least one term, best first.
 */
export function rank(docs: string[], terms: string[], weights?: number[], phrase?: string): Ranked[] {
  const N = docs.length;
  if (!N || !terms.length) return [];
  const k1 = 1.2;
  const b = 0.75;
  let total = 0;
  for (const d of docs) total += d.length;
  const avg = Math.max(1, total / N);
  const tf: number[][] = terms.map(() => []);
  const df = terms.map(() => 0);
  for (let t = 0; t < terms.length; t++) {
    for (let i = 0; i < N; i++) {
      const c = docs[i].includes(terms[t]) ? countIn(docs[i], terms[t]) : 0;
      if (c) {
        tf[t][i] = c;
        df[t]++;
      }
    }
  }
  const idf = df.map((d) => Math.log(1 + (N - d + 0.5) / (d + 0.5)));
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
      const f = tf[t][i];
      if (!f) continue;
      matched++;
      cov += idf[t];
      score += (idf[t] * f * (k1 + 1)) / (f + norm);
      if (idf[t] > best) {
        best = idf[t];
        pos = docs[i].indexOf(terms[t]);
      }
    }
    if (!matched) continue;
    if (phrase && phrase.length > 8 && docs[i].includes(phrase)) score += idfSum / terms.length;
    out.push({ index: i, score: score * (weights ? weights[i] ?? 1 : 1), matched, coverage: cov / idfSum, pos });
  }
  return out.sort((a, c) => c.score - a.score);
}

/**
 * Relevance gate for auto-injection: clearly on-topic, not a lone common word.
 * Coverage (rarity-weighted) works on big corpora; on tiny ones (a handful of memory notes) idf is
 * noisy, so a doc sharing at least a third of the prompt's content words also qualifies.
 */
export function isRelevant(r: Ranked, nTerms: number, minCoverage = 0.4, minShare = 0.34): boolean {
  if (r.matched >= 2 && (r.coverage >= minCoverage || r.matched / nTerms >= minShare)) return true;
  return nTerms <= 3 && r.matched >= 1 && r.coverage >= 0.6;
}
