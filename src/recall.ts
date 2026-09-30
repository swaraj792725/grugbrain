/**
 * Auto-recall (UserPromptSubmit): before Claude answers, add the few things grug already knows
 * that clearly match the prompt: memory notes first, then code locations from the graph, then
 * excerpts of earlier conversations. Hard token cap, relevance gate, never the same excerpt twice
 * in a session. Nothing matches clearly → nothing is added.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { GrugConfig, paths } from './config.js';
import { BufferEvent, loadMemory, MemNode, projectKey, projectNodes, readBuffer, score, similarity } from './memory/store.js';
import { excerpt, historyHits, ago } from './history.js';
import { relevantCode } from './graph.js';
import { loadTune } from './recalltune.js';
import { isRelevant, isTrivialPrompt, promptSegments, queryTerms, rankPrompt } from './relevance.js';
import { estimateTokens } from './tokens.js';

export const RECALL_HEADER = '[grugbrain recall: possibly relevant notes from memory/earlier sessions; verify before relying]';

export interface AutoRecall {
  text: string;
  tokens: number;
  /** Memory node ids injected (also tracked as 'injected' so briefs/recalls never repeat them). */
  ids: string[];
  /** Every dedupe key injected (memory ids, h:<hash> excerpts, g:<file>#<symbol>). */
  keys: string[];
  counts: { memory: number; code: number; history: number };
  codeTokens: number;
  /** Repo-relative files hinted (used to score whether the hints helped). */
  files: string[];
}

function hashKey(s: string): string {
  return 'h:' + createHash('sha1').update(s.replace(/\s+/g, ' ').trim().slice(0, 160).toLowerCase()).digest('hex').slice(0, 12);
}

/** Keys already put into this session's context (since its last compaction). */
export function injectedKeys(events: BufferEvent[]): { keys: Set<string>; lastCompact: number; spent: number; edited: string[] } {
  let keys = new Set<string>();
  let lastCompact = 0;
  let spent = 0; // recall tokens sitting in the current context
  const edited: string[] = [];
  for (const ev of events) {
    if (ev.t === 'compact') {
      keys = new Set();
      lastCompact = ev.ts;
      spent = 0;
    } else if (ev.t === 'injected') ev.ids.forEach((i) => keys.add(i));
    else if (ev.t === 'recall') {
      ev.keys.forEach((k) => keys.add(k));
      spent += ev.tokens || 0;
    } else if (ev.t === 'file' && ev.op === 'edit') edited.push(ev.path);
  }
  return { keys, lastCompact, spent, edited };
}

function memoryText(n: MemNode): string {
  if (n.type === 'session') return `${n.label} ${(n.data?.prompts || []).join(' ')} ${n.data?.outcome || ''}`;
  if (n.type === 'digest') return `${n.label} ${(n.data?.highlights || []).join(' ')}`;
  return n.label;
}

function memoryLine(n: MemNode, now: number): string {
  const clip = (s: string, k: number) => (s.length > k ? s.slice(0, k - 1) + '…' : s);
  if (n.type === 'note') return `- ${n.data?.pinned ? 'pinned: ' : ''}${clip(n.label, 300)}`;
  if (n.type === 'session') return `- session ${ago(n.updated)} "${clip(n.label, 90)}"${n.data?.outcome ? ` → ${clip(n.data.outcome, 180)}` : ''}`;
  return `- ${n.label}: ${clip((n.data?.highlights || []).slice(0, 3).join('; '), 200)}`;
}

