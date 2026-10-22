---
name: grug-finish
description: Use when the work on a branch is complete and checks pass, to decide how to land it (merge, PR, keep or discard) and clean up.
---

# Finish a branch (grug way)

1. Verify: full tests + build pass now (grug-verify). Failing → fix first; do not offer to merge.
2. Find the base branch (`git merge-base HEAD main` or the repo default).
3. Ask the user, once, with these options:
   1. Merge into the base branch locally
   2. Push and open a pull request
   3. Keep the branch as is
   4. Discard the work (needs the user to type "discard")
4. Do it:
   - Merge: update base, merge, run tests on the result, delete the branch.
   - PR: push with upstream, open the PR with a short summary and the test command/result.
   - Keep: report branch name and path.
   - Discard: only after the typed confirmation; delete the branch.
5. Worktree: remove it for merge and discard (`git worktree remove <path>`); keep it for PR and keep.
