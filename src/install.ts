/**
 * Installer for Claude Code (hooks + proxy + MCP) and Claude Desktop (MCP), plus the
 * background service (launchd on macOS, systemd --user on Linux).
 *
 * Safety rules:
 *  - Every config file is backed up to ~/.grug/backups before it is touched.
 *  - A config that fails to parse is NEVER overwritten; that target is skipped with a warning.
 *  - Writes are atomic (temp file + rename).
 *  - Commands use absolute paths (GUI apps on macOS don't inherit your shell PATH).
 *  - A pre-existing ANTHROPIC_BASE_URL is kept as grug's upstream, not clobbered.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { backupFile, userHome, ensureDir, loadConfig, paths, readJson, saveConfig, writeFileAtomic, writeJsonAtomic } from './config.js';
import { recordActivity } from './stats.js';

export const MARK = '--from=grugbrain';
const LEGACY_KEYS = ['token-diet', 'claude-token-saver'];
const SERVICE_LABEL = 'com.grugbrain.daemon';

export interface Step {
  target: string;
  ok: boolean;
  message: string;
}

export interface InstallOptions {
  code?: boolean;
  desktop?: boolean;
  proxy?: boolean;
  service?: boolean;
}

interface InstallState {
  installedAt?: string;
  node?: string;
  cli?: string;
  prevBaseUrl?: string | null;
  proxyInstalled?: boolean;
  service?: 'launchd' | 'systemd' | 'none';
}

const statePath = () => path.join(paths.home(), 'install.json');
const loadState = (): InstallState => {
  const r = readJson<InstallState>(statePath());
  return r.ok ? r.value : {};
};

export function claudeDesktopConfigPath(): string {
  const home = userHome();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

export const claudeCodeSettingsPath = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'settings.json');
export const claudeCodeUserConfigPath = () => path.join(userHome(), '.claude.json');
const launchdPlistPath = () => path.join(userHome(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
const systemdUnitPath = () => path.join(userHome(), '.config', 'systemd', 'user', 'grugbrain.service');

export function installedCli(): string {
  return path.join(paths.app(), 'cli.js');
}

function q(s: string): string {
  return `"${s.replace(/(["\\$`])/g, '\\$1')}"`;
}

function hookCommand(event: string): string {
  return `${q(process.execPath)} ${q(installedCli())} hook ${event} ${MARK}`;
}

/** Copy the built CLI into ~/.grug/app so hooks keep working after the npx cache is cleared. */
export function copyApp(): Step {
  const src = path.dirname(fs.realpathSync(process.argv[1]));
  const cli = path.join(src, 'cli.js');
  if (!fs.existsSync(cli)) return { target: 'app', ok: false, message: `Built cli.js not found next to ${process.argv[1]} (run npm run build).` };
  const dest = paths.app();
  ensureDir(dest);
  if (path.resolve(src) !== path.resolve(dest)) {
    for (const f of fs.readdirSync(src)) {
      if (/\.(js|cjs|mjs|map)$/.test(f) && !/\.d\./.test(f)) fs.copyFileSync(path.join(src, f), path.join(dest, f));
    }
  }
  fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify({ name: 'grugbrain-app', private: true, type: 'commonjs' }) + '\n');
  return { target: 'app', ok: true, message: `Copied runtime to ${dest}` };
}

/** Read a JSON config for modification. Returns null (and a failed Step) if corrupt. */
function openConfig(file: string): { value: any; step?: Step } {
  const r = readJson(file);
  if (!r.ok && r.exists) {
    return { value: null, step: { target: file, ok: false, message: `Skipped: ${file} is not valid JSON (${r.error}). Fix it, then re-run install. Nothing was changed.` } };
  }
  return { value: r.ok ? r.value || {} : {} };
}

