/**
 * Antigravity (app, IDE, agy CLI) hooks -> grug's Claude Code hook logic.
 *
 * Antigravity has no SessionStart/UserPromptSubmit and its PostToolUse cannot add anything, so:
 *  - PreInvocation (before each model call) carries the start context and prompt recall at the first
 *    call of a turn as a user message (an ephemeral message is seen by one model call only, verified live),
 *    plus any notes queued since (edit/type guards, batching nudge) as an ephemeral message;
 *  - PreToolUse denies the same reads grug denies in Claude Code, and rewrites noisy commands into
 *    `grug exec` (decision 'ask' keeps the user's approval; 'allow' only when configured);
 *  - Stop meters the conversation, captures facts, runs the verify gate, and leaves a handoff.
 * The app's own log is converted to a Claude-format shadow transcript first (shadow.ts).
 */
import { loadConfig } from '../config.js';
import { recordRead, runHook, spawnDetached, type HookInput } from '../hooks.js';
import { AG_CONTEXT_MARK, contextOf, FOREIGN_OVERRIDES, loadMeta, queueNote, reword, saveMeta, shellRead, START_OVERRIDES, takeNotes, withOverrides } from './common.js';
import { shouldWrap, wrapCommand } from './exec.js';
import { agTool, lastPrompt, syncShadow } from './shadow.js';

const C = 'antigravity' as const;

export const AG_EVENTS: Record<string, string> = { PreInvocation: 'pre-invocation', PreToolUse: 'pre-tool', PostToolUse: 'post-tool', Stop: 'stop' };

export async function runAntigravityHook(event: string, raw: any): Promise<any | null> {
  if (process.env.GRUG_DISABLE === '1' || !raw || typeof raw !== 'object') return null;
  const cfg = loadConfig();
  if (!cfg.platforms.antigravity.enabled || !cfg.platforms.antigravity.hooks) return null;
  const conv = String(raw.conversationId || raw.conversation_id || '');
  if (!conv) return null;
  const sid = `ag-${conv}`;
  const cwd = String((Array.isArray(raw.workspacePaths) && raw.workspacePaths[0]) || raw.cwd || process.cwd());
  const model = typeof raw.modelName === 'string' ? raw.modelName : undefined;
  const transcript = syncShadow(C, conv, raw.transcriptPath, model, cwd);
  const base: HookInput = { session_id: sid, transcript_path: transcript, cwd };

  return withOverrides(FOREIGN_OVERRIDES, async () => {
    switch (AG_EVENTS[event] || event) {
      case 'pre-invocation': {
        const parts: string[] = [];
        const steps: any[] = [];
        const first = !Number(raw.invocationNum);
        if (first) {
          const meta = loadMeta(C, conv);
          if (!meta.started) {
            const out = await withOverrides(START_OVERRIDES, () => runHook('session-start', { ...base, source: 'startup' }));
            const text = contextOf(out);
            if (text) parts.push(text);
            meta.started = true;
          }
          const prompt = lastPrompt(C, conv);
          if (prompt && prompt !== meta.prompt) {
            meta.prompt = prompt;
            const text = contextOf(await runHook('user-prompt', { ...base, prompt }));
            if (text) parts.push(text);
          }
          saveMeta(C, conv, meta);
          if (parts.length)
            steps.push({ userMessage: `${AG_CONTEXT_MARK} (added automatically, not typed by the user; carry on with the user's request above)]\n${reword(C, parts.join('\n\n'))}` });
        }
        const notes = takeNotes(C, conv);
        if (notes.length) steps.push({ ephemeralMessage: reword(C, notes.join('\n\n')) });
        return steps.length ? { injectSteps: steps } : null;
      }

      case 'pre-tool': {
        const call = raw.toolCall || {};
        const m = agTool(String(call.name || ''), call.args);
        // A shell print of one file is checked as a read (re-read and big-file guards).
        const read = m.name === 'Bash' ? shellRead(String(m.input.command || ''), cwd) : null;
        const out = await runHook('pre-tool', { ...base, tool_name: read ? 'Read' : m.name, tool_input: read || m.input });
        const h = out?.hookSpecificOutput || {};
        if (h.permissionDecision === 'deny') return { decision: 'deny', reason: reword(C, String(h.permissionDecisionReason || 'grugbrain')) };
        // A risky command: Antigravity's own approval prompt asks the user, even when it is set to always allow.
        if (h.permissionDecision === 'ask') return { decision: 'force_ask', reason: String(h.permissionDecisionReason || 'grugbrain') };
        if (h.additionalContext) queueNote(C, conv, String(h.additionalContext));
        const mode = cfg.platforms.antigravity.rewrite;
        const cmd = String(call.args?.CommandLine || '');
        if (m.name === 'Bash' && mode !== 'off' && shouldWrap(cmd)) {
          return { decision: mode, overwrite: { CommandLine: wrapCommand(cmd, C) } };
        }
        // Print nothing: any JSON without a decision denies the tool in Antigravity.
        return null;
      }

      case 'post-tool': {
        const call = raw.toolCall || {};
        const m = agTool(String(call.name || ''), call.args);
        // No tool_response: Antigravity cannot replace a result, so nothing is trimmed (or counted) here.
        const out = await runHook('post-tool', { ...base, tool_name: m.name, tool_input: m.input });
        const read = m.name === 'Bash' ? shellRead(String(m.input.command || ''), cwd) : null;
        if (read) recordRead(sid, read);
        const text = contextOf(out);
        if (text) queueNote(C, conv, text);
        return {};
      }

      case 'stop': {
        const out = await runHook('stop', base);
        // The handoff and the end-of-session upkeep run in the background so the reply is not held up.
        spawnDetached(['agent-end', C, conv, cwd, String(raw.transcriptPath || ''), model || '']);
        if (out?.decision === 'block' && out.reason) {
          return { decision: 'continue', reason: reword(C, String(out.reason)) };
        }
        return null;
      }
    }
    return null;
  });
}
