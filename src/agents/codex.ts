/**
 * Codex hooks -> grug's Claude Code hook logic. Codex's hook API is close to Claude Code's
 * (SessionStart/UserPromptSubmit/PreToolUse/PostToolUse additionalContext, Stop block), so most events
 * pass straight through. What differs:
 *  - tools: shell commands (Bash/exec_command, string command) and apply_patch (one or more files); no read tool;
 *  - PostToolUse cannot replace a result, so noisy commands are rewritten into `grug exec` before they run
 *    (Codex accepts a rewrite only with permissionDecision 'allow', so by default only when Codex itself
 *    would not ask: permission_mode bypassPermissions or dontAsk);
 *  - additionalContext is capped (~2.5k tokens) and SessionEnd gets ~1 s, so the end work runs detached.
 * Hooks need the user's one-time approval in Codex (`/hooks`).
 */
import { loadConfig } from '../config.js';
import { dangerReason, dangerText } from '../danger.js';
import { appendBuffer, readBuffer } from '../memory/store.js';
import { recordRead, runHook, spawnDetached, type HookInput } from '../hooks.js';
import { contextOf, FOREIGN_OVERRIDES, loadMeta, reword, saveMeta, shellRead, START_OVERRIDES, withOverrides } from './common.js';
import { shouldWrap, wrapCommand } from './exec.js';
import { cxTool, syncShadow } from './shadow.js';

const C = 'codex' as const;
const MAX_CONTEXT_CHARS = 8000;

export const CODEX_EVENTS: Record<string, string> = {
  SessionStart: 'session-start',
  UserPromptSubmit: 'user-prompt',
  PreToolUse: 'pre-tool',
  PostToolUse: 'post-tool',
  SubagentStart: 'subagent-start',
  Stop: 'stop',
  PreCompact: 'pre-compact',
  SessionEnd: 'session-end'
};
const HOOK_NAMES: Record<string, string> = Object.fromEntries(Object.entries(CODEX_EVENTS).map(([k, v]) => [v, k]));

const clip = (s: string) => (s.length > MAX_CONTEXT_CHARS ? s.slice(0, MAX_CONTEXT_CHARS - 40).trimEnd() + '\n[grugbrain: cut to fit Codex]' : s);

function withContext(event: string, text: string): any | null {
  if (!text.trim()) return null;
  return { hookSpecificOutput: { hookEventName: HOOK_NAMES[event], additionalContext: clip(reword(C, text)) } };
}

export async function runCodexHook(event: string, raw: any): Promise<any | null> {
  if (process.env.GRUG_DISABLE === '1' || !raw || typeof raw !== 'object') return null;
  const cfg = loadConfig();
  if (!cfg.platforms.codex.enabled || !cfg.platforms.codex.hooks) return null;
  const conv = String(raw.session_id || '');
  if (!conv) return null;
  const sid = `cx-${conv}`;
  const cwd = String(raw.cwd || process.cwd());
  const model = typeof raw.model === 'string' ? raw.model : undefined;
  const transcript = syncShadow(C, conv, raw.transcript_path, model, cwd);
  const base: HookInput = { session_id: sid, transcript_path: transcript, cwd, ...(raw.agent_id ? { agent_id: String(raw.agent_id), agent_type: String(raw.agent_type || '') } : {}) };
  const ev = CODEX_EVENTS[event] || event;

  return withOverrides(FOREIGN_OVERRIDES, async () => {
    switch (ev) {
      case 'session-start': {
        const meta = loadMeta(C, conv);
        // A resumed conversation still holds what grug sent at its start.
        if (raw.source === 'resume' && meta.started) return null;
        meta.started = true;
        saveMeta(C, conv, meta);
        const source = raw.source === 'compact' || raw.source === 'clear' ? raw.source : 'startup';
        return withContext(ev, contextOf(await withOverrides(START_OVERRIDES, () => runHook('session-start', { ...base, source }))));
      }

      case 'user-prompt':
        return withContext(ev, contextOf(await runHook('user-prompt', { ...base, prompt: String(raw.prompt || '') })));

      case 'subagent-start':
        return withContext(ev, contextOf(await runHook('subagent-start', base)));

      case 'pre-tool': {
        const name = String(raw.tool_name || '');
        const m = cxTool(name, raw.tool_input, cwd);
        const notes: string[] = [];
        // `cat f` / `sed -n 'A,Bp' f` is how Codex reads a file: checked as a Read (re-read and big-file guards).
        const read = m.name === 'Bash' ? shellRead(String(m.input.command || ''), cwd) : null;
        for (const input of m.name === 'Edit' ? (m.input.files as string[]).map((f) => ({ file_path: f })) : [read || m.input]) {
          const out = await runHook('pre-tool', { ...base, tool_name: read ? 'Read' : m.name, tool_input: input });
          const h = out?.hookSpecificOutput || {};
          if (h.permissionDecision === 'deny')
            return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reword(C, String(h.permissionDecisionReason || 'grugbrain')) } };
          // A risky command: held back once with the reason; the identical repeat (after the user's yes) runs.
          if (h.permissionDecision === 'ask') {
            const key = `danger:${String(input.command || '')}`;
            if (!readBuffer(sid).some((e) => e.t === 'skip' && e.key === key)) {
              appendBuffer(sid, { t: 'skip', ts: Date.now(), key });
              const why = dangerReason(String(input.command || '')) || 'risky';
              return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: dangerText(String(input.command || ''), why, true) } };
            }
          }
          if (h.additionalContext) notes.push(String(h.additionalContext));
        }
        const cmd = typeof raw.tool_input?.command === 'string' ? raw.tool_input.command : '';
        const mode = cfg.platforms.codex.rewrite;
        const quiet = raw.permission_mode === 'bypassPermissions' || raw.permission_mode === 'dontAsk';
        if (m.name === 'Bash' && cmd && (mode === 'allow' || (mode === 'auto' && quiet)) && shouldWrap(cmd)) {
          return {
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              permissionDecision: 'allow',
              permissionDecisionReason: 'grugbrain: same command, output shortened (errors kept)',
              updatedInput: { ...raw.tool_input, command: wrapCommand(cmd, C) },
              ...(notes.length ? { additionalContext: clip(reword(C, notes.join('\n'))) } : {})
            }
          };
        }
        return withContext(ev, notes.join('\n'));
      }

      case 'post-tool': {
        const m = cxTool(String(raw.tool_name || ''), raw.tool_input, cwd);
        const notes: string[] = [];
        // No tool_response: Codex cannot replace a result, so nothing is trimmed (or counted) here.
        for (const input of m.name === 'Edit' ? (m.input.files as string[]).map((f) => ({ file_path: f })) : [m.input]) {
          const text = contextOf(await runHook('post-tool', { ...base, tool_name: m.name, tool_input: input }));
          if (text) notes.push(text);
        }
        const read = m.name === 'Bash' ? shellRead(String(m.input.command || ''), cwd) : null;
        if (read) recordRead(sid, read, base.agent_id);
        return withContext(ev, notes.join('\n'));
      }

      case 'stop': {
        const out = await runHook('stop', { ...base, last_assistant_message: typeof raw.last_assistant_message === 'string' ? raw.last_assistant_message : undefined });
        if (out?.decision === 'block' && out.reason) return { decision: 'block', reason: reword(C, String(out.reason)) };
        return null;
      }

      case 'pre-compact':
        await runHook('pre-compact', base);
        return null;

      case 'session-end':
        spawnDetached(['agent-end', C, conv, cwd, String(raw.transcript_path || ''), model || '']);
        return null;
    }
    return null;
  });
}