function stripOurHooks(hooks: any): any {
  if (!hooks || typeof hooks !== 'object') return {};
  const out: any = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) {
      out[event] = groups;
      continue;
    }
    const kept = groups
      .map((g: any) => ({ ...g, hooks: (g.hooks || []).filter((h: any) => !(typeof h.command === 'string' && h.command.includes(MARK))) }))
      .filter((g: any) => g.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function ourHooks(): Record<string, any[]> {
  const h = (event: string, timeout: number) => ({ type: 'command', command: hookCommand(event), timeout });
  return {
    SessionStart: [{ hooks: [h('session-start', 10)] }],
    UserPromptSubmit: [{ hooks: [h('user-prompt', 10)] }],
    PreToolUse: [{ matcher: 'Read', hooks: [h('pre-tool', 5)] }],
    PostToolUse: [{ matcher: 'Read|Edit|Write|MultiEdit|NotebookEdit|Bash|Grep', hooks: [h('post-tool', 10)] }],
    Stop: [{ hooks: [h('stop', 10)] }],
    PreCompact: [{ hooks: [h('pre-compact', 10)] }],
    SessionEnd: [{ hooks: [h('session-end', 5)] }]
  };
}

export function installClaudeCode(withProxy: boolean): Step[] {
  const steps: Step[] = [];
  const file = claudeCodeSettingsPath();
  const { value: settings, step } = openConfig(file);
  if (step) return [step];
  const cfg = loadConfig();
  const state = loadState();
  const ours = `http://127.0.0.1:${cfg.port}`;

  const merged = stripOurHooks(settings.hooks);
  for (const [event, groups] of Object.entries(ourHooks())) merged[event] = [...(merged[event] || []), ...groups];
  settings.hooks = merged;

  let proxyOk = false;
  if (withProxy) {
    settings.env = settings.env || {};
    const usesCloud = settings.env.CLAUDE_CODE_USE_BEDROCK || settings.env.CLAUDE_CODE_USE_VERTEX || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX;
    if (usesCloud) {
      steps.push({ target: 'proxy', ok: false, message: 'Skipped proxy: Claude Code is configured for Bedrock/Vertex. Hooks + memory still active.' });
    } else {
      const prev = settings.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL;
      const isDefault = !prev || /^https:\/\/api\.anthropic\.com\/?$/.test(prev);
      if (prev && prev !== ours && !isDefault) {
        // Chain: keep the user's gateway as grug's upstream.
        cfg.upstream = prev;
        saveConfig(cfg);
        state.prevBaseUrl = settings.env.ANTHROPIC_BASE_URL ?? null;
        steps.push({ target: 'proxy', ok: true, message: `Existing ANTHROPIC_BASE_URL kept as upstream: ${prev}` });
      } else if (settings.env.ANTHROPIC_BASE_URL !== ours) {
        state.prevBaseUrl = settings.env.ANTHROPIC_BASE_URL ?? null;
      }
      settings.env.ANTHROPIC_BASE_URL = ours;
      proxyOk = true;
    }
  }
  const bak = backupFile(file);
  writeJsonAtomic(file, settings);
  state.proxyInstalled = proxyOk;
  writeJsonAtomic(statePath(), state);
  steps.push({
    target: 'claude-code',
    ok: true,
    message: `Hooks${proxyOk ? ' + proxy' : ''} written to ${file}${bak ? ` (backup: ${path.basename(bak)})` : ''}`
  });
  steps.push(installClaudeCodeMcp());
  return steps;
}

function installClaudeCodeMcp(): Step {
  const args = ['mcp', 'add', '--scope', 'user', 'grugbrain', '--', process.execPath, installedCli(), 'mcp'];
  spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'grugbrain'], { stdio: 'ignore', timeout: 20000 });
  const r = spawnSync('claude', args, { stdio: 'ignore', timeout: 20000 });
  if (r.status === 0) return { target: 'claude-code-mcp', ok: true, message: 'MCP server registered with `claude mcp add --scope user`' };
  // Fallback: edit ~/.claude.json directly.
  const file = claudeCodeUserConfigPath();
  if (!fs.existsSync(file)) return { target: 'claude-code-mcp', ok: false, message: 'Claude Code CLI not found; MCP not registered (hooks still work).' };
  const { value, step } = openConfig(file);
  if (step) return step;
  value.mcpServers = value.mcpServers || {};
  value.mcpServers.grugbrain = { type: 'stdio', command: process.execPath, args: [installedCli(), 'mcp'], env: {} };
  backupFile(file);
  writeJsonAtomic(file, value);
  return { target: 'claude-code-mcp', ok: true, message: `MCP server added to ${file}` };
}

