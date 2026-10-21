/**
 * `<private>...</private>` in a prompt: the model still sees it (it is in the conversation), but grug
 * never keeps it: not in memory, facts, the handoff, the archive, or history search. An unclosed tag
 * hides the rest of the text.
 */
const PRIVATE = /<private>[\s\S]*?(?:<\/private>|$)/gi;

export function stripPrivate(text: string): string {
  return typeof text === 'string' && /<private>/i.test(text) ? text.replace(PRIVATE, '[private]') : text;
}

function deepStrip(v: any): any {
  if (typeof v === 'string') return stripPrivate(v);
  if (Array.isArray(v)) return v.map(deepStrip);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deepStrip(x)]));
  return v;
}

/** A transcript entry with private parts of its text (prompt, reply, tool calls and results) replaced. */
export function scrubEntry(e: any): any {
  const m = e?.message;
  if (!m) return e;
  if (typeof m.content === 'string') m.content = stripPrivate(m.content);
  else if (Array.isArray(m.content))
    m.content = m.content.map((b: any) => {
      if (!b || typeof b !== 'object') return b;
      if (typeof b.text === 'string') return { ...b, text: stripPrivate(b.text) };
      if (typeof b.content === 'string') return { ...b, content: stripPrivate(b.content) };
      if (Array.isArray(b.content)) return { ...b, content: b.content.map((x: any) => (typeof x?.text === 'string' ? { ...x, text: stripPrivate(x.text) } : x)) };
      if (b.input && typeof b.input === 'object') return { ...b, input: deepStrip(b.input) };
      return b;
    });
  return e;
}

/** Parse one transcript line, scrubbing private text (cheap check first). */
export function parseEntry(line: string): any {
  const e = JSON.parse(line);
  return /<private>/i.test(line) ? scrubEntry(e) : e;
}
