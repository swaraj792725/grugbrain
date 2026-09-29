/**
 * Caching Engine: Optimizes system prompts and long context blocks for Anthropic Prompt Caching.
 * Automatically inserts cache_control ephemeral boundaries for blocks over 1024 tokens.
 */

import { estimateTokens } from './caveman.js';

export interface PromptCacheBlock {
  type: 'text';
  text: string;
  cache_control?: {
    type: 'ephemeral';
  };
}

export interface CacheOptimizationResult {
  blocks: PromptCacheBlock[];
  totalTokensEst: number;
  cacheableBlocksCount: number;
  estimatedCacheCostSavingsPct: number;
}

const MIN_CACHE_TOKENS = 1024;

export function optimizeForPromptCaching(contextBlocks: string[]): CacheOptimizationResult {
  const blocks: PromptCacheBlock[] = [];
  let cacheableCount = 0;
  let totalTokens = 0;

  for (const blockText of contextBlocks) {
    const tokens = estimateTokens(blockText);
    totalTokens += tokens;

    if (tokens >= MIN_CACHE_TOKENS) {
      cacheableCount++;
      blocks.push({
        type: 'text',
        text: blockText,
        cache_control: {
          type: 'ephemeral'
        }
      });
    } else {
      blocks.push({
        type: 'text',
        text: blockText
      });
    }
  }

  // Estimated prompt cache savings (Anthropic gives 90% discount on cached tokens after 1st turn)
  const estimatedSavingsPct = cacheableCount > 0 ? 80 : 0;

  return {
    blocks,
    totalTokensEst: totalTokens,
    cacheableBlocksCount: cacheableCount,
    estimatedCacheCostSavingsPct: estimatedSavingsPct
  };
}
