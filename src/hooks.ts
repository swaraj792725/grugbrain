/**
 * Claude Code hook handlers: `grug hook <event>` reads the event JSON on stdin.
 * Every handler is fail-safe: any error -> exit 0 with no output, so Claude Code is never blocked.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { loadConfig, paths } from './config.js';
import { terseStyle } from './compress/caveman.js';
import { trimToolOutput } from './compress/trim.js';
import { summarizeTestOutput } from './compress/testsum.js';
import { buildBrief, recall } from './memory/brief.js';
import { withMemoryLock } from './memory/maintain.js';
import { addNote, appendBuffer, BufferEvent, loadMemory, projectKey, readBuffer, saveMemory } from './memory/store.js';
import { recordActivity } from './stats.js';
import { estimateTokens } from './tokens.js';
import { cachedUpdate } from './update.js';
import { meterTranscript } from './meter.js';
import { buildHandoff, coldCacheCost, contextSize, costPerReply, saveHandoff, takeHandoff } from './handoff.js';
import { autoRecall } from './recall.js';
import { isCodeProject, refreshGraphSoon, sessionCodeMap } from './graph.js';
import { scanFacts } from './facts.js';
import { imageAlert, mediaPostTool, mediaPreTool } from './mediaguard.js';
import { navPreTool } from './navhint.js';
import { scoreAdoption } from './adoption.js';
import { analyzeTranscript, topConsumers } from './ctxbreak.js';
import { looksLikeNewTask } from './taskshift.js';
import { scoreRecalls } from './recalltune.js';

export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  tool_output?: any;
  reason?: string;
  agent_id?: string;
  scratchpad_dir?: string;
}

type HookOutput = Record<string, any> | null;

const TEXT_READ_SKIP = /\.(png|jpe?g|gif|webp|pdf|ipynb|svg|ico|bmp|tiff?)$/i;

export async function runHook(event: string, input: HookInput): Promise<HookOutput> {
  // A/B switch used by `grug bench` (and handy for debugging): hooks become no-ops.
  if (process.env.GRUG_DISABLE === '1') return null;
  if (process.env.GRUG_DEBUG === '1') {
    try {
      fs.mkdirSync(paths.logs(), { recursive: true });
      // Keep each line valid JSON: shorten big string fields instead of cutting the JSON.
      const clip = (v: any): any =>
        typeof v === 'string' ? (v.length > 2000 ? v.slice(0, 2000) + `…(+${v.length - 2000})` : v) : Array.isArray(v) ? v.slice(0, 50).map(clip) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clip(x)])) : v;
      fs.appendFileSync(path.join(paths.logs(), 'hook-input.jsonl'), JSON.stringify({ event, input: clip(input) }) + '\n');
    } catch {
      /* ignore */
    }
  }
  const cfg = loadConfig();
  const sid = input.session_id || 'unknown';
  const cwd = input.cwd || process.cwd();
  const now = Date.now();

  switch (event) {
    case 'session-start': {
      appendBuffer(sid, { t: 'start', ts: now, cwd, source: input.source });
      // After compaction/resume/clear, earlier file reads are no longer in context.
      if (input.source && input.source !== 'startup') appendBuffer(sid, { t: 'compact', ts: now });
      ensureDaemon();
      const parts: string[] = [];
      const style = terseStyle(cfg.terse);
      if (style) parts.push(style);
      let handedOff = false;
      if (cfg.handoff.enabled) {
        const h = takeHandoff(projectKey(cwd), sid, cfg.handoff.maxAgeHours, input.source === 'compact');
        if (h) {
          parts.push(h.text);
          handedOff = true;
          const tok = estimateTokens(h.text);
          recordActivity({
            kind: 'handoff',
            msg:
              input.source === 'compact'
                ? `Restored work after auto-compaction (${Math.round(h.contextTokens / 1000)}k-token context) with a ${tok}-token handoff`
                : `Continued from a ${Math.round(h.contextTokens / 1000)}k-token session with a ${tok}-token handoff`,
            tokens: Math.max(0, h.contextTokens - tok),
            project: path.basename(cwd)
          });
        }
      }
      let hotFiles: string[] = [];
      if (cfg.memory.enabled) {
        const db = loadMemory();
        const brief = buildBrief(db, projectKey(cwd), handedOff ? Math.round(cfg.memory.briefTokens / 2) : cfg.memory.briefTokens, cfg.memory.halfLifeDays);
        if (brief.text) {
          parts.push(brief.text);
          appendBuffer(sid, { t: 'injected', ts: now, ids: brief.ids });
          recordActivity({ kind: 'brief', msg: `Session brief injected (${brief.tokens} tok) for ${path.basename(cwd)}`, tokens: -brief.tokens, project: path.basename(cwd) });
        }
        hotFiles = hotFilesOf(db, projectKey(cwd));
      }
      let warm = cfg.autoRecall.enabled;
      if (cfg.graphContext.enabled) {
        try {
          const map = sessionCodeMap(cwd, cfg.graphContext.mapTokens, hotFiles);
          if (map) {
            parts.push(map.text);
            warm = warm || map.stale;
            recordActivity({
              kind: 'graph',
              msg: map.files ? `Code map injected (${map.tokens} tok, ${map.files} files) + graph-first tool guidance` : 'Graph-first tool guidance injected (map still building)',
              tokens: -map.tokens,
              project: path.basename(cwd)
            });
          }
        } catch {
          /* graph context is optional */
        }
      }
      // Refresh the code graph + history caches in the background so prompts stay fast.
      if (warm) spawnDetached(['warm', cwd]);
      // Shown to the user only (not sent to Claude, costs no tokens).
      const upd = cachedUpdate();
      const systemMessage = upd?.newer ? `🪨 grugbrain ${upd.latest} is available (you have ${upd.current}). Run in a terminal: grug update` : undefined;
      if (!parts.length) return systemMessage ? { systemMessage } : null;
      return { ...(systemMessage ? { systemMessage } : {}), hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: parts.join('\n\n') } };
    }

    case 'user-prompt': {
      const prompt = input.prompt || '';
      const priorEvents = cfg.taskBoundary.enabled ? readBuffer(sid) : [];
      appendBuffer(sid, { t: 'prompt', ts: now, text: prompt.slice(0, 2000) });
      const alert =
        [
          contextAlert(cfg, sid, cwd, input.transcript_path, now),
          idleAlert(cfg, sid, cwd, input.transcript_path, now),
          imageAlert(cfg, sid, input.transcript_path ? contextSize(input.transcript_path).model : '', now),
          taskShiftNotice(cfg, sid, cwd, input.transcript_path, prompt, priorEvents, now)
        ]
          .filter(Boolean)
          .join('\n') || undefined;
      const done = (extra?: HookOutput): HookOutput => (alert || extra ? { ...(alert ? { systemMessage: alert } : {}), ...(extra || {}) } : null);
      const project = projectKey(cwd);
      if (cfg.memory.enabled) {
        const m = prompt.match(/^\s*(?:remember|grug remember)\s*[:,-]?\s+(.{8,400})/i);
        if (m) {
          withMemoryLock(() => {
            const db = loadMemory();
            addNote(db, project, m[1].trim(), now, { pinned: true });
            saveMemory(db);
          });
          recordActivity({ kind: 'remember', msg: `Pinned note: ${m[1].slice(0, 80)}`, project: path.basename(cwd) });
          return done(); // don't recall the note we just wrote
        }
      }
      if (cfg.autoRecall.enabled) {
        const r = autoRecall({ cfg, sessionId: sid, cwd, prompt, transcriptPath: input.transcript_path, now });
        if (!r) return done();
        if (r.ids.length) appendBuffer(sid, { t: 'injected', ts: now, ids: r.ids });
        appendBuffer(sid, { t: 'recall', ts: now, keys: r.keys, tokens: r.tokens, files: r.files });
        const recallTok = r.tokens - r.codeTokens;
        if (r.counts.memory || r.counts.history)
          recordActivity({
            kind: 'auto-recall',
            msg: `Auto-recall: ${r.counts.memory} memory, ${r.counts.history} earlier-session item(s) (${r.tokens} tok)`,
            tokens: -recallTok,
            project: path.basename(cwd)
          });
        if (r.counts.code) recordActivity({ kind: 'graph', msg: `Code hints for the prompt: ${r.counts.code} file(s) with symbol line ranges`, tokens: -r.codeTokens, project: path.basename(cwd) });
        return done({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.text } });
      }
      if (!cfg.memory.enabled || prompt.trim().length < 12) return done();
      const exclude = new Set<string>();
      for (const ev of readBuffer(sid)) if (ev.t === 'injected') ev.ids.forEach((i) => exclude.add(i));
      const r = recall(loadMemory(), project, prompt, cfg.memory.recallTokens, cfg.memory.halfLifeDays, exclude);
      if (!r.text) return done();
      appendBuffer(sid, { t: 'injected', ts: now, ids: r.ids });
      recordActivity({ kind: 'recall', msg: `Recalled ${r.ids.length} related memory item(s)`, tokens: -r.tokens, project: path.basename(cwd) });
      return done({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: r.text } });
    }

    case 'pre-tool': {
      // Screenshots, images, PDFs, video: skip repeats, shrink, or point at the cheaper way in.
      const media = mediaPreTool(cfg, input, sid, cwd, now, readKey);
      if (media) return media;
      const nav = navPreTool(cfg, input, sid, cwd, now);
      if (nav) return nav;
      if (input.tool_name !== 'Read') return null;
      const ti = input.tool_input || {};
      const file: string | undefined = ti.file_path;
      if (!file || TEXT_READ_SKIP.test(file)) return null;
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        return null;
      }

      // Re-read guard: same file, same range, unchanged, still in context -> skip once.
      if (cfg.rereadGuard.enabled) {
        const key = readKey(file, ti, input.agent_id);
        const events = readBuffer(sid);
        let lastRead: Extract<BufferEvent, { t: 'read' }> | undefined;
        let invalidated = false;
        let skipped = false;
        for (const ev of events) {
          if (ev.t === 'compact') {
            lastRead = undefined;
            invalidated = false;
            skipped = false;
          } else if (ev.t === 'read' && ev.key === key) {
            lastRead = ev;
            invalidated = false;
            skipped = false;
          } else if (ev.t === 'file' && ev.op === 'edit' && path.resolve(ev.path) === path.resolve(file)) invalidated = true;
          else if (ev.t === 'skip' && ev.key === key) skipped = true;
        }
        const fresh = lastRead && now - lastRead.ts < cfg.rereadGuard.windowMinutes * 60000;
        if (lastRead && fresh && !invalidated && !skipped && lastRead.mtime === st.mtimeMs && lastRead.size === st.size) {
          appendBuffer(sid, { t: 'skip', ts: now, key });
          const est = estimateTokens('x'.repeat(Math.min(st.size, 200_000)));
          recordActivity({ kind: 'reread', msg: `Skipped unchanged re-read of ${path.basename(file)}`, tokens: est, project: path.basename(cwd) });
          const mins = Math.max(1, Math.round((now - lastRead.ts) / 60000));
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason:
                `grugbrain: ${path.basename(file)} is unchanged since you read ${ti.offset || ti.limit ? 'this same range' : 'it'} ${mins} min ago, ` +
                `so its content is already in your context above. Use that. ` +
                `If it is no longer visible to you (e.g. context was cleared), repeat the same Read and it will be allowed.`
            }
          };
        }
      }

      // Read guard: huge full-file reads -> find first, then read a range.
      if (!cfg.readGuard.enabled || ti.offset !== undefined || ti.limit !== undefined) return null;
      const size = st.size;
      if (size <= cfg.readGuard.maxBytes) return null;
      // Claude Code reads up to 2000 lines by default; estimate what that would have cost.
      let wouldRead = size;
      let totalLines = 0;
      try {
        const text = fs.readFileSync(file, 'utf8');
        const lines = text.split('\n');
        totalLines = lines.length;
        wouldRead = lines.slice(0, 2000).join('\n').length;
      } catch {
        /* keep size */
      }
      const est = estimateTokens('x'.repeat(Math.min(wouldRead, 2_000_000)));
      recordActivity({ kind: 'read-guard', msg: `Redirected full read of ${path.basename(file)} (${Math.round(size / 1024)} KB)`, tokens: Math.max(0, est - 600), project: path.basename(cwd) });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `grugbrain: ${path.basename(file)} is ${Math.round(size / 1024)} KB / ${totalLines || '?'} lines (~${est} tokens for a full read). ` +
            `Find what you need first (Grep, or the grugbrain outline tool), then Read with offset/limit. ` +
            `A ranged Read is always allowed.`
        }
      };
    }

    case 'post-tool': {
      const ti = input.tool_input || {};
      const tool = input.tool_name || '';
      const mediaOut = mediaPostTool(cfg, input, sid, now);
      const useKind = tool === 'Read' ? 'read' : tool === 'Grep' ? 'grep' : tool === 'Glob' ? 'glob' : /^mcp__grugbrain__/.test(tool) ? 'grug' : null;
      if (useKind) appendBuffer(sid, { t: 'use', ts: now, k: useKind });
      if (ti.file_path && /^(Read|Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
        appendBuffer(sid, { t: 'file', ts: now, path: ti.file_path, op: tool === 'Read' ? 'read' : 'edit', ...(tool === 'Read' && (ti.offset !== undefined || ti.limit !== undefined) ? { ranged: true } : {}) });
        if (tool === 'Read') {
          try {
            const st = fs.statSync(ti.file_path);
            appendBuffer(sid, { t: 'read', ts: now, path: ti.file_path, key: readKey(ti.file_path, ti, input.agent_id), mtime: st.mtimeMs, size: st.size });
          } catch {
            /* file vanished */
          }
        }
        if (cfg.graphContext.enabled && tool !== 'Read' && isCodeProject(cwd) && path.resolve(ti.file_path).startsWith(path.resolve(cwd) + path.sep)) {
          // Keep the code graph current: a debounced background rescan (prompts also overlay edited files at once).
          if (refreshGraphSoon(cwd, now)) spawnDetached(['warm', cwd, '--graph']);
        }
      } else if (ti.path && /grugbrain__(outline|read_symbol|read_lines)$/.test(tool)) {
        // Reading via grug's own tools counts as a file read (recall usefulness, handoff files).
        appendBuffer(sid, { t: 'file', ts: now, path: String(ti.path), op: 'read', ranged: true });
      } else if (tool === 'Bash' && ti.command) {
        appendBuffer(sid, { t: 'cmd', ts: now, cmd: String(ti.command).slice(0, 300) });
      }
      if (tool !== 'Bash' && tool !== 'Grep') return mediaOut;
      const original = toolOutputText(input);
      if (original === null) return null;
      let text = original;
      let kind: 'testsum' | 'trim' | null = null;
      if (cfg.testSummary.enabled && tool === 'Bash') {
        const s = summarizeTestOutput(text, cfg.testSummary.minChars);
        if (s.changed) {
          text = s.text;
          kind = 'testsum';
        }
      }
      if (cfg.proxy.trimToolResults) {
        const r = trimToolOutput(text, {
          // Content Claude asked to see (cat, sed -n, grep, git diff...) keeps the generous limit; only noisy runs are cut early.
          thresholdChars: wantsContent(String(ti.command || '')) ? Math.max(cfg.proxy.trimThresholdChars, cfg.proxy.trimContentChars) : cfg.proxy.trimThresholdChars,
          keepHeadChars: cfg.proxy.trimKeepHeadChars,
          keepTailChars: cfg.proxy.trimKeepTailChars,
          saveFull: (full) => saveFullOutput(full, input.scratchpad_dir)
        });
        if (r.changed) {
          text = r.text;
          kind = kind || 'trim';
        }
      }
      const removed = original.length - text.length;
      if (!kind || removed < 200) return null;
      recordActivity({
        kind,
        msg: kind === 'testsum' ? `Summarized test/build output (${Math.round((removed / original.length) * 100)}% smaller)` : `Trimmed ${tool} output at source`,
        tokens: Math.round(removed / 3.6),
        project: path.basename(cwd)
      });
      // Reply in the same shape the tool produced (Bash gives {stdout, stderr, ...}).
      const r = input.tool_response;
      const updated = r && typeof r === 'object' && typeof r.stdout === 'string' ? { ...r, stdout: text, stderr: '' } : text;
      return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: updated } };
    }

    case 'stop': {
      try {
        meterTranscript(sid, input.transcript_path, path.basename(cwd));
      } catch {
        /* metering is best-effort */
      }
      const text = lastAssistantText(input.transcript_path);
      if (text) appendBuffer(sid, { t: 'assistant', ts: now, text: text.slice(0, 4000) });
      // Pick durable facts as the session goes (only new bytes), so a long session loses none to the tail window.
      if (cfg.memory.enabled) captureFacts(sid, input.transcript_path, cwd, now, false);
      return null;
    }

    case 'session-end':
    case 'pre-compact': {
      try {
        meterTranscript(sid, input.transcript_path, path.basename(cwd));
      } catch {
        /* best-effort */
      }
      const text = lastAssistantText(input.transcript_path);
      if (text) appendBuffer(sid, { t: 'assistant', ts: now, text: text.slice(0, 4000) });
      if (cfg.handoff.enabled) {
        try {
          const prompts = readBuffer(sid).filter((e) => e.t === 'prompt').length;
          // /clear, compaction, or a real session ending: leave a handoff for the next one.
          if (event === 'pre-compact' || input.reason === 'clear' || prompts >= 2) {
            const h = buildHandoff(sid, input.transcript_path, cwd, cfg.handoff.maxTokens);
            if (h) saveHandoff(h);
          }
        } catch {
          /* best-effort */
        }
      }
      if (cfg.memory.enabled) captureFacts(sid, input.transcript_path, cwd, now, true);
      try {
        scoreRecalls(sid, cwd);
        scoreAdoption(sid, cwd);
      } catch {
        /* best-effort */
      }
      if (event === 'session-end') appendBuffer(sid, { t: 'end', ts: now, reason: input.reason });
      else appendBuffer(sid, { t: 'compact', ts: now });
      spawnDetached(['maintain']);
      return null;
    }
  }
  return null;
}

