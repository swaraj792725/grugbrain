/**
 * Other AI coding apps. Each adapter puts what that app supports in its own config:
 * grug's workflow skills (portable SKILL.md), the grug MCP server and a short rules file.
 * Hooks, output trimming and the meter stay Claude Code only until an app's hook API is wired.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { backupFile, ensureDir, grugHome, loadConfig, paths, readJson, userHome, writeJsonAtomic, VERSION } from './config.js';
import { terseStyle } from './compress/caveman.js';
import { BATCH_RULE } from './batching.js';
import type { Step } from './install.js';

export const SKILL_PREFIX = 'grug-';
const AG_PLUGIN = 'grugbrain';

/** Skills shipped with grug: the copy next to the runtime first, then the package's own folder. */
export function bundledSkillsDir(): string | null {
  const here = typeof __dirname === 'string' ? __dirname : process.cwd();
  const cands = [path.join(grugHome(), 'skills'), path.join(here, '..', 'skills'), path.join(here, 'skills')];
  return cands.find((d) => fs.existsSync(d) && bundledSkillNames(d).length > 0) ?? null;
}

export function bundledSkillNames(dir = bundledSkillsDir()): string[] {
  if (!dir) return [];
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(SKILL_PREFIX) && fs.existsSync(path.join(dir, n, 'SKILL.md')))
      .sort();
  } catch {
    return [];
  }
}

/** Copy the package's skills next to the runtime so later installs (and `grug update`) find them. */
export function copySkills(builtDir: string): boolean {
  const from = [path.join(builtDir, '..', 'skills'), path.join(builtDir, 'skills')].find((d) => bundledSkillNames(d).length > 0);
  if (!from) return false;
  const to = path.join(grugHome(), 'skills');
  if (path.resolve(from) === path.resolve(to)) return true;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
  return true;
}

/** Replace our skill folders in `dest` with the bundled ones; folders without the grug- prefix are never touched. */
function syncSkills(dest: string, wanted: boolean): string[] {
  const src = bundledSkillsDir();
  const names = bundledSkillNames(src);
  for (const n of names) fs.rmSync(path.join(dest, n), { recursive: true, force: true });
  if (!wanted || !src) return [];
  ensureDir(dest);
  for (const n of names) fs.cpSync(path.join(src, n), path.join(dest, n), { recursive: true });
  return names;
}

function installedIn(dest: string): string[] {
  return bundledSkillNames().filter((n) => fs.existsSync(path.join(dest, n, 'SKILL.md')));
}

// ---------- Claude Code (user skills) ----------

export const claudeSkillsDir = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'skills');

// ---------- Antigravity (app, IDE and agy CLI share ~/.gemini/config) ----------

export const antigravityConfigDir = () => path.join(userHome(), '.gemini', 'config');
export const antigravityPluginDir = () => path.join(antigravityConfigDir(), 'plugins', AG_PLUGIN);

export function antigravityPresent(): boolean {
  if (process.env.GRUG_NO_APP_DETECT !== '1' && process.platform === 'darwin' && fs.existsSync('/Applications/Antigravity.app')) return true;
  return fs.existsSync(antigravityConfigDir()) || fs.existsSync(path.join(userHome(), '.gemini', 'antigravity'));
}

/** Always-on rules for Antigravity: the same cheap rules grug gives Claude Code subagents, in that app's tool names. */
export function antigravityRules(cfg = loadConfig()): string {
  const parts = ['# grugbrain rules (written by `grug install`; edit grug config instead, it is rewritten on install)', ''];
  const style = terseStyle(cfg.terse);
  if (style) parts.push(style, '');
  parts.push('Large files: search for the symbol first (grep_search), then view only the needed line range instead of the whole file.');
  if (cfg.batching.rule) parts.push(BATCH_RULE.replace('one Bash call', 'one command'));
  if (cfg.skills.enabled) parts.push('', 'Workflow skills grug-brainstorm, grug-plan, grug-execute, grug-tdd, grug-debug, grug-verify, grug-review, grug-worktree, grug-parallel, grug-finish: use the one that fits before starting that kind of work.');
  return parts.join('\n') + '\n';
}

