# `@swaraj792725/claude-token-saver`

> Zero-touch, system-wide token optimizer & context compressor for **macOS Claude Desktop**. Install once, forget forever, and save **70%+ tokens** across all future Claude sessions automatically. Get **5x value out of your $20/month plan**!

---

## 🚀 Key Features

- **⚡ Zero-Touch System Injection**: Automatically installs into `~/Library/Application Support/Claude/claude_desktop_config.json`.
- **🪨 Caveman Context Compression**: Strips conversational fluff, polite fillers, and boilerplate while preserving 100% of exact code blocks and syntax. (Saves 40–70% tokens).
- **🕸️ Graphify Topology Indexer**: Converts multi-file directories into ultra-compact topological knowledge graphs (<1,000 tokens instead of 50,000+ raw file tokens). (Saves 98% tokens).
- **💀 AST Symbol Skeletonizer**: Strips function/method implementation bodies while preserving top-level imports, classes, interfaces, function signatures, and docstrings. (Saves 75–85% tokens).
- **🏷️ Anthropic Prompt Caching Optimizer**: Auto-formats large context blocks into 1024-token ephemeral cache boundaries so Claude Desktop hits KV prompt cache (90% discount).
- **📊 Running Token Savings Tracker**: Persists lifetime token savings statistics across all desktop sessions.

---

## 📦 Quick Start & One-Touch Install

Run this single command in your macOS terminal:

```bash
npx @swaraj792725/claude-token-saver install
```

That's it! Restart your Claude Desktop app. `claude-token-saver` is now running silently in the background for **all** your sessions.

---

## 🛠️ CLI Commands

```bash
# Check installation & lifetime savings stats
npx @swaraj792725/claude-token-saver status

# Compress a prompt or text block manually
npx @swaraj792725/claude-token-saver compress "Could you please make sure to rewrite this function in order to reduce tokens?"

# Generate a compact knowledge graph for a directory
npx @swaraj792725/claude-token-saver graph ./src

# Uninstall from Claude Desktop config
npx @swaraj792725/claude-token-saver uninstall
```

---

## 📄 Programmatic API

```typescript
import { cavemanCompress, skeletonizeCode, graphifyDirectory, optimizeForPromptCaching } from '@swaraj792725/claude-token-saver';

// Compress prompt text
const compressed = cavemanCompress('Please make sure to review this code');
console.log(compressed.tokensSaved);

// Skeletonize AST
const skeleton = skeletonizeCode(rawCode, 'app.ts');
console.log(skeleton.skeletonCode);
```

---

## 📜 License

MIT © [swaraj792725](https://github.com/swaraj792725)
