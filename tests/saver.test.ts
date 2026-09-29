import { describe, it, expect } from 'vitest';
import { cavemanCompress, estimateTokens } from '../src/caveman.js';
import { skeletonizeCode } from '../src/skeletonizer.js';
import { optimizeForPromptCaching } from '../src/caching.js';
import { graphifyDirectory } from '../src/graphify.js';
import { getClaudeConfigPath, getInstallStatus } from '../src/installer.js';
import * as path from 'node:path';

describe('Claude Token Saver Suite', () => {
  it('cavemanCompress should strip conversational fillers and calculate savings', () => {
    const input = 'Could you please make sure to optimize this function? I am trying to reduce token usage in order to save costs.';
    const res = cavemanCompress(input);

    expect(res.compressedText).not.includes('Could you please');
    expect(res.compressedText).not.includes('in order to');
    expect(res.tokensSaved).toBeGreaterThan(0);
    expect(res.percentageSaved).toBeGreaterThan(0);
  });

  it('cavemanCompress should preserve code blocks untouched', () => {
    const code = '```typescript\nfunction test() { return "Could you please keep me"; }\n```';
    const res = cavemanCompress(code);
    expect(res.compressedText).includes('Could you please keep me');
  });

  it('skeletonizeCode should strip function implementation bodies', () => {
    const code = `
export function add(a: number, b: number): number {
  const sum = a + b;
  console.log("sum is", sum);
  return sum;
}
    `;
    const res = skeletonizeCode(code, 'math.ts');
    expect(res.skeletonCode).includes('export function add');
    expect(res.skeletonCode).includes('/* implementation hidden */');
    expect(res.skeletonCode).not.includes('console.log');
    expect(res.percentageSaved).toBeGreaterThan(0);
  });

  it('optimizeForPromptCaching should mark large blocks with ephemeral cache control', () => {
    const smallBlock = 'Short context block';
    const largeBlock = 'Word '.repeat(1100);

    const res = optimizeForPromptCaching([smallBlock, largeBlock]);
    expect(res.blocks.length).toBe(2);
    expect(res.blocks[0].cache_control).toBeUndefined();
    expect(res.blocks[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(res.cacheableBlocksCount).toBe(1);
  });

  it('graphifyDirectory should build compact knowledge graph', () => {
    const res = graphifyDirectory(path.resolve(__dirname, '../src'));
    expect(res.totalFiles).toBeGreaterThan(0);
    expect(res.summaryMarkdown).includes('# Project Knowledge Graph');
    expect(res.tokensEst).toBeGreaterThan(0);
  });

  it('installer utilities should resolve macOS Claude Desktop config path', () => {
    const configPath = getClaudeConfigPath();
    expect(configPath).includes('Claude');
    expect(configPath.endsWith('.json')).toBe(true);

    const status = getInstallStatus();
    expect(status).toHaveProperty('configPath');
    expect(status).toHaveProperty('isInstalled');
  });
});
