/**
 * Caveman Engine: Ultra-concise prompt & context compression.
 * Strips conversational fluff, filler phrases, and redundant boilerplate 
 * while preserving exact code blocks, identifiers, and technical semantics intact.
 */

export interface CavemanCompressionResult {
  originalText: string;
  compressedText: string;
  originalTokensEst: number;
  compressedTokensEst: number;
  tokensSaved: number;
  percentageSaved: number;
}

// Common conversational filler patterns to strip when compressing prompts
const FILLER_PATTERNS = [
  /could you please\s+/gi,
  /would you mind\s+/gi,
  /please make sure to\s+/gi,
  /i would like you to\s+/gi,
  /can you help me\s+/gi,
  /i am trying to\s+/gi,
  /in order to\s+/gi,
  /as a matter of fact\s+/gi,
  /at the end of the day\s+/gi,
  /it is important to note that\s+/gi,
  /take into consideration that\s+/gi,
  /feel free to\s+/gi,
  /as you can see\s+/gi,
  /it goes without saying that\s+/gi,
  /with respect to\s+/gi,
  /due to the fact that\s+/gi
];

// Rough word to token estimator (1 token ~ 0.75 words, or ~4 chars)
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = text.trim().split(/\s+/).length;
  return Math.ceil(words * 1.33);
}

/**
 * Compresses input text or prompt using Caveman principles:
 * 1. Preserves fenced code blocks (` ```...``` `) untouched.
 * 2. Removes polite fillers, redundant conversational fluff.
 * 3. Normalizes whitespace and compacts repetitive formatting.
 */
export function cavemanCompress(text: string): CavemanCompressionResult {
  if (!text) {
    return {
      originalText: '',
      compressedText: '',
      originalTokensEst: 0,
      compressedTokensEst: 0,
      tokensSaved: 0,
      percentageSaved: 0
    };
  }

  const origTokens = estimateTokens(text);
  
  // Extract and preserve code blocks
  const codeBlocks: string[] = [];
  const placeholderPrefix = '__CAVEMAN_CODE_BLOCK_';
  
  let processed = text.replace(/```[\s\S]*?```/g, (match) => {
    const idx = codeBlocks.length;
    codeBlocks.push(match);
    return `${placeholderPrefix}${idx}__`;
  });

  // Apply filler removals
  for (const pattern of FILLER_PATTERNS) {
    processed = processed.replace(pattern, '');
  }

  // Compact multiple blank lines and spaces
  processed = processed
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  // Re-insert code blocks
  processed = processed.replace(new RegExp(`${placeholderPrefix}(\\d+)__`, 'g'), (_, idxStr) => {
    const idx = parseInt(idxStr, 10);
    return codeBlocks[idx] || '';
  });

  const compTokens = estimateTokens(processed);
  const saved = Math.max(0, origTokens - compTokens);
  const pct = origTokens > 0 ? Math.round((saved / origTokens) * 100) : 0;

  return {
    originalText: text,
    compressedText: processed,
    originalTokensEst: origTokens,
    compressedTokensEst: compTokens,
    tokensSaved: saved,
    percentageSaved: pct
  };
}
