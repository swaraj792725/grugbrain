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

## Media (v2.10)
- Measured in Claude Code 2.1: image = ~1 token per 880 px + ~330 overhead, capped ~1.3 MP (~1.5k tokens). Shrinking below ~1300 px long edge is the only way to save per image; the big cost is accumulation in context.
- Hook facts (tested live): PreToolUse `updatedInput` redirects a Read; a redirect to a path outside the project is permission-denied unless `permissionDecision: allow`, but a redirect into `input.scratchpad_dir` needs no decision and prompts nothing. PreToolUse `additionalContext` reaches the model. PostToolUse cannot rewrite a built-in Read image's output. PostToolUse `tool_input` shows the redirected path.
- Ask-once pattern everywhere: deny/redirect once, record a `skip`/`shrunk` event, let the identical repeat through. Never permanent.
- pdf_text needs pdftotext (poppler), video_frames needs ffmpeg; neither is installed in the sandbox, so tests use PATH stubs and PDF/video were not measured live.

## Steering Claude (v2.11)
- Do NOT steer Claude toward grug MCP tools in hints: MCP tools are deferred (ToolSearch round trips) and Edit fails unless the file was Read (a ranged Read counts). Tell it: Grep, then Read with offset/limit. Measured live: reworded hints -> edit task 55% cheaper, context -31%; MCP-steering hints were sometimes worse than no grug.
- Automatic (context injection) works; Claude choosing tools does not, so measure adoption (`~/.grug/adoption.json`, `grug dash`) before adding more nudges.
- /clear cannot be run by a hook. The ceiling is a user-only notice (contextAlert size, idleAlert cache expiry, taskShift new task) with the reason (`grug context` breakdown).
- Live A/B recipe: a git-initialised synthetic project, `claude -p ... --output-format stream-json --verbose --strict-mcp-config --allowedTools ...`, count tool_use names and take max context per run; reset the tree between runs with `git checkout -- .`; use several runs (variance is real).

## Handoff v2 + archive (v2.15)
- handoff.ts fills priority blocks within the same 1200-token cap; archive.ts keeps a text-only conversation copy (memory.archive, archiveMaxMb) read only by deep `history`; standing rules auto-pin (MAX_AUTO_PINS=6).
- A random-indexing semantic layer was measured on the real corpus and was no better than BM25 + synonyms (7/10 vs 5/10 vs fused 6/10), so it was not shipped. Revisit only with a real embedding model, opt-in.

- The desktop Code tab draws NO status line (confirmed by the user; terminal `claude` does). For the app, hooks.ts sends `appSummaryLine` (statusline.ts) as a user-only systemMessage at session start and every `appSummary.everyPrompts` prompts (v2.16).

## Handoff restore quality (v2.19)
- buildHandoff facts come from the things that cannot be wrong: git (gitState: read-only, GIT_OPTIONAL_LOCKS=0, LC_ALL=C, 2.5 s timeout; commits this session via `git log --since=<session start>`), the check's own output (lastCheck: passed / no failure output / FAILED), and the transcript. Shell edits (sed -i, python heredocs) never reach the buffer's file events, so "Files changed" from the buffer is only the no-git fallback. `handoff.git` turns git off.
- Blocks fill by priority within the same cap: goal, latest short message with what it answered, open question, rules, git, todos, check, replies since the goal, decisions, commits, earlier requests. `squeeze` keeps a reply's start and its ending; replies from before the goal are labelled as the previous task.
- Quoted mentions ("root cause" lines) are not facts: `quotedOnly` guards facts.ts and filters already stored facts at read time.
- handoffText adds "Saved N ago" after 10 minutes, since git/check lines describe the moment of saving.
- Not covered: TaskCreate/TaskUpdate todos (only TodoWrite is parsed); the Code tab restore is still unconfirmed; tested on one real transcript plus synthetic ones in tests/grug.test.ts.

## Open items
- Confirm the Code tab honors autoCompactWindow (dash should show "Restored work after auto-compaction"). Hook injection (SessionStart map, UserPromptSubmit recall) is verified in the real CLI (2.1.285) but not yet in the desktop Code tab.
- Watch the average context drop after 2.6.0; consider a default window of 120k.

