---
name: grug-parallel
description: Use when there are 2 or more independent tasks (separate files, bugs or plan tasks with no shared state) and a subagent tool is available. Runs them as subagents and checks each result.
---

# Parallel subagents (grug way)

Subagents keep the main chat small: each gets a short brief, returns a short report.

1. Split: only truly independent tasks run together. Shared files or order dependencies → run in sequence.
2. Brief each subagent (a few lines, no chat history): goal, exact files/area, constraints, the check command, what to return ("diff summary + check output, under 15 lines").
3. Use a cheaper/faster model for search and mechanical edits when the tool allows choosing one.
4. Launch the independent ones in one reply.
5. For each result: read its report, look at its diff, rerun its check (grug-verify). A wrong result goes back with the specific problem, not a retry from scratch.
6. After all land: run the full suite once; watch for two agents touching the same thing.

For long plans: one fresh subagent per task in order, plus a quick review (grug-review) after each.
