/**
 * Other AI coding apps. Each adapter puts what that app supports in its own config:
 * grug's workflow skills (portable SKILL.md), the grug MCP server and a short rules file.
 * Antigravity and Codex also get grug's hooks (src/agents/), translated to their hook APIs.
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

/** Always-on rules for another app: the same cheap rules grug gives Claude Code subagents, in that app's tool names. */
export function platformRules(client: 'antigravity' | 'codex', cfg = loadConfig()): string {
  const parts = ['# grugbrain rules (written by `grug install`; edit grug config instead, it is rewritten on install)', ''];
  const style = terseStyle(cfg.terse);
  if (style) parts.push(style, '');
  parts.push(
    client === 'antigravity'
      ? 'Large files: search for the symbol first (grep_search), then view only the needed line range instead of the whole file.'
      : "Large files: search for the symbol first (rg -n), then print only the needed lines (sed -n 'START,ENDp') instead of cat-ing the whole file."
  );
  if (cfg.batching.rule) parts.push(BATCH_RULE.replace('one Bash call', client === 'antigravity' ? 'one command' : 'one shell command'));
  const skills = bundledSkillNames();
  if (cfg.skills.enabled && skills.length) parts.push('', `Workflow skills ${skills.join(', ')}: use the one that fits before starting that kind of work.`);
  return parts.join('\n') + '\n';
}

export const antigravityRules = (cfg = loadConfig()) => platformRules('antigravity', cfg);

