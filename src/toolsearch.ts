/**
 * Tool search in the desktop Code tab.
 *
 * The app starts Claude Code with ENABLE_TOOL_SEARCH=auto. In auto mode Claude Code defers MCP tool
 * schemas only when they add up to at least 10% of the model's context window (100k tokens for a 1M
 * model); below that it inlines EVERY tool schema in every request. Read from Claude Code 2.1.286
 * and matched to transcripts 2026-10-06: sessions whose connectors were slow or missing at start
 * sent ~210 schemas (~590k chars, ~100k tokens) instead of ~49, sat at ~175k after compaction and
 * thrashed. The user's own settings.json cannot change it (Claude Code drops settings env keys the
 * host set at spawn); OS-level managed settings with ENABLE_TOOL_SEARCH=force can.
 *
 * Turning plugins off (grug slim --plugins) lowers the MCP total and can push it below the bar, so
 * it is refused in the app until tool search is forced.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeDesktopConfigPath } from './install.js';

export function managedSettingsPath(): string {
  if (process.env.GRUG_MANAGED_SETTINGS) return process.env.GRUG_MANAGED_SETTINGS;
  if (process.platform === 'darwin') return '/Library/Application Support/ClaudeCode/managed-settings.json';
  if (process.platform === 'win32') return 'C:\\Program Files\\ClaudeCode\\managed-settings.json';
  return '/etc/claude-code/managed-settings.json';
}

/** Managed settings set ENABLE_TOOL_SEARCH=force (Claude Code reads it from the admin tier only). */
export function toolSearchForced(): boolean {
  try {
    const s = JSON.parse(fs.readFileSync(managedSettingsPath(), 'utf8'));
    return s?.env?.ENABLE_TOOL_SEARCH === 'force';
  } catch {
    return false;
  }
}

/** The desktop app's bundled Claude Code is installed (the Code tab), which runs tool search in auto mode. */
export function desktopCodePresent(): boolean {
  try {
    return fs.statSync(path.join(path.dirname(claudeDesktopConfigPath()), 'claude-code')).isDirectory();
  } catch {
    return false;
  }
}

/** Shell commands that force tool search on (macOS/Linux need sudo; the user runs them, never grug). */
export function forceToolSearchCommands(): string[] {
  const file = managedSettingsPath();
  const json = '{\\n  "parentSettingsBehavior": "merge",\\n  "env": { "ENABLE_TOOL_SEARCH": "force" }\\n}\\n';
  if (process.platform === 'win32') return [`notepad "${file}"   (contents: {"parentSettingsBehavior":"merge","env":{"ENABLE_TOOL_SEARCH":"force"}})`];
  return [`sudo mkdir -p "${path.dirname(file)}"`, `printf '${json}' | sudo tee "${file}"`];
}
