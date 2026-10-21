---
name: grug-skill
description: Use when the user wants a new skill (a reusable how-to for the agent) or wants to change one, before writing SKILL.md. Keeps it short and checks that it is actually followed.
---

# Write a skill (grug way)

Every skill's description is sent with every reply; the body is sent each time it is used. Short wins.

1. Collect 2-3 real cases where the agent got it wrong or wasted turns. No real case, no skill.
2. Write the description first (one sentence, under 300 characters): "Use when <trigger>, before <action>." Name the situation, not the technique. It decides when the skill loads.
3. Body: a numbered list of what to do, in order, under ~2,000 characters. Rules the agent tends to skip get the reason in a few words. Cut background, history and examples it does not need.
4. Name things the agent can act on: commands, file paths, tool names, what "done" looks like.
5. Folder: `<skills dir>/<name>/SKILL.md` with frontmatter `name` (equal to the folder name) and `description`.
6. Test it: run one of the real cases again with the skill in place (a fresh session or subagent). Check the skill loaded and each step was followed. Where the agent skipped or bent a step, make that step plainer or give its reason, then test again.
7. Remove it if it is not used after a couple of weeks; an unused skill still costs its description on every reply.