## Output rules, dashboard, status line (v2.13)
- cmdrules.ts (per-command progress-noise rules) and jsoncompact.ts run in PostToolUse via updatedToolOutput; MCP text-block results are handled the same way. Toggles under `commandRules.*`.
- savings.ts computes the headline: net = kept tokens at main-model input price + grug cache savings - grug costs (negative-token entries); pct = net / (spend + net). It is an estimate, always label it so.
- statusline.ts + `grug statusline` (install.ts applyStatusLine wraps the user's own command, `prevStatusLine` restores it). Claude Code shows the status line BELOW the input box; do not claim it is above.
- Dashboard: src/tui/visual.ts (donut, bigText, pulse), dashboard.ts (5 tabs, 120 ms frames, 2 s reload).

## Overall headline (v2.18)
- savings.ts: headline (netUsd, pct) = all parts minus grug costs. Parts carry a tier: measured (text really cut), derived (`context`: smaller chat from auto-compaction, computed in meter.ts `ctxCut` from real context drops near autoCompact.windowTokens, capped at savings.baselineContextTokens, priced at cache-read), estimate (`cache`). `measuredPct`/`measuredNetUsd` = text-only "of which". The handoff has no dollar value (it would double count the context credit). The credit is recorded per reply as RequestEvent.ctxCutTokens. Default window 150k.

## App visibility (v2.20)
- The desktop Code tab draws no status line and hides hook systemMessages for the user, so grug ships `plugin/grug-live` (Claude Code plugin-authoring API: `ui.render` AbovePrompt band, `$.ui.status`, `$.ui.toast`). install.ts `copyPlugin` copies it to ~/.grug/plugins/grug-live, writes grug.json (node + cli + `app-status`), `applyTuning` adds the dir to env CLAUDE_CODE_PLUGIN_DIRS (user's own dirs kept). Validator rule: `$` may only be used as `$.noun.method(...)` or passed to a top-level function declaration.
- Verified: `claude plugin validate`, loads in `claude -p --plugin-dir`, tests. NOT verified: actual drawing in the user's desktop Code tab. Ask the user.

## Subagents (v2.21)
- Hooks fire inside subagents with `agent_id`/`agent_type` (PreToolUse, PostToolUse verified live); SessionStart/UserPromptSubmit do not, so `subagent-start` injects terse style + read rule. Subagent transcripts are separate files at `<session>/subagents/agent-*.jsonl` (isSidechain true); meterTranscript reads them too, with per-file offsets. v2.22: pre-tool on `Agent|Task` appends autoRecall (isolated: true, cap autoRecall.subagentTokens) to the task prompt via updatedInput; verified live. Full session code map not sent to subagents (cost).

## Quality gates (v2.23)
- verify.ts (Stop hook returns `{decision:'block', reason}`; change-gated by a file signature, `verifyMaxRounds`, timeout/unknown -> silent, skipped for subagents), editguard.ts (PostToolUse `additionalContext`, syntax only), conventions.ts (PreToolUse `additionalContext` on Edit/Write, notes naming the file, once per session via `injected` events), graph.ts `projectImports` ("-> uses" in code hints; graph cache now keeps up to 8 relative imports per file). Config group `quality.*`. Stop hook timeout is 120 s.
- Tests that run the stop hook sandbox PATH to /usr/bin:/bin (no npm), so set `quality.verifyCommand` via saveConfig.
- Repeat-failure guard: a failure fingerprint (`fp` on the verify buffer event) already shown this session means no new send-back.
- Measured (v2.23.1, Sonnet, csv-trap + signature-ripple, 5 runs/arm, equal settings, gates ran): 10/10 vs 10/10, cost +1%, turns 71 vs 62. No quality gain or saving on small tasks; the model passes without gates. Do not claim a "smarter" multiplier or a % saving from this. Savings live in long sessions, which the bench does not cover (a 30+ turn bench is the open idea).
- Bench caveat (fixed): with grug installed the old bench used the INSTALLED hooks, so it tested an older build; now `ownBuild` injects hooks from the running dist/cli.js and passes `--setting-sources project,local` to BOTH arms (unequal settings gave a fake 17%). Always check the `verify`/`guard` events exist in the sandboxed GRUG_HOME before trusting an A/B.
