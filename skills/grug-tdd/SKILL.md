---
name: grug-tdd
description: Use when implementing a feature or fixing a bug in a project with tests, before writing the implementation. Red, green, refactor.
---

# Test first (grug way)

1. **Red**: write one small test for the next behavior (or the bug). Run it. It must fail, and fail for the right reason (not a typo or import error). If it passes, the test is wrong or the behavior already exists: find out which.
2. **Green**: write the least code that makes it pass. Run the test.
3. **Refactor**: clean names and duplication with tests green. Run them again.
4. Repeat per behavior. Run the nearby test file each cycle; the full suite at the end.

Rules:
- Test behavior through the public interface, not internals; mock only what is slow or external.
- A bug fix always gets a test that failed before the fix.
- Never weaken or delete a failing test to get green. If the test is truly wrong, say why.
- Keep test output short: run the single file/test name, not the whole suite, while iterating.
