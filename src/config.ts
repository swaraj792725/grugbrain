/**
 * Paths, config, and crash-safe JSON file helpers.
 * Everything grug owns lives under ~/.grug (override with GRUG_HOME).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

declare const __GRUG_VERSION__: string | undefined;
/** Injected from package.json at build time (see tsup.config.ts). */
export const VERSION: string = typeof __GRUG_VERSION__ !== 'undefined' ? __GRUG_VERSION__ : '0.0.0-dev';

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
  cache: () => path.join(grugHome(), 'cache'),
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
    /** Limit for commands whose output is the point (cat, sed -n, grep, git diff): never cut early. */
    trimContentChars: number;
    trimKeepHeadChars: number;
    trimKeepTailChars: number;
  };
  readGuard: {
    enabled: boolean;
    /** Full-file Read calls on files bigger than this (bytes) are redirected to a ranged read. */
    maxBytes: number;
  };
  /** Skip re-reading a file range that is unchanged and still in context (asked once; a repeat is allowed). */
  rereadGuard: {
    enabled: boolean;
    /** Only skip when the earlier read happened within this many minutes. */
    windowMinutes: number;
  };
  /** Collapse test-runner / compiler output to failures + summary. */
  testSummary: {
    enabled: boolean;
    minChars: number;
  };
  /** Per-command output rules (installs, builds, git transfers) and JSON compaction; originals are always saved. */
  commandRules: {
    enabled: boolean;
    minChars: number;
    /** Compact big JSON arrays of objects (first items in full, then one identity line each). */
    json: boolean;
    jsonMinChars: number;
    /** Also apply to MCP tool results. */
    mcp: boolean;
  };
  /** Check GitHub releases for a newer grugbrain (once a day, notify only). */
  updateCheck: boolean;
  /** Status line under Claude Code's input box: context size, cost per reply, when to /clear, cache timer, tips. */
  appPlugin: { enabled: boolean };
  statusLine: {
    enabled: boolean;
    /** The user's own status line command, run first; grug appends its notice. Set by install when one existed. */
    wrap: string;
    /** Rotate short user-side tips (/model, /compact...) when nothing more urgent shows. */
    tips: boolean;
    /** Always-on panel: second row with animation and savings bar. */
    panel: boolean;
    /** Re-run the status line every N seconds so the animation and timers move (Claude Code refreshInterval, min 1). */
    refreshSeconds: number;
  };
  /** One-line grug summary (savings bar, context bar) as a user-only message, for the desktop app where no status line is drawn. */
  appSummary: { enabled: boolean; everyPrompts: number };
  /** Chat size you would typically run at without grug; the smaller-chat saving is counted against it, never above. */
  savings: { baselineContextTokens: number };
  /** Tell the user (not the model) when a session's context gets expensive; levels double from firstTokens. */
  contextAlert: {
    enabled: boolean;
    firstTokens: number;
  };
  /** Images, screenshots, PDFs and video: skip repeats, shrink big image files, text-first PDFs, frame sheets for video. */
  mediaGuard: {
    enabled: boolean;
    /** Skip a screenshot when nothing happened since the identical last one (ask again to override). */
    dedupeScreenshots: boolean;
    /** Skip re-reading an unchanged image that is still in context (ask again to override). */
    dedupeImageReads: boolean;
    /** One short hint, the first time a screenshot tool is used in a context: prefer text snapshots. */
    guidance: boolean;
    /** Image files inside the project longer than this (px, long edge) are read from a shrunken copy. 0 = never shrink. */
    imageMaxEdge: number;
    /** A PDF Read asking for more pages than this is first pointed at the text tool (ask again to override). */
    pdfPages: number;
    /** Tell the user when images in context pass this many tokens (then double). 0 = off. */
    imageAlertTokens: number;
  };
  /** Tell the user (not the model) when the prompt cache expired on a big session, so the next reply re-writes it all. */
  idleAlert: {
    enabled: boolean;
    /** Only when the extra cost of that cold reply is at least this many dollars (API-equivalent). */
    minExtraUsd: number;
  };
  /** Let Claude Code compact on its own at this context size (0 = leave Claude Code's default). grug restores its handoff afterwards. */
  autoCompact: {
    windowTokens: number;
    /** Never apply a window less than 80k above how big sessions start (measured from transcripts), so compaction can't thrash. */
    guard: boolean;
  };
  /** Model for Claude Code subagents ('' = same as the main conversation), e.g. sonnet or haiku. */
  routing: {
    subagentModel: string;
    /** Read-only search subagents (comma list of subagent types) run on lightModel when the main chat is on a pricier model. '' = off. */
    lightAgents: string;
    lightModel: string;
  };
  /** Carry a session over to a fresh one: written on /clear, session end, and context alerts. */
  handoff: {
    enabled: boolean;
    maxTokens: number;
    maxAgeHours: number;
    /** Put the real git state (branch, unpushed, uncommitted files, last commit) in the handoff. Read-only, never takes a lock. */
    git: boolean;
  };
  /** Per-prompt recall of memory, earlier sessions and code (UserPromptSubmit), only when something clearly matches. */
  autoRecall: {
    enabled: boolean;
    /** Hard cap for one injected block. */
    maxTokens: number;
    /** Total recall tokens per session (since its last compaction); the bar rises as it fills. */
    sessionTokens: number;
    /** Give each subagent recall + code hints for the task it is launched with (appended to its prompt). */
    subagents: boolean;
    /** Hard cap for one subagent block. */
    subagentTokens: number;
  };
  /** Graph-first code context: compact repo map at session start + relevant files/symbols per prompt (code projects only). */
  graphContext: {
    enabled: boolean;
    /** Token budget for the repo map at session start. */
    mapTokens: number;
    /** Graph-first hints at tool time: where a searched symbol lives (Grep), outline before a full Read of a mid-size code file. */
    hints: boolean;
    /** Code files at least this big (bytes) get the outline hint once before a full Read. 0 = off. */
    readHintBytes: number;
  };
  /** Quality gates: check the work before Claude says done, and catch broken edits at once. Cost tokens only when something is wrong. */
  quality: {
    /** Stop hook: run the project's check once when files changed this turn and send Claude back if it fails. */
    verify: boolean;
    /** Check command ('' = detect: typecheck script, tsc, test script, pytest, cargo check, go vet). */
    verifyCommand: string;
    /** Give up (and stay silent) after this many seconds. */
    verifyTimeoutSec: number;
    /** Most times one turn can be sent back for the same problem. */
    verifyMaxRounds: number;
    /** After Edit/Write: a syntax check of that file; only a real error is reported. */
    editGuard: boolean;
    /** TypeScript edits: report type errors the edit introduced in the file or its importers (old errors are ignored). */
    typeCheck: boolean;
    /** Before an edit: the stored project rules that concern the file (once per session each). */
    conventions: boolean;
  };
  /** Tell the user (not the model) when a prompt looks like a new task while the context is big: /clear is cheaper than dragging it along. */
  taskBoundary: {
    enabled: boolean;
    minTokens: number;
  };
  /** Fewer replies: ask Claude to batch independent lookups (each reply re-sends the whole context). */
  batching: {
    /** One sentence at session/subagent start. */
    rule: boolean;
    /** A short note after a chain of single-lookup replies (at most 3 per session). */
    nudge: boolean;
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
    /** Keep a text-only copy of every conversation so `history` still finds it after Claude Code cleans up its transcripts. */
    archive: boolean;
    archiveMaxMb: number;
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
      trimThresholdChars: 9000,
      trimContentChars: 24000,
      trimKeepHeadChars: 4500,
      trimKeepTailChars: 3000
    },
    readGuard: {
      enabled: true,
      maxBytes: 60000
    },
    rereadGuard: {
      // Claude Code >= 2.1 already answers unchanged re-reads with a short "file unchanged" stub,
      // so this is off by default; useful for older versions and other clients.
      enabled: false,
      windowMinutes: 45
    },
    testSummary: {
      enabled: true,
      minChars: 3000
    },
    commandRules: {
      enabled: true,
      minChars: 1500,
      json: true,
      jsonMinChars: 12000,
      mcp: true
    },
    updateCheck: true,
    appPlugin: { enabled: true },
    statusLine: { enabled: true, wrap: '', tips: true, panel: true, refreshSeconds: 2 },
    appSummary: { enabled: true, everyPrompts: 8 },
    savings: { baselineContextTokens: 500000 },
    contextAlert: {
      enabled: true,
      firstTokens: 150000
    },
    mediaGuard: {
      enabled: true,
      dedupeScreenshots: true,
      dedupeImageReads: true,
      guidance: true,
      imageMaxEdge: 1200,
      pdfPages: 4,
      imageAlertTokens: 20000
    },
    idleAlert: {
      enabled: true,
      minExtraUsd: 0.25
    },
    autoCompact: {
      windowTokens: 150000,
      guard: true
    },
    routing: {
      subagentModel: '',
      lightAgents: 'Explore',
      lightModel: 'sonnet'
    },
    handoff: {
      enabled: true,
      maxTokens: 1200,
      maxAgeHours: 48,
      git: true
    },
    autoRecall: {
      enabled: true,
      maxTokens: 800,
      sessionTokens: 2500,
      subagents: true,
      subagentTokens: 500
    },
    graphContext: {
      enabled: true,
      mapTokens: 600,
      hints: true,
      readHintBytes: 12000
    },
    quality: {
      verify: true,
      verifyCommand: '',
      verifyTimeoutSec: 90,
      verifyMaxRounds: 2,
      editGuard: true,
      typeCheck: true,
      conventions: true
    },
    taskBoundary: {
      enabled: true,
      minTokens: 60000
    },
    batching: {
      rule: true,
      nudge: true
    },
    memory: {
      enabled: true,
      briefTokens: 700,
      recallTokens: 250,
      halfLifeDays: 14,
      foldAfterDays: 21,
      maxNodesPerProject: 400,
      vaultDir: path.join(grugHome(), 'vault'),
      archive: true,
      archiveMaxMb: 60
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

const ENUMS: Record<string, string[]> = { terse: ['off', 'lite', 'full'], 'routing.subagentModel': ['', 'sonnet', 'haiku', 'opus', 'inherit'], 'routing.lightModel': ['', 'sonnet', 'haiku'] };

const RANGES: Record<string, [number, number]> = {
  'autoRecall.maxTokens': [100, 4000],
  'autoRecall.sessionTokens': [200, 20000],
  'autoRecall.subagentTokens': [100, 2000],
  'mediaGuard.pdfPages': [1, 100],
  'taskBoundary.minTokens': [20000, 1000000],
  'graphContext.mapTokens': [100, 3000],
  'quality.verifyTimeoutSec': [5, 600],
  'quality.verifyMaxRounds': [1, 5]
};

export function loadConfig(): GrugConfig {
  const raw = readJson(paths.config());
  const cfg = deepMerge(defaultConfig(), raw.ok ? raw.value : {});
  // Repair values saved by older versions without validation (e.g. "full # comment" typed in zsh).
  const t = String(cfg.terse).trim().split(/\s+/)[0];
  cfg.terse = (ENUMS.terse.includes(t) ? t : 'lite') as GrugConfig['terse'];
  // GRUG_SET="a.b=v,c=w": per-process overrides that are never saved (bench ablations, one-off runs).
  for (const pair of String(process.env.GRUG_SET || '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    try {
      assignConfigValue(cfg, pair.slice(0, i).trim(), pair.slice(i + 1));
    } catch {
      /* a bad override is ignored, like a bad saved value */
    }
  }
  return cfg;
}

export function saveConfig(cfg: GrugConfig): void {
  writeJsonAtomic(paths.config(), cfg);
}

/** Set a dotted key, coercing "true"/"false"/numbers. */
export function setConfigValue(key: string, value: string): GrugConfig {
  const cfg = loadConfig();
  assignConfigValue(cfg, key, value);
  saveConfig(cfg);
  return cfg;
}

/** Validate and set one dotted key on a config object (no save). */
export function assignConfigValue(target: GrugConfig, key: string, value: string): void {
  const cfg: any = target;
  const parts = key.split('.');
  let cur = cfg;
  for (const p of parts.slice(0, -1)) {
    if (typeof cur[p] !== 'object' || cur[p] === null) throw new Error(`Unknown config key: ${key}`);
    cur = cur[p];
  }
  const last = parts[parts.length - 1];
  if (!(last in cur)) throw new Error(`Unknown config key: ${key}`);
  const hint = /(^|\s)#/.test(value) ? ` (zsh passes "# comments" as arguments: leave them off)` : '';
  let v: any = value.trim();
  const kind = typeof cur[last];
  if (kind === 'boolean') {
    if (v !== 'true' && v !== 'false') throw new Error(`${key} must be true or false, got "${value}"${hint}`);
    v = v === 'true';
  } else if (kind === 'number') {
    if (v === '' || !Number.isFinite(Number(v)) || Number(v) < 0) throw new Error(`${key} must be a number ≥ 0, got "${value}"${hint}`);
    v = Number(v);
    if (key === 'autoCompact.windowTokens' && v !== 0 && (v < 100000 || v > 1000000))
      throw new Error(`${key} must be 0 (Claude Code default) or between 100000 and 1000000`);
    if (key === 'graphContext.readHintBytes' && v !== 0 && (v < 4000 || v > 60000)) throw new Error(`${key} must be 0 (off) or between 4000 and 60000`);
    if (key === 'mediaGuard.imageMaxEdge' && v !== 0 && (v < 512 || v > 4096)) throw new Error(`${key} must be 0 (never shrink) or between 512 and 4096`);
    if (key === 'mediaGuard.imageAlertTokens' && v !== 0 && (v < 5000 || v > 500000)) throw new Error(`${key} must be 0 (off) or between 5000 and 500000`);
    const range = RANGES[key];
    if (range && (v < range[0] || v > range[1])) throw new Error(`${key} must be between ${range[0]} and ${range[1]}, got "${value}"`);
  } else if (ENUMS[key] && !ENUMS[key].includes(v)) {
    throw new Error(`${key} must be one of: ${ENUMS[key].join(', ')}; got "${value}"${hint}`);
  } else if (kind === 'object') throw new Error(`${key} is a group; set one of its keys (see: grug config)`);
  cur[last] = v;
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
