---
name: grug-worktree
description: Use when starting feature work that should not disturb the current checkout, or before running a plan or parallel agents on the same repo.
---

# Isolated workspace (grug way)

1. If the tool has a built-in worktree or sandbox feature, use it. Otherwise:
2. Check the state: `git status --short` and the current branch. Uncommitted changes? Ask before moving on.
3. Pick the directory: an existing `.worktrees/` or `worktrees/` in the repo, else ask. A worktree inside the repo must be git-ignored (`git check-ignore -q .worktrees` → add it to .gitignore if not).
4. Create: `git worktree add .worktrees/<branch> -b <branch>`.
5. Set up in the new directory: install deps the project's way (npm ci / pnpm i / uv sync ...), then run the tests once to get a clean baseline. Failing baseline → tell the user before starting.
6. Work only inside that directory. When done: grug-finish (it removes the worktree).
