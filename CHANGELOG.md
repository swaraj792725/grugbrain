# Changelog

Grug keep list of what change. Newest on top. Each `## x.y.z` section becomes the GitHub Release notes.

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
