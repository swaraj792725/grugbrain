/**
 * Task-boundary detection: is this prompt the start of a different job? A big context re-read on
 * every reply is the wrong thing to drag into unrelated work, and /clear is free with a handoff.
 * Deliberately conservative (a wrong nudge is noise): needs several content words, zero overlap with
 * what the session has been about, no "continue"-style opening, and a context big enough to matter.
 */

import * as path from 'node:path';
import { alternatives, queryTerms } from './relevance.js';
import { BufferEvent } from './memory/store.js';

const CONTINUATION = /^\s*(also|and|then|now|next|ok(ay)?|great|thanks?|thx|cool|yes|yep|no|but|so|continue|keep|same|again|that|it|this|these|those|why|what about|how about|can you also|one more|last|finally|actually|wait|hmm)\b/i;

/** Words describing what the session has been about: recent prompts and the files it touched. */
function sessionTerms(events: BufferEvent[]): Set<string> {
  const out = new Set<string>();
  const add = (t: string) => {
    out.add(t);
    for (const a of alternatives(t)) out.add(a);
  };
  const prompts = events.filter((e) => e.t === 'prompt').slice(-6) as Array<Extract<BufferEvent, { t: 'prompt' }>>;
  for (const p of prompts) queryTerms(p.text, 20).forEach(add);
  const files = events.filter((e) => e.t === 'file').slice(-30) as Array<Extract<BufferEvent, { t: 'file' }>>;
  for (const f of files) queryTerms(path.basename(f.path).replace(/\.[^.]+$/, ''), 6).forEach(add);
  return out;
}

/** True when `prompt` looks like a new task compared with what this session has been doing. */
export function looksLikeNewTask(prompt: string, events: BufferEvent[]): boolean {
  if (CONTINUATION.test(prompt)) return false;
  const terms = queryTerms(prompt, 20);
  if (terms.length < 4) return false;
  const prior = events.filter((e) => e.t === 'prompt');
  if (prior.length < 3) return false; // not enough history to call anything a switch
  const known = sessionTerms(events);
  return !terms.some((t) => known.has(t) || known.has(t.replace(/(ing|ed|es|s)$/, '')));
}