export function autoRecall(opts: {
  cfg: GrugConfig;
  sessionId: string;
  cwd: string;
  prompt: string;
  transcriptPath?: string;
  now?: number;
  historyBudgetMs?: number;
  /** A subagent's fresh context: nothing injected yet, no session budget, the cap is `maxTokens`. */
  isolated?: boolean;
  maxTokens?: number;
}): AutoRecall | null {
  const { cfg, cwd, prompt } = opts;
  const now = opts.now ?? Date.now();
  if (isTrivialPrompt(prompt)) return null;
  const terms = queryTerms(prompt);
  if (terms.length < 2) return null;
  const { keys: seen, lastCompact, spent, edited } = opts.isolated ? { keys: new Set<string>(), lastCompact: 0, spent: 0, edited: [] as string[] } : injectedKeys(readBuffer(opts.sessionId));
  // Everything injected stays in context and is re-read every reply, so the session as a whole
  // has a budget: what is left caps this block, and the relevance bar rises as it fills.
  const remaining = cfg.autoRecall.sessionTokens - spent;
  if (remaining < 120 && !opts.isolated) return null;
  const max = opts.isolated ? opts.maxTokens ?? cfg.autoRecall.subagentTokens : Math.min(cfg.autoRecall.maxTokens, remaining);
  const bar = 1 + 0.5 * Math.min(1, spent / Math.max(1, cfg.autoRecall.sessionTokens));
  const strict = loadTune().strictness * bar;
  const share = Math.min(0.9, 0.34 * bar);
  const root = path.resolve(cwd);
  const fresh = edited.map((f) => (path.isAbsolute(f) ? path.relative(root, f) : f)).filter((f) => f && !f.startsWith('..'));
  const promptLower = prompt.toLowerCase();

  const sections: { memory: string[]; code: string[]; history: string[] } = { memory: [], code: [], history: [] };
  const ids: string[] = [];
  const keys: string[] = [];
  let used = estimateTokens(RECALL_HEADER) + 12; // header + section titles
  const fits = (line: string, cap: number, sectionUsed: number) => {
    const t = estimateTokens(line) + 1;
    return used + t <= max && sectionUsed + t <= cap ? t : 0;
  };

  // 1. Memory: notes (decisions, causes, preferences, pinned) rank above sessions and digests.
  let memTok = 0;
  const memTexts: string[] = [];
  if (cfg.memory.enabled) {
    const db = loadMemory();
    const project = projectKey(cwd);
    const global = projectKey(path.join(paths.home(), 'global'));
    const nodes = [...projectNodes(db, project), ...(global !== project ? projectNodes(db, global).filter((n) => n.type === 'note') : [])].filter(
      (n) => n.type === 'note' || n.type === 'session' || n.type === 'digest'
    );
    const weights = nodes.map((n) => {
      const base = n.type === 'note' ? (n.data?.pinned ? 2.2 : n.data?.kind === 'preference' ? 2 : 1.8) : n.type === 'session' ? 1 : 0.8;
      return base * (0.7 + 0.3 * Math.min(1, score(n, cfg.memory.halfLifeDays, now) / 3));
    });
    const ranked = rankPrompt(nodes.map((n) => memoryText(n).toLowerCase()), prompt, weights);
    for (const r of ranked) {
      const n = nodes[r.index];
      if (seen.has(n.id) || !isRelevant(r, r.nTerms, (n.type === 'note' ? 0.35 : 0.45) * bar, share)) continue;
      if (sections.memory.length >= 4) break;
      const line = memoryLine(n, now);
      const t = fits(line, Math.round(max * 0.45), memTok);
      if (!t) continue;
      sections.memory.push(line);
      memTexts.push(n.label);
      ids.push(n.id);
      keys.push(n.id);
      used += t;
      memTok += t;
    }
  }

  // 2. Code graph: where the prompt's names live (paths + line ranges, never bodies).
  let codeTok = 0;
  const files: string[] = [];
  if (cfg.graphContext.enabled) {
    try {
      const hinted = new Set<string>();
      for (const seg of promptSegments(prompt)) {
        for (const h of relevantCode(cwd, seg, promptLower, 4, seen, { fresh, strictness: strict })) {
          if (hinted.has(h.file) || hinted.size >= 4) continue;
          const t = fits(h.line, Math.round(max * 0.25), codeTok);
          if (!t) continue;
          hinted.add(h.file);
          sections.code.push(h.line);
          keys.push(...h.keys);
          files.push(h.file);
          used += t;
          codeTok += t;
        }
      }
    } catch {
      /* graph is optional */
    }
  }

  // 3. Earlier conversations: user asks and decisions first, then the rest; never the current context.
  let histTok = 0;
  try {
    const { hits } = historyHits(cwd, prompt, {
      budgetMs: opts.historyBudgetMs ?? 80,
      excludeFile: opts.transcriptPath,
      excludeFileBefore: lastCompact || undefined
    });
    const shown: string[] = [];
    for (const h of hits.slice(0, 60)) {
      if (sections.history.length >= 3) break;
      if (!isRelevant(h, h.nTerms, Math.min(0.95, 0.5 * strict), share)) continue;
      if (h.item.who.startsWith('Claude →')) continue; // raw tool calls rarely help
      if (similarity(h.item.text.slice(0, 400), prompt) >= 0.7) continue; // the same question asked before
      const ex = excerpt(h, 320);
      const key = hashKey(ex);
      if (seen.has(key) || keys.includes(key)) continue;
      if ([...memTexts, ...shown].some((m) => similarity(m, ex) >= 0.5)) continue;
      const line = `- ${ago(h.item.ts)} · ${h.item.who}: ${ex}`;
      const t = fits(line, max, histTok);
      if (!t) continue;
      sections.history.push(line);
      shown.push(ex);
      keys.push(key);
      used += t;
      histTok += t;
    }
  } catch {
    /* history is optional */
  }

  const counts = { memory: sections.memory.length, code: sections.code.length, history: sections.history.length };
  if (!counts.memory && !counts.code && !counts.history) return null;
  const out = [RECALL_HEADER];
  if (counts.memory) out.push('Memory:', ...sections.memory);
  if (counts.code) out.push('Code (from the repo graph; Read just these line ranges with offset/limit):', ...sections.code);
  if (counts.history) out.push('Earlier sessions:', ...sections.history);
  // Estimates are not exactly additive: enforce the hard cap on the final block.
  while (out.length > 2 && estimateTokens(out.join('\n')) > max) out.pop();
  if (/:$/.test(out[out.length - 1])) out.pop();
  const text = out.join('\n');
  return { text, tokens: estimateTokens(text), ids, keys, counts, codeTokens: codeTok, files };
}
