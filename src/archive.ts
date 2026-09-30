/**
 * Conversation archive: a text-only copy of every session (what you said, what Claude answered;
 * no tool output, no tool calls, no thinking), kept by grug after Claude Code deletes its own
 * transcripts (30 days by default). Same line shape as a transcript, so `history` reads it with
 * the same parser. Typically 3-10% of the transcript size, and never loaded into context: it is
 * only searched on demand.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir, paths, readJson, writeJsonAtomic } from './config.js';
import { transcriptEntriesFrom } from './handoff.js';
import { projectTranscriptDir } from './history.js';

const MAX_TEXT = 3000;
const NOISE = /^\s*(\[grugbrain |<system-reminder>|<command-(name|message|args)>|<local-command-stdout>|Caveat: The messages below)/;

export function archiveDir(cwd: string): string {
  return path.join(paths.home(), 'archive', path.basename(projectTranscriptDir(cwd)));
}

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n');
}

/** Copy the new text of a transcript into the archive. Returns the number of entries written. */
export function archiveSession(cwd: string, sessionId: string, transcript: string | undefined, maxMb = 60): number {
  if (!transcript || !sessionId) return 0;
  const dir = archiveDir(cwd);
  const metaFile = path.join(dir, `${sessionId}.meta.json`);
  const meta = readJson<{ offset: number }>(metaFile);
  const offset = meta.ok && typeof meta.value?.offset === 'number' ? meta.value.offset : 0;
  const part = transcriptEntriesFrom(transcript, offset, 16 * 1024 * 1024);
  const lines: string[] = [];
  for (const e of part.entries) {
    if (!e || e.isSidechain || e.isMeta || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const text = textOf(e.message?.content).trim();
    if (text.length < 12 || NOISE.test(text)) continue;
    lines.push(JSON.stringify({ type: e.type, timestamp: e.timestamp, message: { role: e.type, content: [{ type: 'text', text: text.slice(0, MAX_TEXT) }] } }));
  }
  ensureDir(dir);
  if (lines.length) fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  if (part.offset !== offset) writeJsonAtomic(metaFile, { offset: part.offset });
  if (lines.length) prune(dir, maxMb * 1024 * 1024);
  return lines.length;
}

/** Keep the archive under the size cap by dropping whole oldest sessions. */
function prune(dir: string, maxBytes: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { f, size: st.size, m: st.mtimeMs };
      })
      .sort((a, b) => a.m - b.m);
    let total = files.reduce((n, x) => n + x.size, 0);
    for (const x of files) {
      if (total <= maxBytes) break;
      fs.rmSync(path.join(dir, x.f), { force: true });
      fs.rmSync(path.join(dir, x.f.replace(/\.jsonl$/, '.meta.json')), { force: true });
      total -= x.size;
    }
  } catch {
    /* best-effort */
  }
}

/** Archived sessions whose live transcript is gone (Claude Code cleaned it up), newest first. */
export function archiveOnlyFiles(cwd: string, max: number): string[] {
  const dir = archiveDir(cwd);
  const live = projectTranscriptDir(cwd);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jsonl') && !fs.existsSync(path.join(live, f)))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, m: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.m - a.m)
      .slice(0, max)
      .map((x) => x.p);
  } catch {
    return [];
  }
}
