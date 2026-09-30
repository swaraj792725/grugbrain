/**
 * Media hooks: what grug does when Claude looks at screenshots, images, PDFs and video.
 * Every rule here is quality-neutral by construction: it only skips a repeat of something already
 * in the context, or points at a cheaper way in and lets Claude repeat the call to override.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { GrugConfig } from './config.js';
import {
  countPageRange, estimateImageTokens, hasTool, IMAGE_RE, imageSizeOfBase64, imageSizeOfFile, PDF_RE, pdfPageCount, resizeImageFile, VIDEO_RE
} from './media.js';
import { BufferEvent, appendBuffer, readBuffer } from './memory/store.js';
import { recordActivity } from './stats.js';
import { costPerReply } from './handoff.js';

type HookOutput = Record<string, any> | null;

export interface MediaInput {
  tool_name?: string;
  tool_input?: any;
  tool_response?: any;
  scratchpad_dir?: string;
  agent_id?: string;
}

const OVERHEAD = 330; // tool call + result framing around one image
const SCREENSHOT_TTL_MS = 2 * 60 * 1000; // after this the page may have changed on its own

export const SCREENSHOT_GUIDANCE =
  '[grugbrain: every screenshot stays in context (over 1k tokens) and is re-read on each later reply. ' +
  'For page state prefer a text/DOM snapshot, console or network output; take a screenshot to check how something looks, ' +
  'once per batch of changes, and crop or zoom to the part you need.]';

/** Stable key for "the same screenshot request", or null when this call is not a screenshot. */
export function screenshotKey(tool: string, input: any): string | null {
  if (!/^mcp__/i.test(tool)) return null;
  const last = tool.split('__').pop() || '';
  const byName = /screenshot|screen_shot|capture_screen|take_snapshot_image/i.test(last);
  const byAction = String(input?.action || '').toLowerCase() === 'screenshot';
  if (!byName && !byAction) return null;
  const stable = JSON.stringify(input || {}, Object.keys(input || {}).sort());
  return createHash('sha1').update(tool + '|' + stable).digest('hex').slice(0, 12);
}

/** Read-only MCP calls do not change the page, so a screenshot after them is still a repeat. */
export function isReadOnlyTool(tool: string): boolean {
  const last = tool.split('__').pop() || tool;
  return /^grugbrain$/i.test(tool.split('__')[1] || '') || /(snapshot|screenshot|get_|list_|read_|console|network|tabs_context|find|search|query|status|info|wait_for|inspect)/i.test(last);
}

/** Events since the last compaction: what is still in Claude's context. */
function epoch(events: BufferEvent[]): BufferEvent[] {
  let i = events.length - 1;
  while (i >= 0 && events[i].t !== 'compact') i--;
  return events.slice(i + 1);
}

/** Image blocks in a tool response (MCP content array, built-in Read {type:'image'}, nested). */
export function findImages(resp: any, depth = 0): Array<{ w: number; h: number }> {
  const out: Array<{ w: number; h: number }> = [];
  if (!resp || depth > 6) return out;
  if (Array.isArray(resp)) {
    for (const r of resp) out.push(...findImages(r, depth + 1));
    return out;
  }
  if (typeof resp !== 'object') return out;
  const b64 = typeof resp.data === 'string' && /image/i.test(String(resp.mimeType || resp.type || '')) ? resp.data : typeof resp.base64 === 'string' ? resp.base64 : typeof resp.source?.data === 'string' ? resp.source.data : '';
  if (b64 && b64.length > 100) {
    const s = imageSizeOfBase64(b64);
    out.push(s ? { w: s.w, h: s.h } : { w: 0, h: 0 });
    return out;
  }
  for (const v of Object.values(resp)) if (v && typeof v === 'object') out.push(...findImages(v, depth + 1));
  return out;
}

function fmtMin(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000));
  return `${m} min`;
}

