# Changelog

Grug keep list of what change. Newest on top. Each `## x.y.z` section becomes the GitHub Release notes.

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
