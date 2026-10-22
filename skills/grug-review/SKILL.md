---
name: grug-review
description: Use after finishing a feature or before merging to get a code review, and when receiving review feedback, before changing code because of it.
---

# Review (grug way)

## Ask for a review
1. Collect the scope: base commit, `git diff --stat`, the goal in 2 lines.
2. If a subagent tool exists, give a reviewer subagent only that (goal, base..head, test command), not the whole chat. Ask for: bugs, missing tests, risky changes, each with file:line and severity.
3. Fix critical/important items now; list minor ones for the user.

## Get feedback
1. Read all items before changing anything. Restate unclear ones as a question.
2. Check each against the code: is it true here? Does it break something else? Is it in scope?
3. Fix the valid ones one at a time, testing each. Push back with reasons (code, tests, earlier decisions) when an item is wrong. No performative agreement.
4. Reply with what changed per item and what was declined and why.
