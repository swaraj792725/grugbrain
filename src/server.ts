/**
 * MCP Server Implementation (stdio JSON-RPC 2.0).
 * Connects directly to macOS Claude Desktop and provides zero-touch token optimization tools.
 */

import { cavemanCompress } from './caveman.js';
import { graphifyDirectory } from './graphify.js';
import { skeletonizeCode } from './skeletonizer.js';
import { optimizeForPromptCaching } from './caching.js';
import { updateStats, readStats } from './installer.js';

export async function runMcpServer() {
  process.stdin.setEncoding('utf8');

  let buffer = '';

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        handleRpcRequest(request);
      } catch (err: any) {
        sendRpcError(null, -32700, 'Parse error', err.message);
      }
    }
  });
}

function handleRpcRequest(req: any) {
  const { id, method, params } = req;

  if (method === 'initialize') {
    sendRpcResult(id, {
      protocolVersion: '2024-11-05',
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: 'token-diet',
        version: '1.0.0'
      }
    });
    return;
  }

  if (method === 'notifications/initialized') {
    // Client acknowledgment, no response needed
    return;
  }

  if (method === 'tools/list') {
    sendRpcResult(id, {
      tools: [
        {
          name: 'caveman_compress',
          description: 'Compresses long prompts, instructions, or text using Caveman algorithm (stripping polite fluff and boilerplate while keeping code intact). Saves 40-70% tokens.',
          inputSchema: {
            type: 'object',
            properties: {
              text: { type: 'string', description: 'Prompt or context text to compress' }
            },
            required: ['text']
          }
        },
        {
          name: 'graphify_project',
          description: 'Indexes a directory structure and topological import graph into a ultra-compact knowledge graph (saving up to 98% tokens compared to sending raw files).',
          inputSchema: {
            type: 'object',
            properties: {
              directoryPath: { type: 'string', description: 'Path to directory to index' },
              maxDepth: { type: 'number', description: 'Maximum depth (default 5)' }
            },
            required: ['directoryPath']
          }
        },
        {
          name: 'skeletonize_code',
          description: 'Extracts function signatures, class declarations, and type outlines from source code while stripping function implementation bodies. Saves 75-85% tokens.',
          inputSchema: {
            type: 'object',
            properties: {
              code: { type: 'string', description: 'Source code content' },
              fileName: { type: 'string', description: 'File name (e.g. index.ts or app.py)' }
            },
            required: ['code']
          }
        },
        {
          name: 'optimize_prompt_cache',
          description: 'Wraps long context blocks into Anthropic prompt caching boundaries (cache_control: { type: "ephemeral" }) for 90% prompt discount.',
          inputSchema: {
            type: 'object',
            properties: {
              contextBlocks: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of context text blocks'
              }
            },
            required: ['contextBlocks']
          }
        },
        {
          name: 'get_token_savings',
          description: 'Returns total running token savings statistics for this system.',
          inputSchema: {
            type: 'object',
            properties: {}
          }
        }
      ]
    });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};

    if (name === 'caveman_compress') {
      const res = cavemanCompress(args.text || '');
      updateStats(res.tokensSaved);
      sendRpcResult(id, {
        content: [
          {
            type: 'text',
            text: `[Caveman Token Saver: Saved ${res.tokensSaved} tokens (${res.percentageSaved}%)]\n\n${res.compressedText}`
          }
        ]
      });
      return;
    }

    if (name === 'graphify_project') {
      const res = graphifyDirectory(args.directoryPath || '.', args.maxDepth || 5);
      const tokensSaved = Math.max(0, res.totalFiles * 800 - res.tokensEst);
      updateStats(tokensSaved);
      sendRpcResult(id, {
        content: [
          {
            type: 'text',
            text: `[Graphify Knowledge Graph: ${res.totalFiles} files indexed, ~${res.tokensEst} tokens used, ~${tokensSaved} tokens saved]\n\n${res.summaryMarkdown}`
          }
        ]
      });
      return;
    }

    if (name === 'skeletonize_code') {
      const res = skeletonizeCode(args.code || '', args.fileName || 'file.ts');
      const tokensSaved = Math.max(0, res.originalTokensEst - res.skeletonTokensEst);
      updateStats(tokensSaved);
      sendRpcResult(id, {
        content: [
          {
            type: 'text',
            text: `[Symbol Skeletonizer: Saved ${res.percentageSaved}% tokens]\n\n${res.skeletonCode}`
          }
        ]
      });
      return;
    }

    if (name === 'optimize_prompt_cache') {
      const res = optimizeForPromptCaching(args.contextBlocks || []);
      const saved = Math.round(res.totalTokensEst * (res.estimatedCacheCostSavingsPct / 100));
      updateStats(saved);
      sendRpcResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(res, null, 2)
          }
        ]
      });
      return;
    }

    if (name === 'get_token_savings') {
      const stats = readStats();
      sendRpcResult(id, {
        content: [
          {
            type: 'text',
            text: JSON.stringify(stats, null, 2)
          }
        ]
      });
      return;
    }

    sendRpcError(id, -32601, 'Method not found', `Unknown tool: ${name}`);
    return;
  }

  sendRpcError(id, -32601, 'Method not found', `Unsupported method: ${method}`);
}

function sendRpcResult(id: any, result: any) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    result
  });
  process.stdout.write(payload + '\n');
}

function sendRpcError(id: any, code: number, message: string, data?: string) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
      data
    }
  });
  process.stdout.write(payload + '\n');
}
