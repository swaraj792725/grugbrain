---
name: grug-plan
description: Use when there is an agreed design or clear requirements for a multi-step change, before touching code. Produces a small step-by-step plan another agent could follow.
---

# Write a plan (grug way)

A plan is a checklist a fresh agent with no context could follow. Short beats complete-looking.

Each task:
- **Files**: exact paths to create/change (and test file).
- **Change**: what to do in 1-3 lines; a code sketch only where the shape is not obvious.
- **Check**: the exact command and the expected result (e.g. `npm test -- auth` → 3 passed).
- Size: one task = one small commit (2-15 minutes of work).

Order:
1. Read only what the plan needs (Grep, then ranged Read). Note the test command and conventions you found.
2. Tests first inside each task when the project has tests (see grug-tdd).
3. Put risky or unknown parts first so surprises come early.
4. End with a final task: full test suite + build + grug-verify.

Write it to the todo list for one session; to docs/plans/<date>-<topic>.md only if it spans sessions or will run in parallel.
Then ask: execute here step by step (grug-execute) or fan out (grug-parallel)?
