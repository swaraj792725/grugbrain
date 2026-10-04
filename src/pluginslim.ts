/**
 * Turn off plugins that are never used. A loaded plugin costs on every session even when nothing of it is called:
 * its skills in the skill listing, its agents in the agent listing, its MCP servers' tool names and instructions,
 * and a "needs authentication" notice for each server that was never signed in (one synced plugin can bring 20).
 * Plugins with no skill call, `/command`, MCP tool call or agent run in the last N days get
 * `enabledPlugins["name@marketplace"] = false` in ~/.claude/settings.json (checked live in Claude Code 2.1.286:
 * the plugin, its servers, skills and agents are gone from the session). Every change is recorded in ~/.grug/slim.json
 * with the value it replaced, so `grug slim --plugins --undo` and uninstall put exactly that back.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { backupFile, readJson, userHome, writeJsonAtomic } from './config.js';
import { linesWith, loadSlimState, saveSlimState, settingsFile, transcripts, tsOf } from './slim.js';

export interface InstalledPlugin {
  /** The enabledPlugins key, `name@marketplace` (`name@synced` for plugins synced from claude.ai). */
  key: string;
  name: string;
}

export interface PluginRow extends InstalledPlugin {
  uses: number;
  /** Rough tokens this plugin adds to the start of a session (listings, tool names, notices), largest seen. */
  tokens: number;
  status: 'used' | 'disable' | 'new' | 'unseen' | 'off' | 'off-by-grug';
}

export interface PluginPlan {
  days: number;
  observedDays: number;
  transcripts: number;
  plugins: PluginRow[];
  disable: PluginRow[];
  savedTokens: number;
}

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude');

/** Plugins installed for the user: synced from claude.ai, and user-scope marketplace installs. Project-scope ones live in project settings and are left alone. */
export function installedPlugins(): InstalledPlugin[] {
  const out = new Map<string, InstalledPlugin>();
  const synced = path.join(claudeDir(), 'plugins', 'synced');
  let rounds: string[] = [];
  try {
    rounds = fs.readdirSync(synced);
  } catch {
    /* none */
  }
  for (const r of rounds) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(synced, r));
    } catch {
      continue;
    }
    for (const f of names) {
      const m = /^(.+)\.meta\.json$/.exec(f);
      if (m && names.includes(m[1])) out.set(`${m[1]}@synced`, { key: `${m[1]}@synced`, name: m[1] });
    }
  }
  const inst = readJson<any>(path.join(claudeDir(), 'plugins', 'installed_plugins.json'));
  const list = inst.ok && inst.value?.plugins && typeof inst.value.plugins === 'object' ? inst.value.plugins : {};
  for (const [key, entries] of Object.entries<any>(list)) {
    if (!key.includes('@') || !Array.isArray(entries) || !entries.some((e) => e?.scope === 'user')) continue;
    out.set(key, { key, name: key.slice(0, key.lastIndexOf('@')) });
  }
  return [...out.values()];
}

/** Which installed plugin a namespaced name belongs to (`plugin:skill`, `plugin:server:x`, `mcp__plugin_<name>_<server>__tool`). */
function ownerOf(names: string[], s: string, mcp = false): string | undefined {
  let best: string | undefined;
  for (const n of names) {
    const hit = mcp ? s.startsWith(`mcp__plugin_${n}_`) : s.startsWith(`${n}:`) || s.startsWith(`plugin:${n}:`);
    if (hit && (!best || n.length > best.length)) best = n;
  }
  return best;
}

