---
name: grug-debug
description: Use when a bug, failing test, crash or unexpected behavior shows up, before proposing a fix. Finds the root cause first.
---

# Debug (grug way)

No fix without a root cause. Guess-and-patch loops burn tokens and hide the real bug.

1. **Reproduce**: get the exact error and a command that shows it. Read the whole error message and stack.
2. **Narrow**: what changed (`git diff`, `git log -5`)? Smallest input that fails? Which layer is first wrong? Add a print/log at the boundary instead of reading more files.
3. **One hypothesis**: state it in one sentence ("X is null because Y runs before Z"), predict what a check will show, run the check. Wrong? Next hypothesis, not a bigger patch.
4. **Fix the cause**, not the symptom, with a test that failed before (grug-tdd).
5. **Confirm**: the repro now passes and nearby tests still pass.

Stop rules:
- 3 failed fix attempts → stop. Re-read the error, question the assumption or the design, tell the user what you know.
- Never add retries, sleeps, broad try/catch or skipped tests to make a symptom go away.
