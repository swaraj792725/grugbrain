/**
 * Graph-first hints at the moment Claude is about to search or read:
 *  - Grep for a symbol the code graph knows -> tell it where the symbol lives (path + line range).
 *    Never blocks: the hint rides along with the search, so the next step is a ranged read.
 *  - Read of a mid-size code file in full -> once, point at the outline (a fraction of the tokens),
 *    then a ranged Read (which is also what Edit needs). Repeating the same Read goes through.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { GrugConfig } from './config.js';
import { languageOf, skeletonize } from './compress/skeleton.js';
import { loadGraphIndex, overlayFresh } from './graph.js';
import { findSymbol } from './mcp.js';
import { BufferEvent, appendBuffer, readBuffer } from './memory/store.js';
import { recordActivity } from './stats.js';

type HookOutput = Record<string, any> | null;

interface NavInput {
  tool_name?: string;
  tool_input?: any;
}

function epoch(events: BufferEvent[]): BufferEvent[] {
  let i = events.length - 1;
  while (i >= 0 && events[i].t !== 'compact') i--;
  return events.slice(i + 1);
}

const bare = (sym: string) => sym.replace(/\(\)$/, '').replace(/^(class|interface|type|enum|struct|trait|record)\s+/, '');

/** The identifier a Grep pattern is looking for, when it is just one ("foo", "\bfoo\b", "function foo"). */
export function grepSymbol(pattern: unknown): string | null {
  if (typeof pattern !== 'string') return null;
  const p = pattern.trim().replace(/\\?\(.*$/, '').replace(/^\\b|\\b$/g, '').replace(/^\^|\$$/g, '');
  const m = /^(?:(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait)\s+)?([A-Za-z_$][\w$]{3,})$/.exec(p);
  return m ? m[1] : null;
}

export function navPreTool(cfg: GrugConfig, input: NavInput, sid: string, cwd: string, now: number): HookOutput {
  const gc = cfg.graphContext;
  if (!gc.enabled || !gc.hints) return null;
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const proj = path.basename(cwd);

  if (tool === 'Grep') {
    const name = grepSymbol(ti.pattern);
    if (!name) return null;
    const index = loadGraphIndex(cwd);
    if (!index) return null;
    const ev = epoch(readBuffer(sid));
    const key = `grep|${name}`;
    if (ev.some((e) => e.t === 'nav' && e.key === key)) return null;
    const edited = ev.filter((e) => e.t === 'file' && e.op === 'edit').map((e: any) => path.relative(path.resolve(cwd), e.path));
    const idx = overlayFresh(index, edited.filter((f) => f && !f.startsWith('..')));
    const where: string[] = [];
    const files: string[] = [];
    for (const f of idx.files) {
      if (where.length >= 3) break;
      if (!f.symbols.some((s) => bare(s) === name)) continue;
      let range = '';
      try {
        const hit = f.bytes <= 512 * 1024 ? findSymbol(fs.readFileSync(path.join(idx.root, f.rel), 'utf8'), f.rel, name) : null;
        if (hit) range = ` L${hit.start}-${hit.end}`;
        else continue; // renamed since the scan
      } catch {
        continue;
      }
      where.push(`${f.rel}${range}`);
      files.push(f.rel);
    }
    if (!where.length) return null;
    appendBuffer(sid, { t: 'nav', ts: now, key, files });
    recordActivity({ kind: 'nav', msg: `Told Claude where ${name} lives (${where[0]}) before its search`, project: proj });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: `[grugbrain graph: \`${name}\` is defined at ${where.join(', ')}. Read just that range with offset/limit instead of the whole file.]`
      }
    };
  }

  if (tool === 'Read' && gc.readHintBytes > 0 && typeof ti.file_path === 'string' && ti.offset === undefined && ti.limit === undefined) {
    const file = ti.file_path;
    if (!languageOf(file)) return null;
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (st.size < gc.readHintBytes || st.size > cfg.readGuard.maxBytes) return null; // larger ones have the read guard
    const ev = epoch(readBuffer(sid));
    const abs = path.resolve(file);
    const key = `read|${abs}`;
    if (ev.some((e) => e.t === 'nav' && e.key === key)) return null; // asked once already: repeat goes through
    if (ev.some((e) => e.t === 'file' && path.resolve(e.path) === abs)) return null; // being worked on: it needs the real thing
    let code = '';
    try {
      code = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    const sk = skeletonize(code, file);
    if (sk.language === 'unknown' || sk.originalTokens < 2500 || sk.skeletonTokens > sk.originalTokens * 0.45) return null;
    appendBuffer(sid, { t: 'nav', ts: now, key, files: [path.relative(path.resolve(cwd), abs)] });
    recordActivity({ kind: 'nav', msg: `Suggested outline before a full read of ${path.basename(file)} (~${sk.originalTokens} tok, outline ~${sk.skeletonTokens})`, project: proj });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `grugbrain: ${path.basename(file)} is ~${sk.originalTokens} tokens; its outline is only ~${sk.skeletonTokens} (grugbrain outline tool, if you need the overview). ` +
          `Otherwise Grep for the symbol you need (or use the line ranges already in your context), then Read with offset/limit for just that part (that also satisfies Edit). ` +
          `To read the whole file anyway, repeat the same Read and it will be allowed.`
      }
    };
  }
  return null;
}
