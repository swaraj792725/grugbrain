# 🪨 grugbrain

> why use many token when few token do trick

**grug make Claude use few token. grug remember for Claude. grug do alone. you do nothing.**

Install once. grug sit between Claude Code and Anthropic API, trim fat, stick cache, guard big files, remember every session in small brain that never get fat. grug draw brain picture. grug write Obsidian notes. grug show cave dashboard.

```bash
npx grugbrain install
```

Restart Claude Code (and Claude Desktop). Done. Grug work now. Forever. No reminders.

> Not on npm yet? Grug also install straight from GitHub:
> `npx github:swaraj792725/token-diet install`

---

## grug see problem

Claude burn token on:

| fat | how much | what grug do |
|---|---|---|
| same big prompt sent every turn, no cache | pay 100% each turn | **cache autopilot**: add cache breakpoints when app forget. Cache read cost 0.1×. |
| giant `npm test` / log / build output | 10k–100k token each | **trim**: strip colour junk, squash repeat lines (`[×50]`), keep head + tail, say what cut |
| same tool output twice in one chat | pay twice | **dedupe**: second copy become pointer to first |
| `Read` whole 5,000-line file to find one function | ~30k token | **read guard**: say "grep first, read range". Ranged read always allowed. |
| exploring repo file by file | 20–60k token | **repo map / outline / read_symbol** MCP tools: signatures, not bodies |
| Claude chatty: preamble, recap, "let me know!" | output cost 5× input | **terse mode**: short answer. `full` = caveman talk. Code never shortened. |
| every new session re-learn project from zero | many turn, many token | **memory**: small brief at start, recall on prompt, fixed budget |

grug **measure**, not guess. Proxy read real `usage` from every API reply (input, output, cache read, cache write). Dashboard show real dollars. Things grug can only estimate (trim, read guard) say *estimate* on label.

---

## grug brain (memory that never get fat)

Normal memory file grow, grow, grow. Every session pay for all of it. Bad.

grug brain is **graph**: projects · sessions · files · topics · notes · digests.

- **auto capture**: hooks log prompts, files touched, commands, final answer. You type `remember: we deploy with fly.io` → pinned note.
- **auto notes**: grug pick sentences like "root cause was…", "decided…", "never…" from Claude's last answer.
- **decay**: every node lose score over time (half-life 14 days) unless used again.
- **fold**: sessions older than 21 days squash into one monthly **digest** per project. Old buffers deleted.
- **merge**: near-same notes become one note.
- **cap**: max 400 nodes per project; weakest go first. Pinned notes stay.
- **budget**: session brief ≤ 700 token, per-prompt recall ≤ 250 token, and only when something clearly match. Already-said things not repeated.

So: day 1 or day 300, context cost per session stay **flat**. Knowledge carry forward. That the multiplier.

```text
[grugbrain memory: shop-api, 23 past session(s). Auto-maintained; trust but verify against the code.]
Last session (2h ago): "fix the stripe webhook retries"
  ended with: Root cause was a missing await in src/stripe/webhook.ts; fixed by awaiting before commit.
Remembered:
- Never call Stripe from a DB transaction; enqueue instead
Hot files: src/checkout.ts, src/stripe/webhook.ts, src/orders.ts
```

### grug draw brain

```bash
grug graph
```

Open interactive graph (one HTML file, no internet): drag, zoom, search, filter by project/type, click node for detail. Auto-redrawn after each session at `~/.grug/graph.html`.

![memory graph](docs/memory-graph.png)

### grug write Obsidian

Brain also written as markdown with `[[wikilinks]]` + frontmatter at `~/.grug/vault/grugbrain/`. Open in Obsidian → *Open folder as vault*. Graph view just work.

Want it inside your own vault?

```bash
grug config set memory.vaultDir ~/Documents/MyVault
```

grug only write in `MyVault/grugbrain/` and only delete files grug made (they carry `generator: grugbrain`). Your notes safe.

---

## grug cave dashboard

```bash
grug dash
```

```text
 🪨 grugbrain v2.0.0   proxy ● up :4747  hooks ✓  code-mcp ✓  desktop ✓  terse lite
 1 Overview  2 Activity  3 Memory  4 Advice                                    10:42:07
────────────────────────────────────────────────────────────────────────────────────
MEASURED  real API usage through the proxy
                                         24h      7 days    all time
  requests                                84         612       2,410
  spend                                $3.12      $21.40      $88.10
  saved by prompt cache (all)          $9.80      $61.22     $240.51
    …where grug added the cache        $0.00       $1.10       $6.40
  cache hit rate (7d)           ███████████████████░░░░░ 79%

WHAT GRUG DID  (token counts here are estimates)
  trimmed long tool output          ~412k tok       96×
  deduped repeated tool results     —               14×
  redirected huge full-file reads   ~188k tok       11×
  outlines instead of full files    ~61k tok        40×
  memory briefs + recalls (cost)    -9.8k tok       57×  context carried over
14-DAY  spend ▂▃▅▂▁▇▃▄▅▃▂▆▄▃   cache-saved ▃▄▆▃▂█▄▅▆▄▃▇▅▄
PROJECTION  at 7-day pace: $91.71/mo, without grug's changes ≈ $104.20/mo
```

