# Changelog

Grug keep list of what change. Newest on top. Each `## x.y.z` section becomes the GitHub Release notes.

## 2.18.0

One overall savings percentage, and a smaller chat.

- The headline is now the overall saving: text grug cut out, plus the smaller chat from auto-compaction, plus better caching, minus grug's own costs. The dashboard says how sure each part is: measured (really removed), `~` worked out from your real chat sizes, `≈` estimate. The "of which measured" share is shown under the headline.
- New smaller-chat saving: when the chat drops sharply near the auto-compaction window grug set, later replies no longer re-read those tokens. Counted at cache-read price and capped at your usual chat size (`savings.baselineContextTokens`, default 500k). Starts counting from this version.
- The handoff after /clear or compact no longer has its own dollar figure (it double counted the smaller-chat saving).
- Default auto-compaction window is now 150k (was 200k), so chats stay smaller. Existing installs keep their saved value: `grug config set autoCompact.windowTokens 150000`.

## 2.17.2

Small savings no longer read as 0.

- The big percentage shows 3 decimals under 1% (for example 0.002%) and the last-24-hours figure does too; the live ticker triggers on sub-cent gains.
- A note explains why the measured number is small (most cost is Claude re-reading a long chat).

## 2.17.1

App summary now always shows.

- The grug line shows on the first prompt of every session as well as at session start and every Nth prompt, so you see it even if the app skips the session-start message.
- It no longer stays silent when nothing is measured yet: it says grug is on and watching.

## 2.17.0

Headline count only what grug measured.

