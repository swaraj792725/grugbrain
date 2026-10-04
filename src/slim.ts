/**
 * Slim the skill listing. Claude Code sends every installed skill's name and description to the
 * model (the `skill_listing` attachment, ~30k chars with many plugins), and that text is re-read
 * on every reply. Skills from plugins that were never invoked in the last N days are switched to
 * `skillOverrides: "name-only"`: Claude still sees the name and can call the skill, only the
 * description goes (most of the cost). `/name` works as before.
 * Only plugin skills (`plugin:skill`) are touched, never an override the user set, and every
 * change is recorded in ~/.grug/slim.json so `grug slim --undo` / uninstall can put it back.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { backupFile, paths, readJson, userHome, writeJsonAtomic } from './config.js';

export const SLIM_MODE = 'name-only';

export interface SlimPlan {
  /** Days of transcripts looked at, and how many days back the oldest one actually goes. */
  days: number;
  observedDays: number;
  transcripts: number;
  listed: number;
  listingChars: number;
  used: Record<string, number>;
  /** Unused plugin skills to slim, with the description characters they would drop. */
  hide: Array<{ name: string; chars: number }>;
  /** Skills grug hid earlier that have been used since: shown again. */
  unhide: string[];
  /** Hidden by grug already and still unused. */
  alreadyHidden: number;
  savedTokens: number;
}

export interface SlimState {
  hidden: string[];
  /** Plugins grug turned off: `name@marketplace` -> the enabledPlugins value before (null = not set). */
  plugins: Record<string, boolean | null>;
  at?: string;
}

const stateFile = () => path.join(paths.home(), 'slim.json');
export const settingsFile = () => path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'settings.json');

export function loadSlimState(): SlimState {
  const r = readJson<SlimState>(stateFile());
  const pl = r.ok && r.value?.plugins && typeof r.value.plugins === 'object' ? r.value.plugins : {};
  return {
    hidden: r.ok && Array.isArray(r.value?.hidden) ? r.value.hidden.filter((x) => typeof x === 'string') : [],
    plugins: Object.fromEntries(Object.entries(pl).filter(([, v]) => v === null || typeof v === 'boolean')),
    at: r.ok ? r.value?.at : undefined
  };
}

/** Save part of the state, keeping the rest (skills and plugins share the file). */
export function saveSlimState(part: Partial<SlimState>): void {
  const cur = loadSlimState();
  writeJsonAtomic(stateFile(), { hidden: cur.hidden, plugins: cur.plugins, ...part, at: new Date().toISOString() });
}

export function transcripts(days: number): string[] {
  const root = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(userHome(), '.claude'), 'projects');
  const cutoff = Date.now() - days * 864e5;
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) {
        try {
          if (fs.statSync(p).mtimeMs >= cutoff) out.push(p);
        } catch {
          /* gone */
        }
      }
    }
  };
  walk(root);
  return out;
}

/** Every full line of `text` that contains `needle`. */
export function linesWith(text: string, needle: string): string[] {
  const out: string[] = [];
  let i = text.indexOf(needle);
  while (i >= 0) {
    const a = text.lastIndexOf('\n', i) + 1;
    let b = text.indexOf('\n', i);
    if (b < 0) b = text.length;
    out.push(text.slice(a, b));
    i = text.indexOf(needle, b);
  }
  return out;
}

export const tsOf = (e: any) => (typeof e?.timestamp === 'string' ? Date.parse(e.timestamp) || 0 : 0);

