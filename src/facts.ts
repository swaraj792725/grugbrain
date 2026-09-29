/**
 * Durable facts from a session transcript, picked by rules (no model call) at handoff time
 * (PreCompact / SessionEnd): decisions, root causes of errors, user preferences, and project
 * commands that worked. They become memory notes (deduped, decaying like every other note),
 * so auto-recall has good material later.
 */

import { similarity } from './memory/store.js';
import { transcriptEntriesFrom } from './handoff.js';

export type FactKind = 'decision' | 'cause' | 'preference' | 'command';

export interface Fact {
  kind: FactKind;
  text: string;
  ts: number;
}

const DECISION = /\b(decided|decision:|we chose|chose to|opted (?:for|to)|settled on|going with|we(?:'ll| will) (?:use|keep|go with)|convention is|agreed to)\b/i;
const CAUSE = /\b(root cause|caused by|the (?:bug|issue|problem|error|failure|crash) (?:was|is|comes from)|(?:fails|failed|failing|broke|breaks) because|happens because|the fix (?:was|is)|fixed (?:it )?by)\b/i;
const PREFERENCE = /^(?:please\s+)?(?:always|never|don't|do not|stop|avoid|prefer|i prefer|i'd prefer|i want you to|i'd like you to|from now on|make sure (?:to|you)|no more)\b|\bfrom now on\b/i;
const PROJECT_CMD =
  /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|build|lint|typecheck|check|dev|start|e2e|format|migrate|deploy|release)\b|npx\s+(?:vitest|jest|tsc|eslint|playwright|prisma|drizzle-kit)\b|(?:pytest|tox|ruff|mypy|cargo\s+(?:test|build|clippy|run)|go\s+(?:test|build|vet|run)|make\b|just\b|gradle|\.\/gradlew|mvn|dotnet\s+(?:test|build)|bundle exec|rake|mix\s+test|docker\s+compose|docker-compose|terraform\s+(?:plan|apply)|fly\s+deploy|vercel|uv\s+run|poetry\s+run|python3?\s+-m\s+(?:pytest|unittest)))/;
const SECRET = /(sk-[a-z0-9-]{8,}|ghp_[A-Za-z0-9]{10,}|xox[abp]-|AKIA[0-9A-Z]{12,}|Bearer\s+[A-Za-z0-9._-]{10,}|(?:api[_-]?key|token|secret|password|passwd)\s*[=:]\s*\S+)/i;
const NOISE = /^\s*(\[grugbrain|<system-reminder>|<command-|<local-command|Caveat:)/;
const NARRATION = /^(let me|i'll|i will|i'm going to|now i|next,? i|first,? i|okay|ok,|sure|great|done)/i;

function textOf(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b: any) => b?.type === 'text' && b.text).map((b: any) => b.text).join('\n');
}

function sentences(text: string): string[] {
  const clean = text.replace(/```[\s\S]*?```/g, ' ').replace(/`/g, '');
  const out: string[] = [];
  for (const raw of clean.split(/(?<=[.!?])\s+|\n+/)) {
    const s = raw.replace(/^[\s\-*#>\d.)]+/, '').replace(/\*\*/g, '').trim();
    if (s.length >= 25 && s.length <= 240 && !s.endsWith('?') && !SECRET.test(s)) out.push(s);
  }
  return out;
}

function stripCd(cmd: string): string {
  return cmd.replace(/^\s*cd\s+[^&;]+&&\s*/, '').trim();
}

export interface FactScan {
  facts: Fact[];
  /** Resume point: pass it back next time so each transcript byte is read once. */
  offset: number;
  /** Commands seen failing (so a later pass can tell "failed, then fixed"). */
  failed: string[];
}

/** Whole transcript (or its last 4 MB) at once. */
export function extractFacts(transcriptPath: string | undefined, max = 8): Fact[] {
  return scanFacts(transcriptPath, 0, [], max).facts;
}

/** Facts from what was appended since `offset`. Cheap enough for every Stop hook. */
export function scanFacts(transcriptPath: string | undefined, offset = 0, failed: string[] = [], max = 8): FactScan {
  const part = transcriptEntriesFrom(transcriptPath, offset);
  const es = part.entries;
  const byKind: Record<FactKind, Fact[]> = { decision: [], cause: [], preference: [], command: [] };
  const caps: Record<FactKind, number> = { decision: 3, cause: 3, preference: 2, command: 2 };
  const pendingCmd = new Map<string, string>();
  const failedCmds = new Set<string>(failed);
  let lastErrorAt = -99;
  const push = (kind: FactKind, text: string, ts: number): boolean => {
    const list = byKind[kind];
    if (list.some((f) => similarity(f.text, text) >= 0.6)) return false;
    list.push({ kind, text, ts });
    return true;
  };
  es.forEach((e, idx) => {
    if (!e || e.isSidechain || e.isMeta) return;
    const ts = Date.parse(e.timestamp) || Date.now();
    const c = e.message?.content;
    if (e.type === 'user') {
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type !== 'tool_result' || !pendingCmd.has(b.tool_use_id)) continue;
          const cmd = pendingCmd.get(b.tool_use_id)!;
          pendingCmd.delete(b.tool_use_id);
          const out = typeof b.content === 'string' ? b.content : textOf(b.content);
          const failed = b.is_error === true || /\b(exit code [1-9]|command failed|npm ERR!|FAILED|Traceback \(most recent)/.test(out);
          if (failed) {
            failedCmds.add(cmd);
            lastErrorAt = idx;
          } else {
            // A command that failed earlier and now passes is the most useful kind to remember.
            if (push('command', `Command that works here: \`${cmd}\``, ts) && failedCmds.has(cmd)) byKind.command.unshift(byKind.command.pop()!);
          }
        }
      }
      const t = textOf(c);
      if (!t || NOISE.test(t) || /^\s*(?:grug\s+)?remember\b/i.test(t)) return;
      for (const line of t.split(/\n+/)) {
        const s = line.trim();
        if (s.length >= 15 && s.length <= 200 && PREFERENCE.test(s) && !s.endsWith('?') && !SECRET.test(s)) push('preference', `User preference: ${s}`, ts);
      }
      return;
    }
    if (e.type !== 'assistant') return;
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== 'tool_use' || b.name !== 'Bash' || typeof b.input?.command !== 'string') continue;
        const cmd = stripCd(b.input.command);
        if (cmd.length <= 120 && !cmd.includes('\n') && PROJECT_CMD.test(cmd) && !SECRET.test(cmd)) pendingCmd.set(b.id, cmd);
      }
    }
    const t = textOf(c);
    if (!t || NOISE.test(t)) return;
    for (const s of sentences(t)) {
      if (NARRATION.test(s)) continue;
      // Causes count when they follow a failure, or say "root cause" outright.
      if (CAUSE.test(s) && (idx - lastErrorAt <= 12 || /root cause/i.test(s))) push('cause', /^root cause/i.test(s) ? s : `Root cause: ${s}`, ts);
      else if (DECISION.test(s)) push('decision', s, ts);
    }
  });
  const out: Fact[] = [];
  // Latest decisions/causes/preferences win; commands keep "failed, then fixed" ones first.
  for (const k of ['preference', 'cause', 'decision'] as FactKind[]) out.push(...byKind[k].slice(-caps[k]));
  out.push(...byKind.command.slice(0, caps.command));
  return { facts: out.slice(0, max), offset: part.offset, failed: [...failedCmds].slice(-20) };
}