export function planPlugins(opts: { days?: number; minObservedDays?: number } = {}): PluginPlan {
  const days = opts.days ?? 30;
  const minObserved = opts.minObservedDays ?? 7;
  const installed = installedPlugins();
  const names = installed.map((p) => p.name);
  const files = transcripts(days);
  const since = Date.now() - days * 864e5;
  const uses: Record<string, number> = {};
  const firstSeen: Record<string, number> = {};
  const skillsOf: Record<string, string> = {}; // bare skill name -> plugin, for `/skill` typed without the prefix
  const use = (p: string | undefined) => p && (uses[p] = (uses[p] || 0) + 1);
  const skillUses: string[] = []; // resolved after the scan, once every listing has been seen
  const seen = (p: string | undefined, ts: number) => p && (firstSeen[p] = Math.min(firstSeen[p] ?? Infinity, ts || Date.now()));
  let oldest = Date.now();
  // Cost of a plugin when loaded: its share of a session start's listings, the largest seen (a session where it
  // was turned off, or a resumed one, shows less).
  const cost: Record<string, number> = {};

  for (const f of files) {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const nl = text.indexOf('\n');
    try {
      const t = tsOf(JSON.parse(text.slice(0, nl < 0 ? undefined : nl)));
      if (t) oldest = Math.min(oldest, t);
    } catch {
      /* first line not an entry */
    }
    const chars: Record<string, number> = {};
    const add = (p: string | undefined, n: number) => p && (chars[p] = (chars[p] || 0) + n);
    const firstOfType = new Set<string>();
    for (const line of linesWith(text, '"attachment"')) {
      if (!/"(skill_listing|deferred_tools_delta|agent_listing_delta|mcp_instructions_delta)"/.test(line)) continue;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const a = e.attachment;
      const ts = tsOf(e);
      const first = !firstOfType.has(a?.type);
      if (a?.type) firstOfType.add(a.type);
      if (a?.type === 'skill_listing' && Array.isArray(a.names)) {
        for (const n of a.names) if (typeof n === 'string') {
          const p = ownerOf(names, n);
          seen(p, ts);
          if (p) skillsOf[n.slice(n.lastIndexOf(':') + 1)] = p;
        }
        if (first) for (const l of String(a.content || '').split('\n')) add(ownerOf(names, l.replace(/^- /, '')), l.length);
      } else if (a?.type === 'deferred_tools_delta') {
        for (const k of ['pendingMcpServers', 'needsAuthMcpServers', 'failedMcpServers'])
          for (const n of Array.isArray(a[k]) ? a[k] : []) if (typeof n === 'string') {
            seen(ownerOf(names, n), ts);
            if (first && k === 'needsAuthMcpServers') add(ownerOf(names, n), n.length + 2);
          }
        if (first) for (const l of Array.isArray(a.addedLines) ? a.addedLines : []) if (typeof l === 'string') add(ownerOf(names, l, true), l.length);
      } else if (a?.type === 'agent_listing_delta') {
        for (const n of Array.isArray(a.addedTypes) ? a.addedTypes : []) if (typeof n === 'string') seen(ownerOf(names, n), ts);
        if (first) for (const l of Array.isArray(a.addedLines) ? a.addedLines : []) if (typeof l === 'string') add(ownerOf(names, l.replace(/^- /, '')), l.length);
      } else if (a?.type === 'mcp_instructions_delta' && first) {
        for (const b of Array.isArray(a.addedBlocks) ? a.addedBlocks : []) if (typeof b === 'string') add(ownerOf(names, b.replace(/^## /, '')), b.length);
      }
    }
    for (const [p, n] of Object.entries(chars)) cost[p] = Math.max(cost[p] || 0, n);

    // Uses inside the window: Skill calls, plugin MCP tool calls, plugin agents.
    for (const needle of ['"name":"Skill"', '"mcp__plugin_', '"subagent_type"']) {
      for (const line of linesWith(text, needle)) {
        let e: any;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        if (tsOf(e) && tsOf(e) < since) continue;
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (b?.type !== 'tool_use' || typeof b.name !== 'string') continue;
          if (needle === '"name":"Skill"' && b.name === 'Skill' && typeof b.input?.skill === 'string') {
            const s = b.input.skill.replace(/^\//, '');
            skillUses.push(s);
          } else if (needle === '"mcp__plugin_' && b.name.startsWith('mcp__plugin_')) use(ownerOf(names, b.name, true));
          else if (needle === '"subagent_type"' && (b.name === 'Agent' || b.name === 'Task') && typeof b.input?.subagent_type === 'string') use(ownerOf(names, b.input.subagent_type));
        }
      }
    }
    for (const m of text.matchAll(/<command-name>\/?([\w:.-]+)<\/command-name>/g)) skillUses.push(m[1]);
  }
  for (const s of skillUses) use(ownerOf(names, s) || skillsOf[s]);

  const settings = readJson<any>(settingsFile());
  const enabled: Record<string, unknown> = settings.ok && settings.value?.enabledPlugins && typeof settings.value.enabledPlugins === 'object' ? settings.value.enabledPlugins : {};
  const state = loadSlimState();
  const observedDays = Math.max(0, Math.floor((Date.now() - oldest) / 864e5));
  const rows: PluginRow[] = installed.map((p) => {
    const row = { ...p, uses: uses[p.name] || 0, tokens: Math.round((cost[p.name] || 0) / 4) };
    if (enabled[p.key] === false) return { ...row, status: p.key in state.plugins ? 'off-by-grug' : 'off' };
    if (row.uses) return { ...row, status: 'used' };
    if (firstSeen[p.name] === undefined) return { ...row, status: 'unseen' };
    if (firstSeen[p.name] > Date.now() - minObserved * 864e5 || observedDays < minObserved) return { ...row, status: 'new' };
    return { ...row, status: 'disable' };
  });
  const disable = rows.filter((r) => r.status === 'disable');
  return { days, observedDays, transcripts: files.length, plugins: rows, disable, savedTokens: disable.reduce((s, r) => s + r.tokens, 0) };
}

function writeEnabled(change: (o: Record<string, unknown>) => void): { ok: boolean; message: string } {
  const file = settingsFile();
  const r = readJson<any>(file);
  if (!r.ok && r.exists) return { ok: false, message: `${file} is not valid JSON (${r.error}); nothing changed.` };
  const value = r.ok && r.value ? r.value : {};
  const o: Record<string, unknown> = value.enabledPlugins && typeof value.enabledPlugins === 'object' ? { ...value.enabledPlugins } : {};
  change(o);
  if (Object.keys(o).length) value.enabledPlugins = o;
  else delete value.enabledPlugins;
  const bak = backupFile(file);
  writeJsonAtomic(file, value);
  return { ok: true, message: `Updated ${file}${bak ? ` (backup: ${path.basename(bak)})` : ''}. New sessions use it.` };
}

/** Turn off the planned plugins, remembering what each setting was. */
export function applyPlugins(plan: Pick<PluginPlan, 'disable'>): { ok: boolean; message: string } {
  const prev = { ...loadSlimState().plugins };
  const res = writeEnabled((o) => {
    for (const p of plan.disable) {
      if (!(p.key in prev)) prev[p.key] = typeof o[p.key] === 'boolean' ? (o[p.key] as boolean) : null;
      o[p.key] = false;
    }
  });
  if (res.ok) saveSlimState({ plugins: prev });
  return res;
}

function restore(o: Record<string, unknown>, prev: Record<string, boolean | null>): string[] {
  const back: string[] = [];
  for (const [key, was] of Object.entries(prev)) {
    if (o[key] !== false) continue; // the user changed it since: theirs now
    if (was === null) delete o[key];
    else o[key] = was;
    back.push(key);
  }
  return back;
}

/** Turn back on every plugin grug turned off (left alone if the user changed it since). */
export function undoPlugins(): { ok: boolean; message: string; restored: string[] } {
  const prev = loadSlimState().plugins;
  if (!Object.keys(prev).length) return { ok: true, message: 'Nothing to undo.', restored: [] };
  let restored: string[] = [];
  const res = writeEnabled((o) => {
    restored = restore(o, prev);
  });
  if (res.ok) saveSlimState({ plugins: {} });
  return { ...res, restored };
}

/** Uninstall: put grug's plugin changes back in an already-open settings object. */
export function stripPluginSlim(settings: any): number {
  const prev = loadSlimState().plugins;
  if (!Object.keys(prev).length) return 0;
  const o = settings?.enabledPlugins;
  let n = 0;
  if (o && typeof o === 'object') {
    n = restore(o, prev).length;
    if (!Object.keys(o).length) delete settings.enabledPlugins;
  }
  saveSlimState({ plugins: {} });
  return n;
}