- **1 Overview**: what grug did (measured + estimated), 14-day sparkline, monthly projection
- **2 Activity**: live log of every action (trim, guard, cache, brief, recall, fold…)
- **3 Memory**: projects, sessions, digests, notes, hot files, graph + vault paths (`g` opens graph)
- **4 Advice**: what grug *would* do but can't do alone: low cache hit rate, too much top-tier model spend (with $ estimate), terse mode, broken install

`grug dash --once` print it all without the TUI (for scripts / CI).

---

## where grug work

| app | what grug do |
|---|---|
| **Claude Code** (CLI, IDE, desktop app's Code tab) | everything: proxy (cache, trim, dedupe, real stats), hooks (memory, read guard, terse), MCP tools |
| **Claude Desktop** chat | MCP tools (`outline`, `read_symbol`, `repo_map`, `search`, `recall`, `remember`, `project_brief`…) + shared memory. Desktop's own API calls are private, so no proxy, no measured stats. |
| **claude.ai** in browser | nothing. grug cannot reach inside browser. grug honest. |
| your own app on the Anthropic SDK | set `ANTHROPIC_BASE_URL=http://127.0.0.1:4747` → proxy + stats |

Pro/Max subscription or API key: both fine. Proxy pass auth headers through untouched. On a subscription you are limited by usage, not billed per token, so "$" in dashboard mean *API-equivalent value*. Fewer token still mean you hit limits later.

---

## grug safety rules

- **fail open**: transform throw → original request sent. Upstream say 400 to optimized request → grug resend original untouched, log `fallback`.
- **deterministic**: same conversation → same bytes → cache prefix stay stable.
- **never touch** assistant turns or thinking blocks. Never add cache breakpoints when app already manage cache (Claude Code does).
- **file reads never trimmed**: Claude asked for that content.
- **config safety**: every file backed up to `~/.grug/backups/` first. Broken JSON config? grug **refuse to write** and tell you. Writes atomic.
- **absolute paths**: Mac GUI apps don't see your shell `PATH`; grug use full node path.
- **keep your gateway**: already have `ANTHROPIC_BASE_URL`? grug chain to it, restore it on uninstall.
- **always alive**: launchd (macOS) / systemd `--user` (Linux) keep daemon up; SessionStart hook restart it if needed. `grug doctor` check all.
- **local only**: no telemetry. Data live in `~/.grug`.

---

## grug commands

```text
grug install [--no-proxy] [--no-desktop] [--no-code] [--no-service]
grug dash [--once]              TUI dashboard
grug doctor                     check everything, say how to fix
grug uninstall [--purge]        remove (keeps memory unless --purge)

grug graph                      open memory graph
grug vault                      rebuild Obsidian vault, print path
grug brief [dir]                what grug would tell Claude about a project
grug recall <query>             search memory
grug remember <text>            pin note for current project
grug maintain                   ingest + consolidate now (normally automatic)

grug map [dir] [--budget 1500]  ranked repo map under token budget
grug outline <file>             skeleton of a source file
grug compress <text | ->        strip filler from text you'll reuse (e.g. system prompt)

grug config                     show config
grug config set <key> <value>   e.g. terse full · readGuard.maxBytes 100000 · memory.briefTokens 500
grug savings                    one-line summary
```

### config grug understand

| key | default | what |
|---|---|---|
| `terse` | `lite` | `off` · `lite` (concise) · `full` (caveman talk) |
| `port` | `4747` | proxy port |
| `upstream` | `https://api.anthropic.com` | where proxy forward to |
| `proxy.autoCache` | `true` | add cache breakpoints when client set none |
| `proxy.trimToolResults` | `true` | trim giant tool output |
| `proxy.dedupeReads` | `true` | replace repeated identical tool outputs |
| `proxy.trimThresholdChars` | `24000` | trim only above this |
| `readGuard.enabled` / `maxBytes` | `true` / `60000` | redirect full reads of bigger files |
| `memory.enabled` | `true` | memory capture + brief + recall |
| `memory.briefTokens` / `recallTokens` | `700` / `250` | hard budgets |
| `memory.halfLifeDays` / `foldAfterDays` / `maxNodesPerProject` | `14` / `21` / `400` | how grug forget |
| `memory.vaultDir` | `~/.grug/vault` | Obsidian output |

---

## grug honest about limits

- Claude Code already cache well. There grug's cache autopilot mostly idle; real wins are trim, read guard, memory, terse, advice. Dashboard split "cache saved (all)" from "where grug added cache" so grug not steal credit.
- Memory notes come from rules, not an LLM. Good at "what files, what asked, how it ended, what you told it to remember". Not perfect summaries. Zero extra API cost.
- Trim and read-guard savings are estimates (chars ÷ ~3.6). Cache savings and spend are real numbers from the API.
- Model routing (Opus → Sonnet/Haiku) is advice only. grug never switch your model behind your back.

---

## for the grug who publish (maintainer)

`E404 Not Found - GET https://registry.npmjs.org/...` mean package never published to public npm (old setup pushed to GitHub Packages, which `npx` don't read). Fix:

1. Make npm account → create **Automation** access token.
2. GitHub repo → Settings → Secrets → Actions → add `NPM_TOKEN`.
3. Bump version in `package.json`, then create a GitHub Release (or push tag `v2.0.0`). Workflow `publish.yml` test, build, publish with provenance.

Or by hand: `npm login && npm publish --access public`.

Dev:

```bash
npm install
npm test          # vitest, sandboxed HOME, never touch your real config
npm run typecheck
npm run build     # dist/cli.js is one self-contained file
```

MIT © swaraj792725