export function mediaPreTool(cfg: GrugConfig, input: MediaInput, sid: string, cwd: string, now: number, readKey: (f: string, ti: any, a?: string) => string): HookOutput {
  const mg = cfg.mediaGuard;
  if (!mg.enabled) return null;
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const proj = path.basename(cwd);

  // 1. A screenshot that would show the page exactly as the last one did.
  if (mg.dedupeScreenshots) {
    const key = screenshotKey(tool, ti);
    if (key) {
      const ev = epoch(readBuffer(sid));
      let last = -1;
      for (let i = ev.length - 1; i >= 0; i--) {
        const e = ev[i];
        if (e.t === 'shot' && e.key === key) {
          last = i;
          break;
        }
      }
      if (last < 0) return null;
      const shot = ev[last] as Extract<BufferEvent, { t: 'shot' }>;
      const after = ev.slice(last + 1);
      const changed = after.some((e) => (e.t === 'file' && e.op === 'edit') || e.t === 'cmd' || (e.t === 'mcp' && !e.ro));
      const asked = after.some((e) => e.t === 'skip' && e.key === 'shot|' + key);
      if (changed || asked || now - shot.ts > SCREENSHOT_TTL_MS) return null;
      appendBuffer(sid, { t: 'skip', ts: now, key: 'shot|' + key });
      recordActivity({ kind: 'media', msg: 'Skipped a repeat screenshot (nothing changed since the last one)', tokens: shot.tokens + OVERHEAD, project: proj });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `grugbrain: nothing has changed since your identical screenshot ${fmtMin(now - shot.ts)} ago (no clicks, edits or commands in between), ` +
            `so it would show the same image, which is already in your context above. Use that. ` +
            `If the page changes by itself (animation, loading), repeat the same call and it will be allowed.`
        }
      };
    }
  }

  if (tool !== 'Read' || typeof ti.file_path !== 'string') return null;
  const file: string = ti.file_path;

  // 2. Images
  if (IMAGE_RE.test(file)) {
    let st: fs.Stats;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    const key = readKey(file, ti, input.agent_id);
    const ev = epoch(readBuffer(sid));
    let lastRead = -1;
    let lastShrunk = -1;
    let invalidatedAfter = false;
    ev.forEach((e, i) => {
      if (e.t === 'read' && e.key === key) {
        lastRead = i;
        invalidatedAfter = false;
      } else if (e.t === 'shrunk' && e.key === key) lastShrunk = i;
      else if (e.t === 'file' && e.op === 'edit' && path.resolve(e.path) === path.resolve(file)) invalidatedAfter = true;
    });
    // Read once already, only as a shrunken copy: this repeat is a request for the full-size image.
    if (lastShrunk >= 0 && lastRead <= lastShrunk) return null;
    const size = imageSizeOfFile(file);
    const tok = size ? estimateImageTokens(size.w, size.h) : 1500;
    if (mg.dedupeImageReads && lastRead >= 0 && !invalidatedAfter) {
      const r = ev[lastRead] as Extract<BufferEvent, { t: 'read' }>;
      const asked = ev.slice(lastRead + 1).some((e) => e.t === 'skip' && e.key === key);
      if (!asked && r.mtime === st.mtimeMs && r.size === st.size) {
        appendBuffer(sid, { t: 'skip', ts: now, key });
        recordActivity({ kind: 'media', msg: `Skipped unchanged re-read of image ${path.basename(file)}`, tokens: tok + OVERHEAD, project: proj });
        return {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
              `grugbrain: ${path.basename(file)} is unchanged since you viewed it ${fmtMin(now - r.ts)} ago, so the image is already in your context above. ` +
              `If it is no longer visible to you, repeat the same Read and it will be allowed.`
          }
        };
      }
    }
    // Shrink big image files inside the project (a copy in the session scratchpad; the original is untouched).
    // Only the first look in a context is shrunk; anything read before (any size) is left as it is.
    if (mg.imageMaxEdge > 0 && lastRead < 0 && size && input.scratchpad_dir && isInside(file, cwd) && !ti.offset && !ti.limit) {
      const cap = mg.imageMaxEdge;
      const s = Math.min(1, cap / Math.max(size.w, size.h));
      const after = estimateImageTokens(Math.round(size.w * s), Math.round(size.h * s));
      // Claude Code already caps images near 1.3 MP: only bother when a smaller edge saves a real chunk.
      if (s < 1 && tok - after >= 250) {
        const ext = size.type === 'png' ? 'png' : size.type === 'jpeg' ? 'jpg' : 'png';
        const dst = path.join(input.scratchpad_dir, `grug-img-${createHash('sha1').update(`${path.resolve(file)}|${st.mtimeMs}|${cap}`).digest('hex').slice(0, 12)}.${ext}`);
        if (fs.existsSync(dst) || resizeImageFile(file, dst, cap)) {
          appendBuffer(sid, { t: 'read', ts: now, path: file, key, mtime: st.mtimeMs, size: st.size });
          appendBuffer(sid, { t: 'shrunk', ts: now, key });
          recordActivity({ kind: 'media', msg: `Shrunk ${path.basename(file)} ${size.w}x${size.h} → ${Math.round(size.w * s)}x${Math.round(size.h * s)} before reading`, tokens: tok - after, project: proj });
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              updatedInput: { ...ti, file_path: dst },
              additionalContext: `[grugbrain: ${path.basename(file)} (${size.w}x${size.h}) was shrunk to ${Math.round(size.w * s)}x${Math.round(size.h * s)} to save tokens. If you need fine detail, repeat the same Read to get the full-size image.]`
            }
          };
        }
      }
    }
    return null;
  }

  // 3. PDFs: pages as images cost 1.5-3k tokens each; text is far cheaper for text pages.
  if (PDF_RE.test(file)) {
    if (!hasTool('pdftotext')) return null;
    const total = pdfPageCount(file);
    const want = countPageRange(ti.pages, total);
    if (!want || want <= mg.pdfPages) return null;
    const key = `pdf|${path.resolve(file)}|${ti.pages ?? ''}`;
    if (readBuffer(sid).some((e) => e.t === 'skip' && e.key === key)) return null;
    appendBuffer(sid, { t: 'skip', ts: now, key });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `grugbrain: ${path.basename(file)} has ${total || 'many'} pages and this Read asks for ${want}; page images cost about 1.5-3k tokens each. ` +
          `First try the grugbrain pdf_text tool (path, pages): the text of a text page costs a fraction of that, and it lists pages that are scans or figures. ` +
          `Then Read only those pages (pages="N") as images. To read these pages as images anyway, repeat the same Read and it will be allowed.`
      }
    };
  }

  // 4. Video: not readable as a file; a frame sheet is.
  if (VIDEO_RE.test(file)) {
    const key = `video|${path.resolve(file)}`;
    if (readBuffer(sid).some((e) => e.t === 'skip' && e.key === key)) return null;
    appendBuffer(sid, { t: 'skip', ts: now, key });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: hasTool('ffmpeg')
          ? `grugbrain: ${path.basename(file)} is a video. Use the grugbrain video_frames tool (path, count, from, to): it returns one contact-sheet image of evenly spaced frames, which costs about one image instead of one per frame. Repeat the Read to proceed anyway.`
          : `grugbrain: ${path.basename(file)} is a video and cannot be read as a file. Extract a few frames first (ffmpeg is not installed: brew install ffmpeg), then Read a contact sheet instead of many single frames. Repeat the Read to proceed anyway.`
      }
    };
  }
  return null;
}