const MIN_SCAN_BYTES = 24 * 1024;
const MAX_FACTS_PER_SESSION = 30;

/**
 * Durable facts from the transcript bytes not seen yet. At Stop it runs only once enough new
 * transcript has piled up; at PreCompact/SessionEnd (`force`) it always runs. Facts are appended
 * to the session buffer and become notes when the session is ingested.
 */
function captureFacts(sid: string, transcript: string | undefined, cwd: string, now: number, force: boolean): void {
  if (!transcript) return;
  try {
    let offset = 0;
    let failed: string[] = [];
    let stored = 0;
    const known = new Set<string>();
    for (const e of readBuffer(sid)) {
      if (e.t === 'facts') {
        stored += e.items.length;
        e.items.forEach((f) => known.add(f.text));
        if (e.offset !== undefined) {
          offset = e.offset;
          failed = e.failed || failed;
        }
      } else if (e.t === 'factscan') {
        offset = e.offset;
        failed = e.failed;
      }
    }
    if (!force) {
      let size = 0;
      try {
        size = fs.statSync(transcript).size;
      } catch {
        return;
      }
      if (size >= offset && size - offset < MIN_SCAN_BYTES) return;
    }
    const scan = scanFacts(transcript, offset, failed, force ? 8 : 4);
    const room = Math.max(0, MAX_FACTS_PER_SESSION - stored);
    const fresh = scan.facts.filter((f) => !known.has(f.text)).slice(0, room);
    if (fresh.length) {
      appendBuffer(sid, { t: 'facts', ts: now, items: fresh, offset: scan.offset, failed: scan.failed });
      recordActivity({ kind: 'facts', msg: `Captured ${fresh.length} durable fact(s): ${[...new Set(fresh.map((f) => f.kind))].join(', ')}`, project: path.basename(cwd) });
    } else if (scan.offset !== offset) appendBuffer(sid, { t: 'factscan', ts: now, offset: scan.offset, failed: scan.failed });
  } catch {
    /* best-effort */
  }
}

