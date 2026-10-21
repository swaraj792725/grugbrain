/**
 * Proof gate (Stop): a reply that says the work is done ("tests pass", "fixed", "verified") while nothing
 * ran after the last code edit is sent back once to show the evidence, or to say plainly that it was not run.
 * Model-free: the buffer has the edits and commands of this turn. grug's own verify run counts as proof.
 * Once per turn, at most MAX_PER_SESSION per session, never for subagents.
 */
import * as path from 'node:path';
import { appendBuffer, readBuffer, type BufferEvent } from './memory/store.js';
import { editedThisTurn } from './verify.js';

const MAX_PER_SESSION = 2;
const CLAIM =
  /\b(?:all (?:\d+ )?(?:tests?|checks?|specs?) (?:now )?pass(?:es|ed|ing)?|tests? (?:now |all )?pass(?:es|ed|ing)?|(?:build|check|typecheck|lint|ci)s? (?:now )?(?:pass(?:es|ed)?|succeed(?:s|ed)?|(?:is )?(?:clean|green))|(?:it |this |that |everything )?works now|now works|verified|confirmed (?:working|fixed)|(?:is|are|now) fixed|fixed (?:it|the bug|the issue|the test)|bug (?:is )?fixed)\b/i;
const HONEST = /\b(?:not (?:been |yet )?(?:run|verified|tested|checked)|untested|unverified|(?:could|did|have|has)(?:n'?t| not) (?:run|test|verify|check)|without running|not able to (?:run|test))\b/i;

/** The success claim in this reply (first one), or null. */
export function claimIn(text: string): string | null {
  if (!text || HONEST.test(text)) return null;
  const m = CLAIM.exec(text);
  return m ? m[0] : null;
}

export function proofCheck(sid: string, cwd: string, text: string, now: number): string | null {
  const claim = claimIn(text);
  if (!claim) return null;
  const events = readBuffer(sid);
  const files = editedThisTurn(events, cwd);
  if (!files.length) return null;
  let start = events.length - 1;
  while (start >= 0 && events[start].t !== 'prompt') start--;
  const turn = events.slice(start + 1);
  if (turn.some((e) => e.t === 'nudge' && e.k === 'proof')) return null;
  if (events.filter((e) => e.t === 'nudge' && e.k === 'proof').length >= MAX_PER_SESSION) return null;
  if (turn.some((e) => e.t === 'verify' && e.ok !== null)) return null; // grug ran the check itself
  let lastEdit = -1;
  turn.forEach((e: BufferEvent, i) => {
    if (e.t === 'file' && e.op === 'edit') lastEdit = i;
  });
  // A command after the last edit is the evidence (a sed -i is logged before its own edit, so it does not count).
  if (turn.slice(lastEdit + 1).some((e) => e.t === 'cmd')) return null;
  appendBuffer(sid, { t: 'nudge', ts: now, k: 'proof' });
  const names = files.slice(0, 3).map((f) => path.basename(f)).join(', ');
  return (
    `grugbrain proof: your reply says "${claim}", but nothing ran after your last edit (${names}). ` +
    `Run the check that shows it (the tests, the build, or the command you changed) and report the result in one line, ` +
    `or say plainly that it was not run. Do not repeat the rest of the reply.`
  );
}
