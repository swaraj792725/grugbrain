---
name: grug-explore
description: Use when you need to learn an unfamiliar codebase or find where something lives before changing it. Finds the answer with few, small reads instead of opening whole files.
---

# Explore (grug way)

Each file you open stays in context and is re-sent with every later reply. Read little, read once.

1. Start from what you already have: the code map or recall notes at the top of the conversation, the README's first screen, the manifest (package.json, pyproject.toml, go.mod) for entry points and scripts.
2. Search before reading: grep for the symbol, error text or route name. Batch independent searches in one reply.
3. Read ranges, not files: open only the lines around a hit (about 40-80 lines). Widen only if the range cuts off what you need.
4. Follow one thread: caller -> function -> callee. Stop when you can answer the question; do not tour the repo.
5. Broad sweeps (many folders, naming conventions, "where is X used everywhere"): give them to a search subagent if one exists, and ask for paths and line numbers only, not file dumps.
6. Never re-read a file you already read and did not change; scroll up instead.
7. Write down what you learned in 3-5 lines (files, key functions with line numbers, how they connect) before you start editing, so later steps do not need to look again.

Done when: you can name the exact files and line ranges to change, and why.