export function installDesktop(): Step {
  const file = claudeDesktopConfigPath();
  if (!fs.existsSync(path.dirname(file))) return { target: 'claude-desktop', ok: false, message: 'Claude Desktop not found (skipped).' };
  const { value, step } = openConfig(file);
  if (step) return step;
  value.mcpServers = value.mcpServers || {};
  for (const k of LEGACY_KEYS) delete value.mcpServers[k];
  value.mcpServers.grugbrain = { command: process.execPath, args: [installedCli(), 'mcp'] };
  const bak = backupFile(file);
  writeJsonAtomic(file, value);
  return { target: 'claude-desktop', ok: true, message: `MCP server added to ${file}${bak ? ` (backup: ${path.basename(bak)})` : ''}. Restart Claude Desktop.` };
}

function run(cmd: string, args: string[]): boolean {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 15000 });
  return r.status === 0;
}

export function installService(): Step {
  ensureDir(paths.logs());
  const log = path.join(paths.logs(), 'daemon.log');
  const env = process.env.GRUG_HOME ? { GRUG_HOME: process.env.GRUG_HOME } : {};
  const state = loadState();
  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${installedCli()}</string><string>daemon</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>EnvironmentVariables</key><dict>${Object.entries(env).map(([k, v]) => `<key>${k}</key><string>${v}</string>`).join('')}</dict>
</dict></plist>
`;
    writeFileAtomic(launchdPlistPath(), plist);
    const uid = String(process.getuid ? process.getuid() : 501);
    run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]);
    const ok = run('launchctl', ['bootstrap', `gui/${uid}`, launchdPlistPath()]) || run('launchctl', ['load', '-w', launchdPlistPath()]);
    state.service = 'launchd';
    writeJsonAtomic(statePath(), state);
    return { target: 'service', ok, message: ok ? 'launchd agent installed (starts at login, auto-restarts)' : `Wrote ${launchdPlistPath()} but launchctl failed; run: launchctl load -w "${launchdPlistPath()}"` };
  }
  if (process.platform === 'linux') {
    const unit = `[Unit]
Description=grugbrain token saver daemon

[Service]
ExecStart=${q(process.execPath)} ${q(installedCli())} daemon
Restart=always
RestartSec=3
${Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join('\n')}

[Install]
WantedBy=default.target
`;
    writeFileAtomic(systemdUnitPath(), unit);
    const ok = run('systemctl', ['--user', 'daemon-reload']) && run('systemctl', ['--user', 'enable', '--now', 'grugbrain.service']);
    state.service = ok ? 'systemd' : 'none';
    writeJsonAtomic(statePath(), state);
    return { target: 'service', ok, message: ok ? 'systemd --user service enabled' : 'systemd unavailable; the daemon will be started on demand by the SessionStart hook.' };
  }
  state.service = 'none';
  writeJsonAtomic(statePath(), state);
  return { target: 'service', ok: false, message: 'No service manager support on this OS; daemon starts on demand from hooks.' };
}

export function install(opts: InstallOptions = {}): Step[] {
  const o = { code: true, desktop: true, proxy: true, service: true, ...opts };
  ensureDir(paths.home());
  const cfg = loadConfig();
  saveConfig(cfg); // materialize defaults so `grug config` shows them
  const steps: Step[] = [copyApp()];
  if (!steps[0].ok) return steps;
  if (o.code) steps.push(...installClaudeCode(o.proxy));
  if (o.desktop) steps.push(installDesktop());
  if (o.service) steps.push(installService());
  const state = loadState();
  state.installedAt = new Date().toISOString();
  state.node = process.execPath;
  state.cli = installedCli();
  writeJsonAtomic(statePath(), state);
  recordActivity({ kind: 'install', msg: `Installed: ${steps.filter((s) => s.ok).map((s) => s.target).join(', ')}` });
  return steps;
}

export function uninstall(purge = false): Step[] {
  const steps: Step[] = [];
  const state = loadState();
  const cfg = loadConfig();

  const code = claudeCodeSettingsPath();
  if (fs.existsSync(code)) {
    const { value, step } = openConfig(code);
    if (step) steps.push(step);
    else {
      value.hooks = stripOurHooks(value.hooks);
      if (!Object.keys(value.hooks).length) delete value.hooks;
      if (value.env && value.env.ANTHROPIC_BASE_URL === `http://127.0.0.1:${cfg.port}`) {
        if (state.prevBaseUrl) value.env.ANTHROPIC_BASE_URL = state.prevBaseUrl;
        else delete value.env.ANTHROPIC_BASE_URL;
        if (!Object.keys(value.env).length) delete value.env;
      }
      backupFile(code);
      writeJsonAtomic(code, value);
      steps.push({ target: 'claude-code', ok: true, message: `Removed hooks/proxy from ${code}` });
    }
  }
  const r = spawnSync('claude', ['mcp', 'remove', '--scope', 'user', 'grugbrain'], { stdio: 'ignore', timeout: 20000 });
  const userCfg = claudeCodeUserConfigPath();
  if (r.status !== 0 && fs.existsSync(userCfg)) {
    const { value } = openConfig(userCfg);
    if (value?.mcpServers?.grugbrain) {
      delete value.mcpServers.grugbrain;
      backupFile(userCfg);
      writeJsonAtomic(userCfg, value);
    }
  }
  steps.push({ target: 'claude-code-mcp', ok: true, message: 'MCP server removed' });

  const desk = claudeDesktopConfigPath();
  if (fs.existsSync(desk)) {
    const { value, step } = openConfig(desk);
    if (step) steps.push(step);
    else if (value.mcpServers) {
      for (const k of ['grugbrain', ...LEGACY_KEYS]) delete value.mcpServers[k];
      backupFile(desk);
      writeJsonAtomic(desk, value);
      steps.push({ target: 'claude-desktop', ok: true, message: `Removed from ${desk}` });
    }
  }

  if (process.platform === 'darwin' && fs.existsSync(launchdPlistPath())) {
    const uid = String(process.getuid ? process.getuid() : 501);
    run('launchctl', ['bootout', `gui/${uid}/${SERVICE_LABEL}`]) || run('launchctl', ['unload', '-w', launchdPlistPath()]);
    fs.unlinkSync(launchdPlistPath());
    steps.push({ target: 'service', ok: true, message: 'launchd agent removed' });
  } else if (process.platform === 'linux' && fs.existsSync(systemdUnitPath())) {
    run('systemctl', ['--user', 'disable', '--now', 'grugbrain.service']);
    fs.unlinkSync(systemdUnitPath());
    steps.push({ target: 'service', ok: true, message: 'systemd service removed' });
  }
  try {
    const pid = Number(fs.readFileSync(paths.pid(), 'utf8'));
    if (pid) process.kill(pid, 'SIGTERM');
  } catch {
    /* not running */
  }
  if (purge) {
    fs.rmSync(paths.home(), { recursive: true, force: true });
    steps.push({ target: 'data', ok: true, message: `Deleted ${paths.home()}` });
  } else {
    steps.push({ target: 'data', ok: true, message: `Kept memory/stats in ${paths.home()} (use --purge to delete)` });
  }
  return steps;
}

export interface Health {
  appInstalled: boolean;
  nodeExists: boolean;
  hooks: boolean;
  proxyConfigured: boolean;
  desktopMcp: boolean;
  codeMcp: boolean;
  service: string;
  settingsPath: string;
  desktopPath: string;
}

export function health(): Health {
  const state = loadState();
  const cfg = loadConfig();
  const settings = readJson(claudeCodeSettingsPath());
  const desk = readJson(claudeDesktopConfigPath());
  const user = readJson(claudeCodeUserConfigPath());
  const s = settings.ok ? settings.value : {};
  const hooks = JSON.stringify(s.hooks || {}).includes(MARK);
  return {
    appInstalled: fs.existsSync(installedCli()),
    nodeExists: !!state.node && fs.existsSync(state.node),
    hooks,
    proxyConfigured: s.env?.ANTHROPIC_BASE_URL === `http://127.0.0.1:${cfg.port}`,
    desktopMcp: !!(desk.ok && desk.value?.mcpServers?.grugbrain),
    codeMcp: !!(user.ok && user.value?.mcpServers?.grugbrain),
    service: state.service || 'none',
    settingsPath: claudeCodeSettingsPath(),
    desktopPath: claudeDesktopConfigPath()
  };
}