function isInside(file: string, dir: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** After a tool ran: remember screenshots/MCP calls/images, and give the one-time screenshot hint. */
export function mediaPostTool(cfg: GrugConfig, input: MediaInput, sid: string, now: number): HookOutput {
  const mg = cfg.mediaGuard;
  if (!mg.enabled) return null;
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const isMcp = /^mcp__/i.test(tool);
  const isReadImage = tool === 'Read' && typeof ti.file_path === 'string' && IMAGE_RE.test(ti.file_path);
  if (!isMcp && !isReadImage) return null;

  const imgs = findImages(input.tool_response);
  let tokens = 0;
  for (const im of imgs) tokens += estimateImageTokens(im.w, im.h);
  if (tokens) appendBuffer(sid, { t: 'img', ts: now, tokens, src: isMcp ? tool.split('__').pop() || 'mcp' : 'read' });

  if (!isMcp) return null;
  const key = screenshotKey(tool, ti);
  if (!key) {
    appendBuffer(sid, { t: 'mcp', ts: now, name: tool, ro: isReadOnlyTool(tool) });
    return null;
  }
  appendBuffer(sid, { t: 'shot', ts: now, key, tokens: tokens || 1500 });
  if (mg.guidance && !epoch(readBuffer(sid)).some((e) => e.t === 'guided')) {
    appendBuffer(sid, { t: 'guided', ts: now });
    return { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: SCREENSHOT_GUIDANCE } };
  }
  return null;
}

/** Images sitting in the context (since the last compaction): count and estimated tokens. */
export function imagesInContext(sid: string): { count: number; tokens: number } {
  let count = 0;
  let tokens = 0;
  for (const e of epoch(readBuffer(sid))) if (e.t === 'img') {
    count++;
    tokens += e.tokens;
  }
  return { count, tokens };
}

/** User-only notice when the pile of images in this session's context passes 20k tokens, then doubles. */
export function imageAlert(cfg: GrugConfig, sid: string, model: string, now: number): string | undefined {
  const first = cfg.mediaGuard.imageAlertTokens;
  if (!cfg.mediaGuard.enabled || !first) return undefined;
  const { count, tokens } = imagesInContext(sid);
  if (tokens < first) return undefined;
  const level = Math.floor(Math.log2(tokens / first)) + 1;
  const ev = epoch(readBuffer(sid));
  const done = ev.reduce((m, e) => (e.t === 'imgalert' ? Math.max(m, e.level) : m), 0);
  if (level <= done) return undefined;
  appendBuffer(sid, { t: 'imgalert', ts: now, level });
  const per = costPerReply(tokens, model);
  recordActivity({ kind: 'media', msg: `${count} images (~${Math.round(tokens / 1000)}k tokens) sit in this session's context` });
  return (
    `🪨 grugbrain: ${count} images/screenshots (~${Math.round(tokens / 1000)}k tokens, ~$${per.toFixed(2)} per reply) are in this session's context and re-read on every reply. ` +
    `Done with the visual work? /clear starts fresh (grug hands the work over); otherwise ask Claude to work from text snapshots and skip more screenshots.`
  );
}
