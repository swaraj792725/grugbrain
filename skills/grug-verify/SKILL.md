---
name: grug-verify
description: Use before saying work is done, fixed or passing, and before commits or PRs. Run the real checks and report what they printed.
---

# Verify before claiming (grug way)

Evidence first, then the claim.

1. Pick the checks that prove the claim: tests for the touched area, then the full suite; typecheck/lint/build if the project has them; the original repro for a bug.
2. Run them now, in this state of the code. Old runs do not count after an edit.
3. Read the result: pass/fail counts, exit code, warnings.
4. Report plainly: "`npm test` → 212 passed", or "2 failing: <names>". If a check could not run, say so and why.

Never:
- Say "should work", "probably fixed" or "done" without output from this step.
- Trust a subagent's "done" without checking its diff or rerunning its check.
- Skip a slow suite silently; say you skipped it.