/**
 * User-only notice: this prompt looks like a different job while the context is big. /clear is free
 * (memory and the code map come back at session start; recall fetches what is relevant), whereas
 * dragging the old context along is re-read on every reply.
 */
function taskShiftNotice(cfg: ReturnType<typeof loadConfig>, sid: string, cwd: string, transcript: string | undefined, prompt: string, prior: ReturnType<typeof readBuffer>, now: number): string | undefined {
  if (!cfg.taskBoundary.enabled || !transcript || !prior.length) return undefined;
  const { tokens, model } = contextSize(transcript);
  if (tokens < cfg.taskBoundary.minTokens) return undefined;
  const nPrompts = prior.filter((e) => e.t === 'prompt').length;
  const lastShift = prior.reduce((m, e) => (e.t === 'boundary' ? Math.max(m, e.prompts) : m), -99);
  if (nPrompts - lastShift < 8) return undefined; // not more than once per few prompts
  if (!looksLikeNewTask(prompt, prior)) return undefined;
  appendBuffer(sid, { t: 'boundary', ts: now, prompts: nPrompts });
  const per = costPerReply(tokens, model);
  recordActivity({ kind: 'task-shift', msg: `New task while the context was ${Math.round(tokens / 1000)}k tokens (~$${per.toFixed(2)}/reply): suggested /clear`, project: path.basename(cwd) });
  return (
    `🪨 grugbrain: this looks like a new task, and the current context is ${Math.round(tokens / 1000)}k tokens (~$${per.toFixed(2)} per reply, re-read every time). ` +
    `Type /clear to start it clean: grug's memory and code map come back at session start and relevant notes are recalled as you go. Ignore this if it continues the same work.`
  );
}