- The "GRUG SAVED" number and percentage now include only measured savings (text grug really cut out, minus grug's own costs). The handoff-after-/clear and prompt-cache figures are modeled estimates, so they are shown separately and never added in. Expect the percentage to drop.
- Dashboard shows a last-24-hours figure, a live "+$X while you watched" ticker, and two decimals under 10% so you can see it move.
- Status line and app summary use the same measured-only number.

## 2.16.0

A grug summary for the Claude desktop app, which draws no status line.

- **One-line summary in the chat.** A user-only message (costs no tokens, never sent to Claude): `🪨 grug │ saved ██▌░░░░░░░ ~25% (7d est., $120) │ context ███████░ 75% of /clear limit (90k) │ last: Trimmed npm output`. Shown at session start and every 8th prompt (`appSummary.everyPrompts`); turn off with `appSummary.enabled false`. It stays quiet until grug has measured something.
- **Plain-language dashboard.** Overview now reads like a sentence: "$X kept in your pocket, out of $Y you would have paid", an *In plain words* box (what drives your bill, whether the cache works, whether to `/clear`, grug's biggest help), friendlier row names ("Chat size re-read every reply", "Cache working?"), savings sources in everyday words, one health line in the header (`✓ grug is working` or what needs attention), and a clearer `%` glyph.
- Honest limits: the app shows it as a plain message, so there is no animation and no live bar; the bars are text and only refresh when the message is sent. The terminal `claude` still gets the animated status line, and `grug dash` the full live view.

## 2.15.0

Better handoff, and grug keeps the whole conversation so nothing is lost.

- **Handoff v2** (same 1200-token cap, filled by priority). Goal is now the *latest* substantive request (the first one is kept as "Started with"). New blocks: **Rules from the user** (your "never/always/don't" instructions and corrections), **Last check** (last test/build/lint command and whether it passed or FAILED), **Decisions and causes**. Low-value blocks (commands, files read) are dropped first when space is short. Still model-free, still heuristic.
- **Conversation archive.** Claude Code deletes its own transcripts after about 30 days. Grug now keeps a text-only copy (your messages and Claude's replies; no tool output, calls or thinking) in `~/.grug/archive`, capped by `memory.archiveMaxMb` (60), oldest sessions dropped first. Turn off with `memory.archive false`. It is never loaded into context.
- **Deep `history` search.** The `history` tool also searches archived sessions whose live transcript is gone. Hooks and auto-recall do not (no extra latency or tokens).
- **Standing rules are pinned.** "Always use pnpm", "never merge until I say" become auto-pinned notes that survive folding and lead the memory brief. At most 6 auto-pins, inside the fixed brief budget; your own `remember:` pins are untouched.
- Evaluated and not shipped: a local semantic (embedding-style) ranking layer. On real data it was no better than BM25 plus synonyms (lexical 7/10, semantic 5/10, fused 6/10 on paraphrase queries), so it was dropped.
- Token impact: handoff cap unchanged, brief budget unchanged, archive never injected. Limit: Claude must still choose to call `history`.

## 2.14.0

Status line becomes an always-on, animated grug panel.

- **Second row, always there.** Below the notice line: a moving pulse and spinner while Claude is producing a reply (calm when idle), a **savings bar** (`saved ▌░░░░ ~4%`, eighth-block resolution so a few percent still shows), a **context bar** against your /clear limit (green, yellow at 100%, red at 120%), and the latest grug action for 45 s (`✦ Trimmed npm output`). Alerts (cache cold or expiring, /clear) stay on the first row in colour.
- **Keeps moving.** Install sets Claude Code's `statusLine.refreshInterval` (default 2 s, `statusLine.refreshSeconds`, min 1), so timers and the animation update without waiting for an event. Re-run `grug install` (or `grug update`) to write it. Toggle the row: `statusLine.panel`.
- Honest limits: Claude Code draws the status line below the input box, and the animation is a 1-2 frames-per-second redraw, not a smooth video. The `saved` % is the same 7-day estimate as the dashboard headline.

## 2.13.0

Per-command output rules, compact JSON, MCP results handled like Bash output, a redesigned live dashboard and a status line.

- **New live dashboard.** 5 tabs (Overview, Savings, Activity, Memory, Advice), 120 ms animation (rotating donut chart of where savings come from, count-up headline, live pulse sparkline, "just now" flash, "synced Ns ago"), no flicker.
- **Headline savings %.** Big "grug saved ~N%" on the Overview: tokens kept out of context priced at your main model's input rate, plus cache savings grug added, minus grug's own costs. A conservative estimate, labelled as one. Also in `src/savings.ts` for reuse.
- **Status line notices.** `grug statusline` is installed as the Claude Code status line (wrapping yours, restored on uninstall): cache cold or expiring, `/clear` when context is over the limit, rotating tips, and `saved ~N%`. Claude Code draws the status line below the input box (it cannot be placed above). Toggle: `statusLine.enabled`.
- **New activity kinds** (`cmdrules`, `json`) in the dashboard and stats.

- **Install and build logs.** npm/pnpm/yarn, pip/uv/poetry, cargo, go, apt, brew, docker, git transfers and make/gradle/mvn print progress around the few lines that matter. Each family has its own list of progress lines; those are dropped (`... N progress lines omitted`) and deprecation notices become a count plus 3 samples. Any line that looks like a problem (error, fail, fatal, warning, denied, not found, conflict, vulnerability...) is never dropped. Only applied when at least 5 lines go and the output shrinks by 25% or more; otherwise untouched. Test runners keep their existing summary. Toggle: `commandRules.enabled`.
- **Compact JSON.** Uniform arrays of objects (20+ items, 12k+ chars, for example `gh api`, `curl`, MCP tools) keep the first 3 items in full and one identity line per remaining item; null/empty fields and `*_url` templates are dropped. Toggle: `commandRules.json`.
- **MCP tool results.** Big text results from MCP tools get the same trim and JSON compaction as Bash output (verified live: the model receives the rewritten result and the marker). Results with images are left alone. Toggle: `commandRules.mcp`.
- **Nothing is lost.** Every rewrite appends the path of the untouched original, so Claude can Read the exact text.
- **Measured honestly.** On real captured output: pip 3324 to 438 chars, cargo 1245 to 183. npm ci (365 B) and apt (207 B) are already terse and stay as they are. Install/build noise is usually a few KB per call, so expect a few percent of the bill, not a step change; it matters most on big builds, docker, go and cargo.

## 2.12.0

Trim long command output earlier without losing anything.

- **Earlier trim, nothing lost.** Output of noisy commands (build, test, install, logs) over 9000 chars (was 24000) is cut to head + tail, but the untouched original is saved to the session scratchpad (no permission prompt; grug's cache dir if there is none) and the marker says where, so Claude can Read the exact text with `offset`/`limit`. Lines that look like problems (error, fail, fatal, exception, warning, denied...) in the hidden part are kept (up to 20), so a failure in the middle is never hidden. Quality can only go up versus before: earlier, the cut part was gone.
- **Content you asked for is never cut early.** Commands whose output is the point (`cat`, `sed -n`, `grep`, `git diff/show/log`, `find`, `ls`, `jq`, `curl`...) keep the old 24000-char limit (`proxy.trimContentChars`). In this session every large Bash result was of this kind, so the early cut would have hidden code that was asked for.
- **Measured honestly.** Replayed on this session's real Bash results, the early cut alone saved 10.4% of Bash tokens, but nearly all of that was content-type output, which is now left alone. So expect well under 10% of Bash tokens on a session like this, and the real gain on build, install and test logs.

## 2.11.0

Make Claude use what grug already knows before it burns context exploring, and show (and fix) what fills the context.

- **Graph-first hints at tool time.** A `Grep` for a symbol the code graph knows now carries a note with where it is defined (`src/orders.ts L722-728`) so the next step is a ranged Read; it never blocks the search and appears once per symbol. A full `Read` of a mid-size code file (>= `graphContext.readHintBytes`, default 12 KB, where the outline is under 45% of the file) is asked once to Grep for the symbol / use the line ranges already in context and Read with `offset`/`limit` instead; repeating the Read goes through, and files Claude is editing are never asked. Toggle: `graphContext.hints`.
- **Hints point at the built-in ranged Read, not at MCP tools.** A live A/B showed why: steering Claude to `read_symbol` cost two `ToolSearch` calls to load the deferred MCP tools plus a failed Edit (Edit needs the file Read first; a ranged Read counts). Every hint, the session code map and the recall block now say "Grep, then Read with offset/limit". Measured live on an edit task (haiku, 4 grug runs vs 3 without): context 32.7k vs 47.4k tokens (-31%), cost $0.0255 vs $0.0567 (-55%), edit correct every time. This is a favourable case (one function in a 40 KB file); expect less on exploratory work.
- **Adoption is measured.** grug counts whether Claude used its tools or fell back to Read/Grep/Glob, and whether a hint was followed by a ranged read of that file (`~/.grug/adoption.json`, folded in at compaction/session end). Shown in `grug dash` ("graph-first hints") and `grug doctor`.
- **Explicit memory-first instruction.** The session brief now says: check these notes and the code map before re-exploring the repo or asking again (still: verify against the code).
- **New-task `/clear` suggestion.** When a prompt looks like a different job while the context is at least `taskBoundary.minTokens` (default 60k), grug tells you (user only) the size and cost per reply and suggests `/clear`; memory and the code map come back at session start and recall fetches what is relevant. Conservative on purpose: needs 4+ content words, no overlap with the session's recent prompts or files, no "also/now/and..." opening, 3+ earlier prompts, and not more than once per 8 prompts. On the labelled test set: 0 false alarms on 6 follow-ups, 4+ of 5 real switches caught. Toggle: `taskBoundary.enabled`.
- **What fills the context.** New `grug context [transcript]` breaks the current session's context down by kind (your messages, Claude text/thinking, tool calls, results per tool, images) since the last compaction, with the biggest single items. The size alert now says the top consumers ("Mostly: Bash results 41%, Read results 22%").
- Hook matchers now include `Grep` (pre) and `Glob` (post); run `grug update`.
- New validated settings: `graphContext.hints`, `graphContext.readHintBytes` (0 or 4000-60000), `taskBoundary.enabled|minTokens`.

## 2.10.0

Images, screenshots, PDFs and video. Measured in Claude Code 2.1: an image costs about 1 token per 880 pixels plus ~330 of overhead and is capped near 1.3 megapixels (~1.5k tokens). One image is cheap; the cost is that every image stays in the context and is re-read on each later reply (40 screenshots is ~60k tokens of context). So grug stops the repeats and offers cheaper ways in. Nothing here removes information: each rule skips a repeat of something already in context, or points at a cheaper route, and repeating the call always overrides it.

- **Duplicate-screenshot guard.** A screenshot (any MCP tool named like `*screenshot*`, or a computer-use style tool with `action: screenshot`) is skipped when it is identical to the last one and nothing changed since: no click/typing/other page-changing MCP call, no edit, no shell command. Read-only calls (snapshots, console, network) do not count as changes; a shot older than 2 minutes, or after compaction, is always allowed; ask again and it goes through. Verified live: the second identical screenshot was blocked, the one after a click was allowed.
- **One-time screenshot hint** (first screenshot per context): prefer text/DOM snapshots for state; screenshots for how it looks, once per batch of changes, cropped to what you need.
- **Duplicate image-Read guard.** Re-reading an unchanged image that is still in context is skipped once.
- **Big image files are read from a shrunken copy** (`mediaGuard.imageMaxEdge`, default 1200 px long edge, 0 = never): PNGs are resized by grug itself (pure JS, no dependencies), other formats through `sips` (macOS), ImageMagick or ffmpeg when present. The copy goes to Claude Code's session scratchpad (no permission prompt, original untouched), only for files inside the project, only on the first look in a context, and Claude is told; repeating the Read gives the full-size image. Measured live: about 350 tokens less on a 2400x1500 screenshot, and the model still read it correctly. The default of 1200 trades a little legibility for that saving; raise it (or set 0) for text-heavy screenshots.
- **PDFs, text first.** A Read of a PDF asking for more than `mediaGuard.pdfPages` (default 4) pages is pointed once at the new `pdf_text` tool (poppler's `pdftotext`, which Claude Code needs for PDF pages anyway): text pages cost a fraction of page images, and the tool lists pages with almost no text (scans, figures) to Read as images.
- **Video, frame sheets.** A Read of a video file is pointed once at `video_frames`: one contact-sheet image of up to 16 evenly spaced frames via ffmpeg, returned as an MCP image (no file Read, no prompt), costing about one image instead of one per frame.
- **`media_info`** tool: size, pages or duration, what reading it would cost, and the cheapest way in.
- **Image pile-up notice** (user only): when images in a context pass `mediaGuard.imageAlertTokens` (default 20k, then doubling) grug tells you the count, size and cost per reply, and suggests `/clear` or working from text snapshots.
- Dashboard row "media: repeats skipped/shrunk"; `grug doctor` shows the media guard and which optional helpers are installed (pdftotext, ffmpeg, sips, magick).
- The hook matchers now cover MCP tools (`Read|mcp__.*`); run `grug update` to pick them up.
- New settings (validated): `mediaGuard.enabled|dedupeScreenshots|dedupeImageReads|guidance|imageMaxEdge|pdfPages|imageAlertTokens`.

## 2.9.0

- **Recall finds paraphrases.** Prompt words with no direct hit can match through small concept groups of developer vocabulary (authentication~login, slow~latency, webhook~callback, cache~invalidate, ~30 groups) at 0.6 credit each; the relevance gate is unchanged, and unknown words invent nothing. Measured on an offline eval (`tests/recall-eval.test.ts`, corpus in `tests/recall-corpus.ts`): recall of paraphrased questions 25% → 90% on the tuning set and 50% → 60% on a hold-out written afterwards, false positives unchanged (1/16 and 0/12).
- **Long, multi-part prompts recall too.** A question followed by other instructions ("why does X expire? also tidy the docs…") used to score 0% because the extra words diluted the match. Each clause is now scored on its own as well as the whole prompt (each must clear the same gate by itself; counts are shared so it costs ~16 ms). Back to 90%/60% on compound prompts with no added noise; unrelated prompts with the same trailing instruction stay silent.
- **Cache-expiry notice.** When you return to a big session after the prompt cache expired (5 minutes, or an hour when Claude Code uses the long tier), the next reply re-writes the whole context at 1.25-2x the input price instead of reading it at 0.1x. grug tells you (user-only, never sent to Claude), with the cost, and has the handoff ready so `/clear` costs ~1k tokens instead. Only when the extra cost is at least `idleAlert.minExtraUsd` (default $0.25), once per idle gap. Toggle: `idleAlert.enabled`. Shown in `grug dash`.
- **Fix:** `grug remember <text> --dir <path>` (and `--port`, `--budget`, ...) no longer glues the flag's value onto the text.
- Verified end to end against a real Claude Code 2.1 session: hook context from SessionStart (code map) and UserPromptSubmit (recall) reaches the model.

## 2.8.0

- **Recall has a session budget.** Everything injected stays in context and is re-read every reply, so auto-recall now also has a per-session cap (`autoRecall.sessionTokens`, default 2500, reset after compaction). What is left caps each block, and the relevance bar rises as the budget fills: early prompts get generous recall, late ones only near-certain matches, and when it is spent grug goes quiet.
- **Recall tunes itself.** grug checks whether a code hint was useful: did Claude then read or edit the hinted file (built-in tools, or grug's `outline`/`read_symbol`/`read_lines`)? Scored once per session at PreCompact/SessionEnd into `~/.grug/recall-tune.json`. Hints mostly ignored raise the bar for code hints and earlier-session excerpts (up to ×1.6); hints mostly used lower it (down to ×0.8), in steps of 0.1 and only after 10 samples. `grug dash` and `grug doctor` show the hit rate and strictness.
- **Code graph stays fresh mid-session.** Files Claude edited or created are rescanned from disk when the next prompt is recalled, so a new function is findable at once; edits also trigger a debounced (45 s) background rescan (`grug warm --graph`). Deleted files are dropped instead of hinted.
- **Facts are captured as the session goes.** The Stop hook now scans only the transcript bytes not seen yet (saved offset, at most every 24 KB of growth) instead of one pass over the last 1 MB at the end, so decisions and root causes from early in a very long session are no longer lost. Handoff time still always scans. Per-session cap of 30 facts; nothing is captured twice.
- New setting `autoRecall.sessionTokens` (200-20000).

## 2.7.0

- **Auto-recall.** On every prompt grug now looks in memory, the code graph and your earlier conversations, and adds only what clearly matches (max 800 tokens, `autoRecall.maxTokens`), labelled "possibly relevant, verify before relying". Memory notes come first, then code locations, then excerpts from earlier sessions (your requests and decisions preferred). Skipped for trivial prompts ("ok", "yes", fewer than 3 content words), when nothing clears the relevance bar, or when the same item was already injected this session (reset after compaction). The current session is never searched: it is already in context. Toggle: `autoRecall.enabled`.
- **Better history search.** BM25-style scoring (rare words count more), user messages and decisions boosted, recent items slightly favored; grug's own injected blocks and harness noise are not indexed. Parsed transcripts are cached per file (size + mtime) and grown files are parsed incrementally, so big projects stay fast. A background `grug warm` refreshes caches at session start; hooks never block on a cold parse (80 ms budget).
- **Graph-first code context.** For code projects, session start injects a compact repo map (about 600 tokens, `graphContext.mapTokens`, hot files from memory rank higher) plus guidance to use `search`/`repo_map`/`outline`/`read_symbol`/`read_lines` before full-file Reads. Auto-recall also names the few files/symbols matching the prompt with line ranges (no bodies). Toggle: `graphContext.enabled`.
- **Better automatic memory.** At PreCompact/SessionEnd grug picks durable facts from the transcript by rules, no model call: decisions, root causes after failures, your standing preferences ("always/never/don't…"), and project commands that worked. Secrets are skipped. They go through the usual merge/decay, with their own cap of 60 auto facts per project (pinned notes never touched).
- **Dashboard and doctor** show auto-recall injections (count, average tokens), graph-context usage and captured facts.
- New settings validated by `grug config set`: `autoRecall.enabled|maxTokens` (100-4000), `graphContext.enabled|mapTokens` (100-3000). New command `grug warm [dir]`.

## 2.6.0

- **grug now compacts for you, automatically.** Claude Code has no way for a tool to run `/clear`, but it has its own auto-compaction; grug sets its trigger point (`autoCompactWindow` + `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, default 200k tokens instead of near the 1M limit). Right before compacting grug saves a handoff; right after, it injects it into the fresh context. Verified in a real Claude Code session: auto-compaction fired on its own, grug restored a 120-token handoff, and the answer that depended on pre-compaction content was still correct, with each later reply at ~40k tokens instead of 100k+. `grug config set autoCompact.windowTokens 0` hands control back to Claude Code; uninstall restores your previous values.
- **`history` MCP tool:** Claude searches this project's full earlier conversations (including what was compacted or cleared) and gets only the matching excerpts: user requests, decisions, errors, command output. Handoffs point Claude at it instead of guessing.
- **Subagent model routing (opt-in):** `grug config set routing.subagentModel sonnet` sets `CLAUDE_CODE_SUBAGENT_MODEL` so search/exploration subagents run on Sonnet 5.5 while your main conversation stays on Opus.
- `grug config set autoCompact.*|routing.*` applies to Claude Code immediately.
- Context alert only fires if context grows past 1.2× the compaction point (i.e. compaction isn't happening); handoff context size now counts pending tool results; debug log lines stay valid JSON.

## 2.5.0

- **Handoffs instead of `/compact`.** `/compact` sends the whole conversation to the model again to summarize it. With grug, just type `/clear` (free): grug writes a handoff from what it already recorded (goal, latest requests, open todos, where it got to, files changed/read, recent commands; no model call) and the fresh session starts from it: ~1k tokens instead of the old context. Also written at session end and on context alerts; used once, by the next session in the same project.
- **Context-size alert.** When a session's context passes 150k tokens (then 300k, 600k…), Claude Code shows you a one-line notice with the size and ~cost per reply, suggesting `/clear` with a handoff. Shown to you only, never sent to Claude.
- **Dashboard:** cost per reply and average context per reply; handoffs and alerts in "what grug did"; advice when average context is large (the biggest cost driver on real installs).
- **Config validation:** `grug config set` rejects invalid values (enums, booleans, numbers) and warns about `# comments` typed in zsh; bad values saved by older versions are repaired on load.
- New settings: `contextAlert.enabled` / `contextAlert.firstTokens`, `handoff.enabled` / `handoff.maxTokens` / `handoff.maxAgeHours`.

## 2.4.1

- Usage appears right away: `grug doctor`, `grug dash` and the background service (every 30 min) catch up on recent Claude Code transcripts in `~/.claude/projects`, so numbers don't wait for the next reply and nothing is lost if a hook times out. Offsets are shared per transcript file with the Stop hook, so nothing is counted twice.

## 2.4.0

- **Measures real usage from Claude Code session transcripts.** The Claude desktop app's Code tab manages its own API connection and never goes through grug's proxy; grug now reads each reply's exact token usage from the session transcript (via the Stop/SessionEnd/PreCompact hooks): spend, cache hits and savings show up in `grug dash` for every session. Replies are de-duplicated, only new bytes are read, and traffic the proxy already recorded is never counted twice.
- **`grug doctor --fix` removes leftovers of uninstalled tools**: hooks, status lines and MCP servers whose program no longer exists (e.g. after uninstalling caveman), with backups. Plain `grug doctor` lists them.
- Doctor reports proxied calls and transcript-measured replies separately; the "bypass" warning only fires when neither sees usage.
- Wider dashboard columns.

## 2.3.2

- `grug doctor` and the dashboard warn when Claude Code sessions run but none of their API calls reach grug's proxy (e.g. another proxy tool owns `ANTHROPIC_BASE_URL`), instead of showing all green.
- The update check ignores a cached "latest" that is older than the installed version (left by an earlier version), so updates are never hidden.

## 2.3.1

- Update check survives GitHub API rate limits (HTTP 403): falls back to the `github.com/…/releases/latest` redirect to find the newest tag and its release file. Failed checks retry after an hour, not a day.

## 2.3.0

- `grug update` now installs the newest release directly (`grug update --check` only looks).
- New-version notice at the start of every Claude Code session (shown to you only; costs no tokens), plus an update line in `grug doctor`.
- Verified: the unversioned `npx github:swaraj792725/grugbrain install` re-checks GitHub on every run and installs the newest version.

## 2.2.1

- Fix: installing via `npx` skipped creating the `grug` command, because npx's temporary copy looked like an existing install ("`grug` already on PATH (…/_npx/…)"). npx/npm temporary folders are now ignored, so `grug` is linked for real.

- Install docs lead with `npx github:swaraj792725/grugbrain install` (works without npm). Release notes show the tag, file and npm commands.
- A failed npm publish no longer marks the GitHub Release job as failed; it shows a warning and can be retried from the Actions tab.

## 2.2.0

- **Repository renamed to `swaraj792725/grugbrain`** (old `token-diet` URLs redirect). The old GitHub Packages package `@swaraj792725/token-diet` (v1) is discontinued.
- **Published on npm**: `npm install -g grugbrain && grug install` (or `npx grugbrain install`).
- `grug update` follows GitHub redirects and installs from npm when the release is there.
- The installer leaves an npm-global `grug` command alone instead of adding a second one.

## 2.1.1

- **`grug` command now lands on your PATH** after install (it only ran through `npx` before). The installer links `grug`/`grugbrain` into a writable PATH folder (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, `~/bin`) or adds `~/.grug/bin` to `~/.zshrc`/`~/.bashrc` with a marked line. Foreign files are never overwritten; `grug uninstall` removes it all.
- `grug doctor` shows the command status and whether the upstream (e.g. a chained gateway) is reachable.

## 2.1.0

- **Test/build output summarizer**: jest, vitest, mocha, pytest, go test, cargo, TAP, rspec, phpunit and tsc output collapses to every failure (assertion, diff, code frame) plus the summary; passing noise is dropped. Runs at the source (PostToolUse) and in the proxy.
- **Re-read guard** (off by default): skips an unchanged re-read once. `grug bench` showed Claude Code ≥ 2.1 already does this natively, so it's opt-in for older versions/other clients.
- **Cache-miss detective**: the proxy names what broke the prompt cache (model switch, tool list, system prompt diff with timestamp detection, edited history, idle expiry) and how many tokens it re-wrote.
- **`grug bench`**: warm-up + alternating order so prompt-cache timing can't fake savings; first real run: quality 8/8 vs 8/8, cost −11% overall, −35% on noisy test output. A/B real Claude Code runs (grug off vs on) on generated repos with objective checks; reports quality, cost and tokens side by side.
- **Versions from GitHub**: `grug update [--install]`, daily notify-only check in the daemon, release workflow that tags, attaches the installable tarball and publishes.
- Proxy reads gzip/brotli/deflate request bodies (Claude Code can compress them).
- Cost math prices 1-hour cache writes at 2x (5-minute writes 1.25x).
- `GRUG_DISABLE=1` turns every hook into a no-op; `GRUG_DEBUG=1` logs raw hook input.
- PostToolUse replacements now match the tool's own shape (`{stdout, stderr, ...}` for Bash); verified that Claude Code applies them.
- Dashboard shows the latest bench result, cache-miss culprits and available updates.

## 2.0.0

- Rebuilt as `grugbrain`: API proxy (cache autopilot, trimming, dedupe, real usage stats, fail-open), Claude Code hooks (memory brief, recall, read guard, terse output), self-maintaining memory graph with Obsidian vault and interactive graph, MCP tools, `grug dash` TUI, safe installer.
