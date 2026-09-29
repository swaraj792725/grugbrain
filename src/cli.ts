#!/usr/bin/env node

/**
 * Command-line interface for @swaraj792725/claude-token-saver.
 */

import { installClaudeSaver, uninstallClaudeSaver, getInstallStatus, readStats } from './installer.js';
import { runMcpServer } from './server.js';
import { cavemanCompress } from './caveman.js';
import { graphifyDirectory } from './graphify.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || 'status';

  switch (command) {
    case 'install': {
      console.log('🚀 Installing @swaraj792725/claude-token-saver into macOS Claude Desktop...');
      const res = installClaudeSaver();
      if (res.success) {
        console.log(`✅ ${res.message}`);
        console.log('\nRestart Claude Desktop app to start saving 70%+ tokens automatically on all sessions!');
      } else {
        console.error(`❌ Installation failed: ${res.message}`);
        process.exit(1);
      }
      break;
    }

    case 'uninstall': {
      console.log('🗑️ Removing @swaraj792725/claude-token-saver from Claude Desktop config...');
      const res = uninstallClaudeSaver();
      console.log(res.message);
      break;
    }

    case 'status': {
      const status = getInstallStatus();
      console.log('\n--- ⚡ Claude Token Saver System Status ---');
      console.log(`Claude Config Path: ${status.configPath}`);
      console.log(`Config Exists:     ${status.configExists ? 'Yes' : 'No'}`);
      console.log(`MCP Status:        ${status.isInstalled ? '✅ ACTIVE (Zero-Touch Installed)' : '❌ Not Installed (Run: npx @swaraj792725/claude-token-saver install)'}`);
      console.log(`Total Tokens Saved: ${status.totalTokensSaved.toLocaleString()}`);
      console.log(`Sessions Optimized: ${status.totalSessionsOptimized}`);
      console.log('-------------------------------------------\n');
      break;
    }

    case 'server': {
      await runMcpServer();
      break;
    }

    case 'compress': {
      const input = args.slice(1).join(' ');
      if (!input) {
        console.log('Usage: claude-token-saver compress <text>');
        process.exit(1);
      }
      const res = cavemanCompress(input);
      console.log(`\nOriginal Tokens:   ${res.originalTokensEst}`);
      console.log(`Compressed Tokens: ${res.compressedTokensEst}`);
      console.log(`Tokens Saved:      ${res.tokensSaved} (${res.percentageSaved}%)\n`);
      console.log('--- Compressed Output ---');
      console.log(res.compressedText);
      break;
    }

    case 'graph': {
      const targetDir = args[1] || '.';
      const res = graphifyDirectory(targetDir);
      console.log(`\nIndexed ${res.totalFiles} files in ${res.rootPath}`);
      console.log(`Knowledge Graph Token Est: ${res.tokensEst}\n`);
      console.log(res.summaryMarkdown);
      break;
    }

    case 'help':
    case '--help':
    case '-h': {
      console.log(`
Usage: claude-token-saver <command>

Commands:
  install       Zero-touch installation into macOS Claude Desktop config
  uninstall     Remove MCP server from Claude Desktop config
  status        Check installation status and total token savings stats
  server        Launch stdio MCP server for Claude Desktop
  compress      Compress prompt or code text using Caveman algorithm
  graph <dir>   Build compact knowledge graph for a project directory
  help          Show this help message
`);
      break;
    }

    default: {
      console.error(`Unknown command: ${command}. Run 'claude-token-saver help' for usage.`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