/**
 * User-only notice when the prompt cache has expired on a big session. Cache lifetime is 5 minutes
 * (1 hour when Claude Code writes the long tier); after that gap the next reply re-writes the whole
 * context at 1.25-2x the input price instead of reading it at 0.1x. If the user is switching tasks,
 * /clear plus grug's handoff (saved right here so it is ready) avoids that bill. Never sent to Claude.
 */
function idleAlert(cfg: ReturnType<typeof loadConfig>, sid: string, cwd: string, transcript: string | undefined, now: number): string | undefined {
  if (!cfg.idleAlert.enabled || !transcript) return undefined;
  const c = contextSize(transcript);
  if (!c.lastReplyTs || !c.tokens) return undefined;
  const ttlMs = (c.oneHourCache ? 60 : 5) * 60000;
  const idle = now - c.lastReplyTs;
  if (idle <= ttlMs) return undefined;
  const { cold, warm } = coldCacheCost(c.tokens, c.model, c.oneHourCache);
  if (cold - warm < cfg.idleAlert.minExtraUsd) return undefined;
  if (readBuffer(sid).some((e) => e.t === 'idle' && e.since === c.lastReplyTs)) return undefined; // once per gap
  appendBuffer(sid, { t: 'idle', ts: now, since: c.lastReplyTs });
  if (cfg.handoff.enabled) {
    try {
      const h = buildHandoff(sid, transcript, cwd, cfg.handoff.maxTokens);
      if (h) saveHandoff(h);
    } catch {
      /* best-effort */
    }
  }
  const mins = Math.round(idle / 60000);
  const when = mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`;
  recordActivity({ kind: 'idle-alert', msg: `Cache expired after ${when} idle at ${Math.round(c.tokens / 1000)}k tokens (this reply ~${fmtUsdShort(cold)} vs ~${fmtUsdShort(warm)} warm)`, project: path.basename(cwd) });
  return (
    `🪨 grugbrain: idle ${when}, so the prompt cache expired: this reply re-writes ~${Math.round(c.tokens / 1000)}k tokens (~${fmtUsdShort(cold)} instead of ~${fmtUsdShort(warm)}). ` +
    `Switching to something else? Type /clear first: grug hands the work to the fresh session (~1k tokens).`
  );
}

function fmtUsdShort(n: number): string {
  return n >= 10 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`;
}