/** How the other apps start grug's CLI (absolute paths: hook commands do not run in the project). */
function cliCommand(): { node: string; cli: string } {
  return { node: process.execPath, cli: path.join(paths.app(), 'cli.js') };
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export const AG_HOOK_TOOLS = 'run_command|view_file|read_file|replace_file_content|multi_replace_file_content|write_to_file|grep_search';

/** Antigravity hooks.json for the plugin: one named hook (agy rejects bare event keys: "cannot unmarshal array
 *  into ... JSONHookSpec"); PreInvocation/Stop flat lists, tool events grouped by matcher. */
export function antigravityHooks(): any {
  const { node, cli } = cliCommand();
  const h = (event: string, timeout: number) => ({ type: 'command', command: `${shq(node)} ${shq(cli)} hook-ag ${event}`, timeout });
  return {
    grugbrain: {
      PreInvocation: [h('PreInvocation', 30)],
      PreToolUse: [{ matcher: AG_HOOK_TOOLS, hooks: [h('PreToolUse', 20)] }],
      PostToolUse: [{ matcher: AG_HOOK_TOOLS, hooks: [h('PostToolUse', 30)] }],
      Stop: [h('Stop', 120)]
    }
  };
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
  const hooksFile = path.join(dir, 'hooks.json');
  if (cfg.platforms.antigravity.hooks) writeJsonAtomic(hooksFile, antigravityHooks());
  else fs.rmSync(hooksFile, { force: true });
  const skills = syncSkills(path.join(dir, 'skills'), cfg.skills.enabled);
  const what = [cfg.platforms.antigravity.mcp && 'MCP server', cfg.platforms.antigravity.hooks && 'hooks', 'rules', skills.length && `${skills.length} skills`].filter(Boolean).join(', ');
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

// ---------- Codex (CLI, IDE extension and app share CODEX_HOME) ----------

export const codexHome = () => process.env.CODEX_HOME || path.join(userHome(), '.codex');
/** Codex reads user skills from ~/.agents/skills (not under CODEX_HOME). */
export const codexSkillsDir = () => path.join(userHome(), '.agents', 'skills');
const TOML_START = '# >>> grugbrain (written by grug install; removed by grug uninstall) >>>';
const TOML_END = '# <<< grugbrain <<<';
const MD_START = '<!-- grugbrain:start (written by grug install) -->';
const MD_END = '<!-- grugbrain:end -->';

function onPath(bin: string): boolean {
  if (process.env.GRUG_NO_APP_DETECT === '1') return false;
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .some((d) => d && fs.existsSync(path.join(d, bin)));
}

export function codexPresent(): boolean {
  return fs.existsSync(codexHome()) || onPath('codex');
}

/** Text with our marked block taken out (and the blank line left behind). */
export function withoutBlock(text: string, start: string, end: string): string {
  const i = text.indexOf(start);
  if (i < 0) return text;
  const j = text.indexOf(end, i);
  if (j < 0) return text;
  const before = text.slice(0, i).replace(/\n+$/, '');
  const after = text.slice(j + end.length).replace(/^\n+/, '');
  return [before, after].filter(Boolean).join('\n\n') + (before || after ? '\n' : '');
}

function writeIfChanged(file: string, text: string): void {
  let before: string | null = null;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch {
    /* new file */
  }
  if (before === text) return;
  if (before !== null) backupFile(file);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
}

const tomlStr = (s: string) => JSON.stringify(s);

export function codexMcpBlock(): string {
  const { node, cli } = cliCommand();
  return [TOML_START, '[mcp_servers.grugbrain]', `command = ${tomlStr(node)}`, `args = [${tomlStr(cli)}, "mcp"]`, 'env = { GRUG_CLIENT = "codex" }', TOML_END].join('\n');
}

export const CODEX_HOOK_TOOLS = '^(Bash|exec_command|shell|local_shell|apply_patch|Edit|Write)$';

export function codexHookGroups(): Record<string, any[]> {
  const { node, cli } = cliCommand();
  const h = (event: string, timeout: number) => ({ type: 'command', command: `${shq(node)} ${shq(cli)} hook-codex ${event}`, timeout });
  return {
    SessionStart: [{ hooks: [h('SessionStart', 30)] }],
    UserPromptSubmit: [{ hooks: [h('UserPromptSubmit', 30)] }],
    PreToolUse: [{ matcher: CODEX_HOOK_TOOLS, hooks: [h('PreToolUse', 20)] }],
    PostToolUse: [{ matcher: CODEX_HOOK_TOOLS, hooks: [h('PostToolUse', 30)] }],
    SubagentStart: [{ hooks: [h('SubagentStart', 10)] }],
    Stop: [{ hooks: [h('Stop', 120)] }],
    PreCompact: [{ hooks: [h('PreCompact', 30)] }],
    SessionEnd: [{ hooks: [h('SessionEnd', 3)] }]
  };
}

const isOurs = (g: any) => Array.isArray(g?.hooks) && g.hooks.some((x: any) => String(x?.command || '').includes(' hook-codex '));

/** hooks.json with grug's groups replaced (add = false: only removed). Other hooks are kept as they are. */
export function mergeCodexHooks(current: any, add: boolean): any {
  const out = current && typeof current === 'object' ? { ...current } : {};
  const hooks: Record<string, any[]> = { ...(out.hooks || {}) };
  for (const k of Object.keys(hooks)) {
    hooks[k] = (Array.isArray(hooks[k]) ? hooks[k] : []).filter((g) => !isOurs(g));
    if (!hooks[k].length) delete hooks[k];
  }
  if (add) for (const [k, groups] of Object.entries(codexHookGroups())) hooks[k] = [...(hooks[k] || []), ...groups];
  out.hooks = hooks;
  return out;
}

/** Codex reads AGENTS.override.md instead of AGENTS.md when it exists. */
const codexAgentsFile = () => {
  const o = path.join(codexHome(), 'AGENTS.override.md');
  return fs.existsSync(o) && fs.readFileSync(o, 'utf8').trim() ? o : path.join(codexHome(), 'AGENTS.md');
};

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function installCodex(): Step[] {
  const cfg = loadConfig();
  if (!cfg.platforms.codex.enabled) return uninstallCodex();
  if (!codexPresent()) return [{ target: 'codex', ok: true, message: 'Codex not found (skipped).' }];
  const home = codexHome();
  const done: string[] = [];
  // MCP server: a marked block in config.toml (left alone if the user has their own grugbrain entry).
  const tomlFile = path.join(home, 'config.toml');
  const toml = withoutBlock(readText(tomlFile), TOML_START, TOML_END);
  if (cfg.platforms.codex.mcp && /^\s*\[mcp_servers\.grugbrain\]/m.test(toml)) done.push('MCP server (your own entry kept)');
  else if (cfg.platforms.codex.mcp) {
    writeIfChanged(tomlFile, (toml.trim() ? toml.replace(/\n*$/, '\n\n') : '') + codexMcpBlock() + '\n');
    done.push('MCP server');
  } else if (fs.existsSync(tomlFile)) writeIfChanged(tomlFile, toml);
  // Hooks: grug's groups in hooks.json, everything else kept.
  const hooksFile = path.join(home, 'hooks.json');
  const r = readJson<any>(hooksFile);
  if (r.ok || !fs.existsSync(hooksFile)) {
    const next = mergeCodexHooks(r.ok ? r.value : {}, cfg.platforms.codex.hooks);
    if (Object.keys(next.hooks).length || fs.existsSync(hooksFile)) writeIfChanged(hooksFile, JSON.stringify(next, null, 2) + '\n');
    if (cfg.platforms.codex.hooks) done.push('hooks');
  } else done.push('hooks skipped (hooks.json is not valid JSON)');
  // Rules: a marked block in the global AGENTS file.
  const mdFile = codexAgentsFile();
  const md = withoutBlock(readText(mdFile), MD_START, MD_END);
  writeIfChanged(mdFile, (md.trim() ? md.replace(/\n*$/, '\n\n') : '') + `${MD_START}\n${platformRules('codex', cfg)}${MD_END}\n`);
  done.push('rules');
  const skills = syncSkills(codexSkillsDir(), cfg.skills.enabled);
  if (skills.length) done.push(`${skills.length} skills`);
  const steps: Step[] = [{ target: 'codex', ok: true, message: `${home} (${done.join(', ')}). Start a new Codex session.` }];
  if (cfg.platforms.codex.hooks) steps.push({ target: 'codex hooks', ok: true, message: 'Codex runs new hooks only after you approve them once: type /hooks in Codex.' });
  return steps;
}

function uninstallCodex(): Step[] {
  const home = codexHome();
  const steps: Step[] = [];
  const tomlFile = path.join(home, 'config.toml');
  const toml = readText(tomlFile);
  if (toml.includes(TOML_START)) writeIfChanged(tomlFile, withoutBlock(toml, TOML_START, TOML_END));
  const hooksFile = path.join(home, 'hooks.json');
  const r = readJson<any>(hooksFile);
  if (r.ok && JSON.stringify(r.value).includes(' hook-codex ')) writeIfChanged(hooksFile, JSON.stringify(mergeCodexHooks(r.value, false), null, 2) + '\n');
  for (const f of [path.join(home, 'AGENTS.md'), path.join(home, 'AGENTS.override.md')]) {
    const md = readText(f);
    if (md.includes(MD_START)) writeIfChanged(f, withoutBlock(md, MD_START, MD_END));
  }
  const had = installedIn(codexSkillsDir()).length;
  syncSkills(codexSkillsDir(), false);
  if (toml.includes(TOML_START) || had || (r.ok && JSON.stringify(r.value).includes(' hook-codex '))) steps.push({ target: 'codex', ok: true, message: `Removed grug from ${home}` });
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
  steps.push(...installCodex());
  return steps;
}

export function uninstallPlatforms(): Step[] {
  const steps: Step[] = [];
  if (installedIn(claudeSkillsDir()).length) {
    syncSkills(claudeSkillsDir(), false);
    steps.push({ target: 'skills', ok: true, message: `Removed grug skills from ${claudeSkillsDir()}` });
  }
  steps.push(...uninstallAntigravity());
  steps.push(...uninstallCodex());
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
      detail: fs.existsSync(ag)
        ? `plugin: ${agMcp ? 'MCP, ' : ''}${fs.existsSync(path.join(ag, 'hooks.json')) ? 'hooks, ' : ''}rules, ${agSkills} skills`
        : cfg.platforms.antigravity.enabled
          ? 'not installed'
          : 'off (platforms.antigravity.enabled=false)'
    },
    codexRow(cfg)
  ];
}

function codexRow(cfg: ReturnType<typeof loadConfig>): PlatformRow {
  const home = codexHome();
  const mcp = readText(path.join(home, 'config.toml')).includes(TOML_START);
  const hooks = readText(path.join(home, 'hooks.json')).includes(' hook-codex ');
  const rules = [path.join(home, 'AGENTS.md'), path.join(home, 'AGENTS.override.md')].some((f) => readText(f).includes(MD_START));
  const skills = installedIn(codexSkillsDir()).length;
  const parts = [mcp && 'MCP', hooks && 'hooks (approve once with /hooks)', rules && 'rules', skills && `${skills} skills`].filter(Boolean);
  return {
    id: 'codex',
    name: 'Codex',
    present: codexPresent(),
    installed: rules,
    detail: parts.length ? parts.join(', ') : cfg.platforms.codex.enabled ? 'not installed' : 'off (platforms.codex.enabled=false)'
  };
}