/** Look at recent transcripts: what the listing holds, what was used, what can be hidden. */
export function planSlim(opts: { days?: number; minObservedDays?: number } = {}): SlimPlan {
  const days = opts.days ?? 30;
  const minObserved = opts.minObservedDays ?? 7;
  const files = transcripts(days);
  const since = Date.now() - days * 864e5;
  const used: Record<string, number> = {};
  const firstSeen: Record<string, number> = {};
  let latest: { ts: number; names: string[]; content: string } | null = null;
  let oldest = Date.now();
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
    for (const line of linesWith(text, '"skill_listing"')) {
      try {
        const e = JSON.parse(line);
        const a = e.attachment;
        if (a?.type !== 'skill_listing' || !Array.isArray(a.names)) continue;
        const ts = tsOf(e);
        if (ts) oldest = Math.min(oldest, ts);
        for (const n of a.names) if (typeof n === 'string') firstSeen[n] = Math.min(firstSeen[n] ?? Infinity, ts || Date.now());
        if (!latest || ts >= latest.ts) latest = { ts, names: a.names, content: String(a.content || '') };
      } catch {
        /* partial line */
      }
    }
    for (const line of linesWith(text, '"name":"Skill"')) {
      try {
        const e = JSON.parse(line);
        if (tsOf(e) && tsOf(e) < since) continue;
        for (const b of Array.isArray(e.message?.content) ? e.message.content : []) {
          if (b?.type === 'tool_use' && b.name === 'Skill' && typeof b.input?.skill === 'string') used[b.input.skill.replace(/^\//, '')] = (used[b.input.skill.replace(/^\//, '')] || 0) + 1;
        }
      } catch {
        /* partial line */
      }
    }
    // Slash commands the user typed (`/name args`) show up as <command-name>/name</command-name>.
    for (const m of text.matchAll(/<command-name>\/?([\w:.-]+)<\/command-name>/g)) used[m[1]] = (used[m[1]] || 0) + 1;
  }

  const state = loadSlimState();
  const settings = readJson<any>(settingsFile());
  const overrides: Record<string, string> = settings.ok && settings.value?.skillOverrides && typeof settings.value.skillOverrides === 'object' ? settings.value.skillOverrides : {};
  const isUsed = (name: string) => !!(used[name] || used[name.slice(name.lastIndexOf(':') + 1)]);

  const chars: Record<string, number> = {};
  for (const line of (latest?.content || '').split('\n')) {
    const m = /^- ([^:\s]+(?::[^:\s]+)*):/.exec(line);
    if (m) chars[m[1]] = line.length - m[1].length - 2; // the description part; the name stays
  }
  const hide: SlimPlan['hide'] = [];
  for (const name of latest?.names || []) {
    if (!name.includes(':') || isUsed(name)) continue; // plugin skills only, never one in use
    if (overrides[name] !== undefined) continue; // the user's own override, or already hidden by grug
    if ((firstSeen[name] ?? 0) > Date.now() - minObserved * 864e5) continue; // too new to judge
    hide.push({ name, chars: chars[name] || 0 });
  }
  const unhide = state.hidden.filter((n) => isUsed(n) && overrides[n] === SLIM_MODE);
  const observedDays = Math.max(0, Math.floor((Date.now() - oldest) / 864e5));
  return {
    days,
    observedDays,
    transcripts: files.length,
    listed: latest?.names.length || 0,
    listingChars: latest?.content.length || 0,
    used,
    hide: observedDays >= minObserved ? hide : [],
    unhide,
    alreadyHidden: state.hidden.filter((n) => overrides[n] === SLIM_MODE && !unhide.includes(n)).length,
    savedTokens: Math.round(hide.reduce((s, h) => s + h.chars, 0) / 4)
  };
}

function writeOverrides(change: (o: Record<string, string>) => void): { ok: boolean; message: string } {
  const file = settingsFile();
  const r = readJson<any>(file);
  if (!r.ok && r.exists) return { ok: false, message: `${file} is not valid JSON (${r.error}); nothing changed.` };
  const value = r.ok && r.value ? r.value : {};
  const o: Record<string, string> = value.skillOverrides && typeof value.skillOverrides === 'object' ? { ...value.skillOverrides } : {};
  change(o);
  if (Object.keys(o).length) value.skillOverrides = o;
  else delete value.skillOverrides;
  const bak = backupFile(file);
  writeJsonAtomic(file, value);
  return { ok: true, message: `Updated ${file}${bak ? ` (backup: ${path.basename(bak)})` : ''}. New sessions use it.` };
}

/** Hide the planned skills and show again the ones used since. */
export function applySlim(plan: SlimPlan): { ok: boolean; message: string } {
  const state = loadSlimState();
  const hidden = new Set(state.hidden.filter((n) => !plan.unhide.includes(n)));
  const res = writeOverrides((o) => {
    for (const n of plan.unhide) if (o[n] === SLIM_MODE) delete o[n];
    for (const h of plan.hide) {
      o[h.name] = SLIM_MODE;
      hidden.add(h.name);
    }
  });
  if (res.ok) saveSlimState({ hidden: [...hidden] });
  return res;
}

/** Drop grug's overrides from an already-open settings object (uninstall writes it). */
export function stripSlimOverrides(settings: any): number {
  const state = loadSlimState();
  const o = settings?.skillOverrides;
  let n = 0;
  if (o && typeof o === 'object')
    for (const name of state.hidden)
      if (o[name] === SLIM_MODE) {
        delete o[name];
        n++;
      }
  if (o && typeof o === 'object' && !Object.keys(o).length) delete settings.skillOverrides;
  if (state.hidden.length) saveSlimState({ hidden: [] });
  return n;
}

/** Remove every override grug added (left alone if the user changed it since). */
export function undoSlim(): { ok: boolean; message: string; restored: number } {
  const state = loadSlimState();
  if (!state.hidden.length) return { ok: true, message: 'Nothing to undo.', restored: 0 };
  let restored = 0;
  const res = writeOverrides((o) => {
    for (const n of state.hidden)
      if (o[n] === SLIM_MODE) {
        delete o[n];
        restored++;
      }
  });
  if (res.ok) saveSlimState({ hidden: [] });
  return { ...res, restored };
}