/** One-line, user-only notice when the context passes 150k, 300k, 600k... tokens (once per level). */
function contextAlert(cfg: ReturnType<typeof loadConfig>, sid: string, cwd: string, transcript: string | undefined, now: number): string | undefined {
  if (!cfg.contextAlert.enabled || !transcript) return undefined;
  const { tokens, model } = contextSize(transcript);
  // With auto-compaction managed by grug there is nothing to do below ~1.2x the window.
  const win = cfg.autoCompact.windowTokens;
  const first = win > 0 ? Math.round(win * 1.2) : Math.max(10000, cfg.contextAlert.firstTokens);
  if (tokens < first) return undefined;
  const level = Math.floor(Math.log2(tokens / first)) + 1;
  const done = readBuffer(sid).filter((e) => e.t === 'alert').reduce((m, e: any) => Math.max(m, e.level || 0), 0);
  if (level <= done) return undefined;
  appendBuffer(sid, { t: 'alert', ts: now, level } as any);
  if (cfg.handoff.enabled) {
    try {
      const h = buildHandoff(sid, transcript, cwd, cfg.handoff.maxTokens);
      if (h) saveHandoff(h);
    } catch {
      /* best-effort */
    }
  }
  const per = costPerReply(tokens, model);
  let mostly = '';
  try {
    const top = topConsumers(analyzeTranscript(transcript));
    if (top) mostly = ` Mostly: ${top}.`;
  } catch {
    /* breakdown is optional */
  }
  recordActivity({ kind: 'context-alert', msg: `Context reached ${Math.round(tokens / 1000)}k tokens (~$${per.toFixed(2)}/reply)`, project: path.basename(cwd) });
  if (win > 0)
    return (
      `🪨 grugbrain: context is ${Math.round(tokens / 1000)}k tokens (~$${per.toFixed(2)}/reply) and Claude Code has not auto-compacted at ${Math.round(win / 1000)}k yet. ` +
      `Type /clear when this task is done: grug hands the work to the fresh session (~1k tokens).${mostly}`
    );
  return (
    `🪨 grugbrain: this session's context is ${Math.round(tokens / 1000)}k tokens, so every reply re-reads it (~$${per.toFixed(2)}/reply in API terms). ` +
    `When this task is done, type /clear: grug hands the work over to the fresh session (~1k tokens) at no cost.${mostly}`
  );
}