function installAntigravity(): Step[] {
  const cfg = loadConfig();
  const dir = antigravityPluginDir();
  if (!cfg.platforms.antigravity.enabled) return uninstallAntigravity();
  if (!antigravityPresent()) return [{ target: 'antigravity', ok: true, message: 'Antigravity not found (skipped).' }];
  ensureDir(dir);
  writeJsonAtomic(path.join(dir, 'plugin.json'), {
    name: AG_PLUGIN,
    displayName: 'grugbrain',
    version: VERSION,
    description: 'grug: fewer tokens. Memory, recall and history tools, short rules, lean workflow skills.'
  });
  const mcpFile = path.join(dir, 'mcp_config.json');
  if (cfg.platforms.antigravity.mcp) {
    writeJsonAtomic(mcpFile, { mcpServers: { grugbrain: { command: process.execPath, args: [path.join(paths.app(), 'cli.js'), 'mcp'], env: { GRUG_CLIENT: 'antigravity' } } } });
  } else fs.rmSync(mcpFile, { force: true });
  ensureDir(path.join(dir, 'rules'));
  fs.writeFileSync(path.join(dir, 'rules', 'AGENTS.md'), antigravityRules(cfg));
  const skills = syncSkills(path.join(dir, 'skills'), cfg.skills.enabled);
  const what = [cfg.platforms.antigravity.mcp && 'MCP server', 'rules', skills.length && `${skills.length} skills`].filter(Boolean).join(', ');
  return [{ target: 'antigravity', ok: true, message: `Plugin ${dir} (${what}). Start a new Antigravity conversation.` }];
}

function uninstallAntigravity(): Step[] {
  const dir = antigravityPluginDir();
  const steps: Step[] = [];
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    steps.push({ target: 'antigravity', ok: true, message: `Removed ${dir}` });
  }
  // The app records on/off per plugin directory in config.json; drop our entry so nothing dangles.
  const conf = path.join(antigravityConfigDir(), 'config.json');
  const r = readJson<any>(conf);
  if (r.ok && r.value?.plugins?.[AG_PLUGIN]) {
    delete r.value.plugins[AG_PLUGIN];
    backupFile(conf);
    writeJsonAtomic(conf, r.value);
  }
  return steps;
}

// ---------- all platforms ----------

export function installPlatforms(): Step[] {
  const cfg = loadConfig();
  const steps: Step[] = [];
  const names = syncSkills(claudeSkillsDir(), cfg.skills.enabled);
  steps.push(
    cfg.skills.enabled
      ? { target: 'skills', ok: names.length > 0, message: names.length ? `${names.length} grug workflow skills in ${claudeSkillsDir()}` : 'Bundled skills not found (reinstall grug).' }
      : { target: 'skills', ok: true, message: 'Workflow skills off (skills.enabled=false).' }
  );
  steps.push(...installAntigravity());
  return steps;
}

export function uninstallPlatforms(): Step[] {
  const steps: Step[] = [];
  if (installedIn(claudeSkillsDir()).length) {
    syncSkills(claudeSkillsDir(), false);
    steps.push({ target: 'skills', ok: true, message: `Removed grug skills from ${claudeSkillsDir()}` });
  }
  steps.push(...uninstallAntigravity());
  return steps;
}

export interface PlatformRow {
  id: string;
  name: string;
  present: boolean;
  installed: boolean;
  detail: string;
}

export function platformStatus(): PlatformRow[] {
  const cfg = loadConfig();
  const total = bundledSkillNames().length;
  const cs = installedIn(claudeSkillsDir()).length;
  const ag = antigravityPluginDir();
  const agSkills = installedIn(path.join(ag, 'skills')).length;
  const agMcp = fs.existsSync(path.join(ag, 'mcp_config.json'));
  return [
    {
      id: 'claude-skills',
      name: 'Claude Code skills',
      present: true,
      installed: !cfg.skills.enabled || cs === total,
      detail: cfg.skills.enabled ? `${cs}/${total} grug skills in ${claudeSkillsDir()}` : 'off (skills.enabled=false)'
    },
    {
      id: 'antigravity',
      name: 'Antigravity',
      present: antigravityPresent(),
      installed: fs.existsSync(path.join(ag, 'plugin.json')),
      detail: fs.existsSync(ag) ? `plugin: ${agMcp ? 'MCP, ' : ''}rules, ${agSkills} skills` : cfg.platforms.antigravity.enabled ? 'not installed' : 'off (platforms.antigravity.enabled=false)'
    }
  ];
}
