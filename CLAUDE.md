# grugbrain: project handoff (read this instead of old conversations)

Automatic token/cost optimizer for Claude Code (mainly the Claude desktop app's Code tab). Repo: swaraj792725/grugbrain (the local clone may be named token-diet). TypeScript, built with tsup, tested with vitest (`npm test`; tests sandbox HOME, and must never touch the real ~/.claude).

## Install / update (users)
- `npx github:swaraj792725/grugbrain install`, then `grug update`, `grug doctor [--fix]`, `grug dash`.
- npm publish is blocked (NPM_TOKEN needs bypass-2FA); deferred by the user.
- Releases: bump the package.json version on main; release.yml then tags it and makes a GitHub Release plus a tarball.

## Architecture (src/)
- hooks.ts: SessionStart (terse style, handoff restore, memory brief), UserPromptSubmit (context alert, remember:/recall), PreToolUse (read guards), PostToolUse (test summary, output trim via updatedToolOutput `{stdout,stderr}`), Stop (meterTranscript), PreCompact/SessionEnd (handoff + maintain).
- handoff.ts: builds a model-free handoff from the session log and transcript tail. history.ts: keyword search over past transcripts (MCP tool `history`).
- meter.ts: measures real usage from ~/.claude/projects transcripts, because the Code tab bypasses the proxy (ANTHROPIC_BASE_URL is not honored there).
- recall.ts (auto-recall: session budget, tuned bar), recalltune.ts (scores whether code hints were used), graph.ts (code graph cache, fresh-file overlay), facts.ts (incremental durable-fact scan), relevance.ts (BM25-ish ranking).
- proxy/ (port 4747), mcp.ts (tools), install.ts (hooks, MCP, launchd/systemd, PATH launchers, applyTuning for autoCompactWindow / CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_CODE_SUBAGENT_MODEL), update.ts, tui/dashboard.ts, bench.ts.

## Facts learned
- Hooks cannot run /clear or /compact, and cannot replace conversation history. Context is cut only by auto-compaction (grug sets the window to 200k in v2.6.0) or /clear.
- The user's data: about 10.7k replies/week, about $2.9k/week API-equivalent, an average context of about 500k/reply before 2.6.0, 99% cache hits, Opus.
- Evaluated and rejected: a local LLM that summarizes the context every turn (too slow on entry-level hardware, and it can't hook into the Code tab). Worth doing later: a tiny local embedding model to rank history/recall results.
- Never put `#` comments in shell commands given to the user (zsh saves them into the config).

## Matching quality rules (v2.9)
- Any change to relevance.ts / recall gates must keep `npm test` green including tests/recall-eval.test.ts (tuning set + hold-out + compound prompts). Never tune against the hold-out; if you must, write a new hold-out first.
- Live check of hooks in a real Claude Code: `claude -p "<q>" --model haiku --max-turns 1 --settings <file with hooks> --session-id $(uuidgen) --output-format json < /dev/null`, with GRUG_HOME sandboxed and GRUG_NO_SPAWN=1. Always pass a fresh --session-id: nested claude inherits the outer session id, and recall dedupes per session (looks like "no recall").
- Idle cache expiry: cold reply re-writes context at 1.25x (5m tier) / 2x (1h tier) input price; grug warns the user (idleAlert), never the model.

## Open items
- Confirm the Code tab honors autoCompactWindow (dash should show "Restored work after auto-compaction"). Hook injection (SessionStart map, UserPromptSubmit recall) is verified in the real CLI (2.1.285) but not yet in the desktop Code tab.
- Watch the average context drop after 2.6.0; consider a default window of 120k.
