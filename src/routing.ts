/**
 * Light subagents on a cheaper model. Read-only search agents (Explore) inherit the main model, so on Opus every
 * codebase sweep is billed at Opus prices; measured on the user's transcripts: Explore ran on Opus 26 of 42 times.
 * Agents whose definition picks its own model (claude-code-guide -> Haiku) are left alone, as is any Agent call
 * that names a model, and the main chat model is never touched.
 */

import { transcriptEntries } from './handoff.js';
import type { GrugConfig } from './config.js';

const RANK: Record<string, number> = { haiku: 1, sonnet: 2, opus: 3 };

function tier(model: string): string {
  const m = model.toLowerCase();
  return m.includes('opus') ? 'opus' : m.includes('sonnet') ? 'sonnet' : m.includes('haiku') ? 'haiku' : '';
}

function lastModel(transcript: string): string {
  // A single attachment can be 300 KB, so widen the tail until an assistant reply shows up.
  for (const kb of [256, 1024, 4096]) {
    const es = transcriptEntries(transcript, kb * 1024);
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      if (e?.type === 'assistant' && !e.isSidechain && typeof e.message?.model === 'string' && e.message.model !== '<synthetic>') return e.message.model;
    }
  }
  return '';
}

/** Model the main conversation is on: the last assistant reply in the transcript ('' when unknown). */
export function mainModel(transcript: string | undefined): string {
  if (!transcript) return '';
  const m = lastModel(transcript);
  if (m) return m;
  // The reply that makes the Agent call is usually written before PreToolUse fires, but not always: look once more.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  return lastModel(transcript);
}

/** The model to give this Agent call, or null to leave it as Claude asked. Only ever moves down a tier. */
export function lightAgentModel(cfg: GrugConfig, toolInput: any, transcript: string | undefined): string | null {
  const r = cfg.routing;
  const target = tier(r.lightModel || '');
  if (!target || r.subagentModel || process.env.CLAUDE_CODE_SUBAGENT_MODEL) return null; // a global choice wins
  const type = String(toolInput?.subagent_type || '');
  const agents = String(r.lightAgents || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!type || !agents.includes(type) || toolInput?.model) return null;
  const main = tier(mainModel(transcript));
  return main && RANK[target] < RANK[main] ? target : null;
}
