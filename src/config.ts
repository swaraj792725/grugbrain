/**
 * Paths, config, and crash-safe JSON file helpers.
 * Everything grug owns lives under ~/.grug (override with GRUG_HOME).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const VERSION = '2.0.0';

/** $HOME first (honoured everywhere, including worker threads), then the OS answer. */
export function userHome(): string {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function grugHome(): string {
  return process.env.GRUG_HOME || path.join(userHome(), '.grug');
}

export const paths = {
  home: () => grugHome(),
  config: () => path.join(grugHome(), 'config.json'),
  events: () => path.join(grugHome(), 'events.jsonl'),
  activity: () => path.join(grugHome(), 'activity.jsonl'),
  memory: () => path.join(grugHome(), 'memory.json'),
  sessions: () => path.join(grugHome(), 'sessions'),
  backups: () => path.join(grugHome(), 'backups'),
  app: () => path.join(grugHome(), 'app'),
  graphHtml: () => path.join(grugHome(), 'graph.html'),
  logs: () => path.join(grugHome(), 'logs'),
  pid: () => path.join(grugHome(), 'daemon.pid')
};

export interface GrugConfig {
  port: number;
  upstream: string;
  /** Output style injected at session start: off | lite | full (full = caveman speak). */
  terse: 'off' | 'lite' | 'full';
  proxy: {
    enabled: boolean;
    autoCache: boolean;
    trimToolResults: boolean;
    dedupeReads: boolean;
    /** tool_result text longer than this (chars) gets head/tail trimmed. */
    trimThresholdChars: number;
    trimKeepHeadChars: number;
    trimKeepTailChars: number;
  };
  readGuard: {
    enabled: boolean;
    /** Full-file Read calls on files bigger than this (bytes) are redirected to a ranged read. */
    maxBytes: number;
  };
  memory: {
    enabled: boolean;
    /** Token budget for the brief injected at session start. */
    briefTokens: number;
    /** Token budget for per-prompt recall. */
    recallTokens: number;
    halfLifeDays: number;
    /** Sessions older than this are folded into a digest. */
    foldAfterDays: number;
    maxNodesPerProject: number;
    /** Markdown vault (Obsidian-compatible). Defaults to ~/.grug/vault. */
    vaultDir: string;
  };
}

export function defaultConfig(): GrugConfig {
  return {
    port: 4747,
    upstream: 'https://api.anthropic.com',
    terse: 'lite',
    proxy: {
      enabled: true,
      autoCache: true,
      trimToolResults: true,
      dedupeReads: true,
      trimThresholdChars: 24000,
      trimKeepHeadChars: 10000,
      trimKeepTailChars: 6000
    },
    readGuard: {
      enabled: true,
      maxBytes: 60000
    },
    memory: {
      enabled: true,
      briefTokens: 700,
      recallTokens: 250,
      halfLifeDays: 14,
      foldAfterDays: 21,
      maxNodesPerProject: 400,
      vaultDir: path.join(grugHome(), 'vault')
    }
  };
}

function deepMerge<T>(base: T, over: any): T {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) {
    const b = (base as any)[k];
    out[k] = b && typeof b === 'object' && !Array.isArray(b) ? deepMerge(b, v) : v;
  }
  return out;
}

export function loadConfig(): GrugConfig {
  const raw = readJson(paths.config());
  return deepMerge(defaultConfig(), raw.ok ? raw.value : {});
}

export function saveConfig(cfg: GrugConfig): void {
  writeJsonAtomic(paths.config(), cfg);
}

/** Set a dotted key, coercing "true"/"false"/numbers. */
export function setConfigValue(key: string, value: string): GrugConfig {
  const cfg: any = loadConfig();
  const parts = key.split('.');
  let cur = cfg;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) throw new Error(`Unknown config key: ${key}`);
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (!(last in cur)) throw new Error(`Unknown config key: ${key}`);
  let v: any = value;
  if (value === 'true') v = true;
  else if (value === 'false') v = false;
  else if (value !== '' && !isNaN(Number(value)) && typeof cur[last] === 'number') v = Number(value);
  cur[last] = v;
  saveConfig(cfg);
  return cfg;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export type JsonRead<T = any> =
  | { ok: true; exists: true; value: T }
  | { ok: false; exists: boolean; error?: string };

/** Reads JSON without ever throwing. Distinguishes "missing" from "corrupt". */
export function readJson<T = any>(file: string): JsonRead<T> {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { ok: false, exists: false };
  }
  if (!text.trim()) return { ok: true, exists: true, value: {} as T };
  try {
    return { ok: true, exists: true, value: JSON.parse(text) };
  } catch (err: any) {
    return { ok: false, exists: true, error: err.message };
  }
}

/** Write via temp file + rename so a crash never leaves half a file. */
export function writeJsonAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

export function writeFileAtomic(file: string, content: string): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

/** Copy a file into ~/.grug/backups with a timestamp. Returns backup path or null. */
export function backupFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  ensureDir(paths.backups());
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(paths.backups(), `${path.basename(file)}.${stamp}.bak`);
  fs.copyFileSync(file, dest);
  return dest;
}
