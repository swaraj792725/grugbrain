/**
 * Caveman: two tools.
 *  - terseStyle(): the instruction injected at session start so Claude *answers* in fewer tokens.
 *    Output tokens cost ~5x input tokens, so this is where talk-less pays most.
 *  - cavemanCompress(): strips pleasantries from text you paste, never touching code, paths,
 *    URLs, quotes or inline `code`.
 */

import { estimateTokens } from '../tokens.js';

export type TerseLevel = 'off' | 'lite' | 'full';

export function terseStyle(level: TerseLevel): string {
  if (level === 'off') return '';
  if (level === 'lite') {
    return [
      'Output style (set by grugbrain to save tokens):',
      '- Be concise. No preamble, no restating the question, no closing summary or "let me know" offers.',
      '- Prefer bullets and code over paragraphs. Do not narrate routine tool calls.',
      '- Never shorten code, commands, file paths, error messages or technical detail.'
    ].join('\n');
  }
  return [
    'Output style (set by grugbrain "full" mode): talk like caveman.',
    '- Few words. Drop articles, filler, pleasantries, hedging. Fragments OK. "Bug in auth. Fix: check token expiry."',
    '- No preamble, no recap, no offers. Answer, then stop.',
    '- Code, commands, paths, identifiers, numbers and error text stay exact and complete. Caveman talk only in prose.'
  ].join('\n');
}

export interface CompressResult {
  text: string;
  originalTokens: number;
  compressedTokens: number;
  tokensSaved: number;
  percentSaved: number;
}

// Pure politeness / padding only. Nothing that carries intent or constraints.
const FILLERS: RegExp[] = [
  /\b(could|can|would) you (please |kindly )?(help me |go ahead and )?(?=\w)/gi,
  /\bwould you mind\s+/gi,
  /\bplease\s+(?=\w)/gi,
  /\bkindly\s+/gi,
  /\bi would (really )?(like|love) (for )?you to\s+/gi,
  /\bi was wondering if you could\s+/gi,
  /\bif (it'?s|it is) not too much trouble,?\s*/gi,
  /\b(thanks|thank you)( so much| very much)?( in advance)?[.!]*\s*/gi,
  /\bi hope (this|that) (helps|makes sense)[.!]*\s*/gi,
  /\b(it is|it's) (important|worth) (to note|noting) that\s+/gi,
  /\bit goes without saying that\s+/gi,
  /\bas a matter of fact,?\s+/gi,
  /\bat the end of the day,?\s+/gi,
  /\bin order to\b/gi, // -> "to" (handled below)
  /\bdue to the fact that\b/gi // -> "because"
];

const REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bin order to\b/gi, 'to'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\bwith regard(s)? to\b/gi, 'about'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bfor the purpose of\b/gi, 'for'],
  [/\bin the event that\b/gi, 'if']
];

export function cavemanCompress(input: string): CompressResult {
  const originalTokens = estimateTokens(input);
  if (!input) return { text: '', originalTokens: 0, compressedTokens: 0, tokensSaved: 0, percentSaved: 0 };

  // Protect anything where exact bytes matter.
  const kept: string[] = [];
  const protect = (m: string) => `\u0000${kept.push(m) - 1}\u0000`;
  let t = input
    .replace(/```[\s\S]*?```/g, protect)
    .replace(/`[^`\n]+`/g, protect)
    .replace(/https?:\/\/\S+/g, protect)
    .replace(/"[^"\n]*"|'[^'\n]{2,}'(?!\w)/g, protect)
    .replace(/(?:~|\.{1,2})?\/[\w.\-/]+/g, protect);

  for (const [re, rep] of REPLACEMENTS) t = t.replace(re, rep);
  for (const re of FILLERS.slice(0, -2)) t = t.replace(re, '');

  t = t
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?;:])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/(^|[.!?]\s+|\n)([a-z])/g, (_m, p, c) => p + c.toUpperCase())
    .trim();

  t = t.replace(/\u0000(\d+)\u0000/g, (_m, i) => kept[Number(i)]);
  const compressedTokens = estimateTokens(t);
  const tokensSaved = Math.max(0, originalTokens - compressedTokens);
  return {
    text: t,
    originalTokens,
    compressedTokens,
    tokensSaved,
    percentSaved: originalTokens ? Math.round((tokensSaved / originalTokens) * 100) : 0
  };
}
