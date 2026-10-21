---
name: grug-brainstorm
description: Use before building something new or changing behavior when the request is open or vague (a feature, component, tool, plan). Turns the idea into an agreed short design before any code.
---

# Brainstorm (grug way)

Goal: agree what to build before building. Cheap questions now beat expensive rewrites later.

1. Look first. Skim only what the idea touches: Grep for names, Read with offset/limit. Do not read the whole repo.
2. Ask questions one at a time, most important first. Prefer multiple choice. Stop asking once purpose, users, constraints and "done" are clear (usually 2-5 questions). If the request is already clear, skip to step 3.
3. Offer 2-3 approaches, each with one line of trade-offs. Recommend one and say why.
4. Write the design in short sections (data, flow, interfaces, errors, tests). Keep each section a few lines; ask "right so far?" after the risky parts, not after every section.
5. YAGNI: cut anything not needed for the first working version. Say what was cut.
6. Save the agreed design only if the work spans sessions (docs/designs/<date>-<topic>.md); otherwise keep it in the chat.
7. Next: grug-plan for multi-step work, or just do it if it is small.

Never start writing code during this skill.
