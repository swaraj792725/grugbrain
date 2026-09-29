/**
 * Installer Engine: Automatic macOS Claude Desktop configuration injector & daemon manager.
 * Zero-touch setup: injects claude-token-saver into ~/Library/Application Support/Claude/claude_desktop_config.json.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface InstallStatus {
  configPath: string;
  configExists: boolean;
  isInstalled: boolean;
  totalTokensSaved: number;
  totalSessionsOptimized: number;
}

export interface SaverStats {
  totalTokensSaved: number;
  totalSessionsOptimized: number;
  lastUpdated: string;
}

export function getClaudeConfigPath(): string {
  const home = os.homedir();
  const platform = os.platform();

  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  } else {
    return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
  }
}

export function getStatsFilePath(): string {
  const dir = path.join(os.homedir(), '.claude-token-saver');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'stats.json');
}

export function readStats(): SaverStats {
  const statsPath = getStatsFilePath();
  if (fs.existsSync(statsPath)) {
    try {
      const data = fs.readFileSync(statsPath, 'utf8');
      return JSON.parse(data);
    } catch {
      // Fallback on error
    }
  }
  return {
    totalTokensSaved: 0,
    totalSessionsOptimized: 0,
    lastUpdated: new Date().toISOString()
  };
}

export function updateStats(tokensSaved: number): SaverStats {
  const stats = readStats();
  stats.totalTokensSaved += tokensSaved;
  stats.totalSessionsOptimized += 1;
  stats.lastUpdated = new Date().toISOString();

  const statsPath = getStatsFilePath();
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), 'utf8');
  return stats;
}

export function installClaudeSaver(): { success: boolean; configPath: string; message: string } {
  const configPath = getClaudeConfigPath();
  const dir = path.dirname(configPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let config: any = {};
  if (fs.existsSync(configPath)) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(raw);
    } catch {
      config = {};
    }
  }

  if (!config.mcpServers) {
    config.mcpServers = {};
  }

  // Inject system-wide claude-token-saver MCP server configuration
  config.mcpServers['claude-token-saver'] = {
    command: 'npx',
    args: ['-y', '@swaraj792725/claude-token-saver', 'server']
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');

  return {
    success: true,
    configPath,
    message: `Successfully installed zero-touch @swaraj792725/claude-token-saver into ${configPath}. Claude Desktop will automatically load it on restart.`
  };
}

export function uninstallClaudeSaver(): { success: boolean; configPath: string; message: string } {
  const configPath = getClaudeConfigPath();

  if (!fs.existsSync(configPath)) {
    return {
      success: true,
      configPath,
      message: 'Claude Desktop config does not exist.'
    };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);

    if (config.mcpServers && config.mcpServers['claude-token-saver']) {
      delete config.mcpServers['claude-token-saver'];
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    }

    return {
      success: true,
      configPath,
      message: `Successfully uninstalled claude-token-saver from ${configPath}`
    };
  } catch (err: any) {
    return {
      success: false,
      configPath,
      message: `Failed to update config: ${err.message}`
    };
  }
}

export function getInstallStatus(): InstallStatus {
  const configPath = getClaudeConfigPath();
  const configExists = fs.existsSync(configPath);
  let isInstalled = false;

  if (configExists) {
    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const config = JSON.parse(raw);
      if (config.mcpServers && config.mcpServers['claude-token-saver']) {
        isInstalled = true;
      }
    } catch {
      isInstalled = false;
    }
  }

  const stats = readStats();

  return {
    configPath,
    configExists,
    isInstalled,
    totalTokensSaved: stats.totalTokensSaved,
    totalSessionsOptimized: stats.totalSessionsOptimized
  };
}
