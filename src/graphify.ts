/**
 * Graphify Engine: Topologically index directory structures and import/export graphs.
 * Formats multi-file codebases into ultra-compact graph representations (saving up to 98% tokens).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GraphNode {
  path: string;
  relativePath: string;
  size: number;
  imports: string[];
  exports: string[];
}

export interface GraphifyResult {
  rootPath: string;
  totalFiles: number;
  graph: Record<string, GraphNode>;
  summaryMarkdown: string;
  tokensEst: number;
}

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.cache',
  'coverage',
  '.turbo'
]);

const IGNORE_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.mp4', '.woff', '.woff2', '.ttf'
]);

export function graphifyDirectory(dirPath: string, maxDepth: number = 5): GraphifyResult {
  const absoluteRoot = path.resolve(dirPath);
  const graph: Record<string, GraphNode> = {};
  let fileCount = 0;

  function scan(currentDir: string, currentDepth: number) {
    if (currentDepth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (IGNORE_DIRS.has(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      const relative = path.relative(absoluteRoot, fullPath);

      if (entry.isDirectory()) {
        scan(fullPath, currentDepth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (IGNORE_EXTS.has(ext)) continue;

        fileCount++;
        let size = 0;
        let imports: string[] = [];
        let exportsList: string[] = [];

        try {
          const stats = fs.statSync(fullPath);
          size = stats.size;

          // For code files, quick regex parse imports & exports
          if (['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs'].includes(ext)) {
            const content = fs.readFileSync(fullPath, 'utf8');
            
            // Extract imports
            const importMatches = content.match(/import\s+.*?from\s+['"](.*?)['"]/g) || [];
            imports = importMatches.map(m => {
              const subMatch = m.match(/from\s+['"](.*?)['"]/);
              return subMatch ? subMatch[1] : m;
            });

            // Extract export names
            const exportMatches = content.match(/export\s+(const|function|class|type|interface|enum|default)\s+([A-Za-z0-9_$]+)/g) || [];
            exportsList = exportMatches.map(e => e.replace(/^export\s+/, ''));
          }
        } catch {
          // ignore read errors
        }

        graph[relative] = {
          path: fullPath,
          relativePath: relative,
          size,
          imports,
          exports: exportsList
        };
      }
    }
  }

  scan(absoluteRoot, 1);

  // Build compact markdown graph summary
  const lines: string[] = [
    `# Project Knowledge Graph: ${path.basename(absoluteRoot)}`,
    `Total Files Indexed: ${fileCount}`,
    `---`
  ];

  for (const [relPath, node] of Object.entries(graph)) {
    lines.push(`- **${relPath}** (${node.size} bytes)`);
    if (node.exports.length > 0) {
      lines.push(`  - Exports: ${node.exports.slice(0, 5).join(', ')}${node.exports.length > 5 ? '...' : ''}`);
    }
    if (node.imports.length > 0) {
      lines.push(`  - Imports: ${node.imports.slice(0, 5).join(', ')}${node.imports.length > 5 ? '...' : ''}`);
    }
  }

  const summaryMarkdown = lines.join('\n');
  const tokensEst = Math.ceil(summaryMarkdown.split(/\s+/).length * 1.33);

  return {
    rootPath: absoluteRoot,
    totalFiles: fileCount,
    graph,
    summaryMarkdown,
    tokensEst
  };
}