/** Files this project's past sessions touched most (memory graph), for ranking the code map. */
function hotFilesOf(db: ReturnType<typeof loadMemory>, project: string): string[] {
  return Object.values(db.nodes)
    .filter((n) => n.type === 'file' && n.project === project)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, 12)
    .map((n) => n.label);
}

function readKey(file: string, ti: any, agent?: string): string {
  return `${agent || 'main'}|${path.resolve(file)}|${ti.offset ?? ''}|${ti.limit ?? ''}|${ti.pages ?? ''}`;
}

/** Plain-text tool output from a PostToolUse payload (string, or Bash's {stdout, stderr}). */
/** True when the command's output is the point (file text, diffs, search hits, data), not build noise. */
export function wantsContent(cmd: string): boolean {
  const parts = cmd.split(/&&|\|\||;|\n/).map((x) => x.trim().replace(/^(cd\s+\S+\s*)/, ''));
  return parts.some((c) => /^(sudo\s+)?(cat|sed|awk|head|tail|grep|rg|ag|find|ls|tree|jq|git\s+(diff|show|log|blame|grep|status)|diff|nl|less|bat|curl|wc|sort|uniq|cut|xxd|od|strings)\b/.test(c));
}

/** The untouched output of a trimmed command: in the session scratchpad (no permission prompt), else grug's cache. */
function saveFullOutput(full: string, scratchpad?: string): string | null {
  const dir = scratchpad && fs.existsSync(scratchpad) ? scratchpad : path.join(paths.cache(), 'outputs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `grug-out-${createHash('sha1').update(full).digest('hex').slice(0, 12)}.txt`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, full);
  return file;
}

export function toolOutputText(input: HookInput): string | null {
  if (typeof input.tool_output === 'string') return input.tool_output;
  const r = input.tool_response;
  if (typeof r === 'string') return r;
  if (r && typeof r === 'object' && typeof r.stdout === 'string') return r.stdout + (r.stderr ? `\n${r.stderr}` : '');
  return null;
}

/** Last assistant text block from a Claude Code transcript (reads only the tail). */
export function lastAssistantText(file?: string): string {
  if (!file) return '';
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"assistant"')) continue;
      try {
        const e = JSON.parse(lines[i]);
        const msg = e.message || e;
        if (msg.role !== 'assistant' && e.type !== 'assistant') continue;
        const content = msg.content;
        const text = typeof content === 'string' ? content : (content || []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');
        if (text.trim()) return text.trim();
      } catch {
        /* partial first line */
      }
    }
  } catch {
    /* no transcript */
  }
  return '';
}

function cliPath(): string {
  const installed = path.join(paths.app(), 'cli.js');
  return fs.existsSync(installed) ? installed : process.argv[1];
}

export function spawnDetached(args: string[]): void {
  if (process.env.VITEST || process.env.GRUG_NO_SPAWN === '1') return; // tests: never start background processes
  try {
    fs.mkdirSync(paths.logs(), { recursive: true });
    const out = fs.openSync(path.join(paths.logs(), `${args[0]}.log`), 'a');
    const child = spawn(process.execPath, [cliPath(), ...args], { detached: true, stdio: ['ignore', out, out] });
    child.unref();
  } catch {
    /* best effort */
  }
}

/** If the proxy is configured in Claude Code but not answering, start it (belt and braces next to launchd). */
function ensureDaemon(): void {
  const cfg = loadConfig();
  try {
    const pid = Number(fs.readFileSync(paths.pid(), 'utf8'));
    if (pid) {
      process.kill(pid, 0);
      return; // alive
    }
  } catch {
    /* not running or no pid file */
  }
  if (cfg.proxy.enabled) spawnDetached(['daemon']);
}

export async function readStdinJson(): Promise<HookInput> {
  if (process.stdin.isTTY) return {};
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}
