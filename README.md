# 🥗 Token Diet (`@swaraj792725/token-diet`)

> **Put Claude on a Token Diet.**  
> Zero-touch, system-wide token optimizer & context compressor for **macOS Claude Desktop**. Install once, forget forever, and automatically slash **70%+ tokens** across all future Claude sessions. Get **5x the value out of your $20/month Claude Pro plan**!

---

## ⚡ Quick 10-Second Install

Open Terminal on your Mac and run:

```bash
npx @swaraj792725/token-diet install
```

> **Done!** Restart your Claude Desktop app. `token-diet` is now active in the background for **100% of your sessions**. You never have to configure or run it manually again.

---

## 🧐 How Does It Work?

When you use Claude Desktop with large codebases or long chats, your context window fills up rapidly with:
1. **Conversational fluff** ("Could you please help me write...", "In order to achieve this...", polite padding).
2. **Gigantic source files** sent in full (2,000–10,000 tokens per file) just to inspect one function.
3. **Flat multi-file dumps** where Claude reads dozens of files without understanding project architecture.
4. **Repeated context re-evaluations** that miss Anthropic's KV prompt cache discount.

### The 4-Pillar Token Diet Engine:

```
┌────────────────────────────────────────────────────────┐
│                   TOKEN DIET ENGINE                    │
├─────────────────┬──────────────────┬───────────────────┤
│ 🪨 CAVEMAN      │ 🕸️ GRAPHIFY       │ 💀 SKELETONIZER   │
│ Prompt Fluff    │ Codebase Topology│ Function Bodies   │
│ -40% to -70%    │ -98% File Dumps  │ -80% AST Signatures│
├─────────────────┴──────────────────┴───────────────────┤
│           🏷️ ANTHROPIC PROMPT CACHE OPTIMIZER          │
│        Cache Boundaries -> 90% Cost / Token Discount   │
└────────────────────────────────────────────────────────┘
```

1. **🪨 Caveman Context Compression**: Inspired by the famous `caveman` technique. It algorithmically detects and removes redundant pleasantries, boilerplate, and repetitive formatting while keeping 100% of code blocks, identifiers, and technical semantics intact. Saves **40%–70%** tokens per turn.
2. **🕸️ Graphify Topology Indexer**: Inspired by `graphify`. Instead of feeding Claude 50 raw files (costing 50,000+ tokens), Graphify builds an in-memory topological dependency graph of your project (<1,000 tokens) showing file linkages, imports, and exports. Saves **up to 98%** on repository inspection.
3. **💀 AST Symbol Skeletonizer**: Reads TypeScript, JavaScript, Python, Go, and Rust files and replaces implementation bodies (`{ /* implementation hidden */ }`) with pure interface signatures, type definitions, and class declarations. Saves **75%–85%** tokens when navigating code.
4. **🏷️ Anthropic Prompt Cache Injection**: Automatically formats context blocks exceeding 1,024 tokens with Anthropic's `cache_control: { type: "ephemeral" }` boundaries. Claude Desktop reuses KV caches, yielding a **90% discount** on prompt processing.

---

## 💥 How Powerful Is It?

| Scenario | Standard Claude Desktop | With Token Diet (`@swaraj792725/token-diet`) | Savings |
|---|---|---|---|
| **Reading 10 Source Files** | ~25,000 tokens | ~3,500 tokens (AST Skeletonizer) | **86% Saved** |
| **Exploring Project Architecture** | ~60,000 tokens (full files) | ~1,200 tokens (Graphify Topology) | **98% Saved** |
| **Multi-Turn Chat History & Prompts** | ~8,000 tokens | ~2,800 tokens (Caveman Compression) | **65% Saved** |
| **Repeated Prompt Turns** | 100% token cost | 10% token cost (Anthropic Prompt Caching) | **90% Discount** |
| **Monthly Limit Longevity ($20 Pro)** | Hits limit in ~3–4 hours of heavy coding | **Runs for days without hitting message caps (5x longevity)** | **5x Value** |

---

## 🛠️ CLI Utilities

Check your lifetime savings or use the compression tools directly from terminal:

```bash
# Check installation status & lifetime tokens saved
npx @swaraj792725/token-diet status

# Compress a prompt or context block directly
npx @swaraj792725/token-diet compress "Could you please make sure to optimize this function in order to save costs?"

# Generate a knowledge graph for any codebase
npx @swaraj792725/token-diet graph ./src

# Uninstall
npx @swaraj792725/token-diet uninstall
```

---

## 📋 System Requirements & Compatibility

- **macOS** (Apple Silicon M1/M2/M3/M4 or Intel)
- **Claude Desktop App** (automatically detects `~/Library/Application Support/Claude/claude_desktop_config.json`)
- **Node.js**: $\ge 18$

---

## 📜 License

MIT © [swaraj792725](https://github.com/swaraj792725)
