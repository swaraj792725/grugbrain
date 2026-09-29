/**
 * Obsidian-compatible markdown vault, regenerated from the memory graph.
 * Written under <vaultDir>/grugbrain/. Only files grug generated (frontmatter
 * `generator: grugbrain`) are ever deleted, so pointing vaultDir at a real vault is safe.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, writeFileAtomic } from '../config.js';
import { MemNode, MemoryDB, neighbors, projectName, score } from './store.js';

const GEN = 'generator: grugbrain';

function safe(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'untitled';
}

function titleOf(n: MemNode): string {
  const p = projectName(n.project);
  switch (n.type) {
    case 'project':
      return `${p}`;
    case 'session':
      return `${new Date(n.data?.started || n.created).toISOString().slice(0, 10)} ${safe(n.label).slice(0, 50)}`;
    case 'file':
      return `${p} · ${safe(n.label.replace(/\//g, ' › '))}`;
    case 'topic':
      return `${p} · #${safe(n.label)}`;
    case 'note':
      return `${p} · note ${n.id.slice(-6)}`;
    case 'digest':
      return `${safe(n.label)} digest`;
  }
}

function folderOf(n: MemNode): string {
  return { project: '', session: 'sessions', file: 'files', topic: 'topics', note: 'notes', digest: 'digests' }[n.type];
}

export function exportVault(db: MemoryDB, vaultDir: string, halfLife: number): { written: number; removed: number; dir: string } {
  const root = path.join(vaultDir, 'grugbrain');
  ensureDir(root);
  const written = new Set<string>();
  const titles = new Map<string, string>();
  for (const n of Object.values(db.nodes)) titles.set(n.id, titleOf(n));

  const write = (rel: string, body: string) => {
    const file = path.join(root, rel);
    written.add(path.resolve(file));
    let prev = '';
    try {
      prev = fs.readFileSync(file, 'utf8');
    } catch {
      /* new */
    }
    if (prev !== body) writeFileAtomic(file, body);
  };

  for (const n of Object.values(db.nodes)) {
    const proj = safe(projectName(n.project));
    const links = neighbors(db, n.id)
      .sort((a, b) => b.w - a.w)
      .slice(0, 40)
      .map(({ node }) => `[[${titles.get(node.id)}]]`);
    const fm = [
      '---',
      GEN,
      `type: ${n.type}`,
      `project: ${projectName(n.project)}`,
      `updated: ${new Date(n.updated).toISOString()}`,
      `score: ${score(n, halfLife) === Infinity ? 'root' : score(n, halfLife).toFixed(2)}`,
      `tags: [grugbrain, ${n.type}]`,
      '---'
    ].join('\n');
    let body = '';
    if (n.type === 'session') {
      body = [
        `# ${n.label}`,
        '',
        `Started ${new Date(n.data?.started || n.created).toLocaleString()} · ${n.data?.promptCount || 0} prompts · ${n.data?.commands || 0} commands`,
        '',
        '## Asked',
        ...(n.data?.prompts || []).map((p: string) => `- ${p}`),
        '',
        '## Outcome',
        n.data?.outcome || '_(none captured)_'
      ].join('\n');
    } else if (n.type === 'digest') {
      body = [`# ${n.label}`, '', `${n.data?.sessions || 0} sessions folded, ${n.data?.prompts || 0} prompts.`, '', '## Highlights', ...(n.data?.highlights || []).map((h: string) => `- ${h}`)].join('\n');
    } else if (n.type === 'note') {
      body = `# Note${n.data?.pinned ? ' 📌' : ''}\n\n${n.label}`;
    } else if (n.type === 'file') {
      body = `# ${n.label}\n\nTouched ${n.touches}× across sessions.`;
    } else if (n.type === 'topic') {
      body = `# #${n.label}\n\nTopic seen in ${n.touches} session link(s).`;
    } else {
      body = `# ${n.label}\n\nPath: \`${n.data?.path || '?'}\``;
    }
    const content = `${fm}\n${body}\n\n## Links\n${links.join(' · ') || '_none_'}\n`;
    const folder = folderOf(n);
    write(path.join(proj, folder, `${titles.get(n.id)}.md`), content);
  }

  // Index note.
  const projects = Object.values(db.nodes).filter((n) => n.type === 'project');
  write(
    'Grug Index.md',
    [
      '---',
      GEN,
      '---',
      '# 🪨 grugbrain memory',
      '',
      'Auto-generated. Grug keeps it tidy. Do not edit (grug overwrite).',
      '',
      ...projects.map((p) => `- [[${titles.get(p.id)}]]`)
    ].join('\n') + '\n'
  );

  // Remove stale generated notes.
  let removed = 0;
  const sweep = (dir: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) sweep(full);
      else if (e.name.endsWith('.md') && !written.has(path.resolve(full))) {
        try {
          if (fs.readFileSync(full, 'utf8').slice(0, 200).includes(GEN)) {
            fs.unlinkSync(full);
            removed++;
          }
        } catch {
          /* ignore */
        }
      }
    }
  };
  sweep(root);
  return { written: written.size, removed, dir: root };
}
