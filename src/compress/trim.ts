/**
 * Tool-output trimmer. Deterministic (same input -> same output) so prompt-cache prefixes stay stable.
 *  1. strip ANSI colour codes and carriage-return progress spam
 *  2. collapse runs of identical lines into one line + count
 *  3. if still huge, keep head + tail and say exactly what was cut
 * File reads (line-numbered output) are never altered: Claude asked for that content.
 */

export interface TrimOptions {
  thresholdChars: number;
  keepHeadChars: number;
  keepTailChars: number;
}

export interface TrimResult {
  text: string;
  changed: boolean;
  removedChars: number;
}

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(\u0007|\u001b\\)/g;

export function looksLikeFileRead(text: string): boolean {
  const head = text.slice(0, 600).split('\n').slice(0, 5);
  let numbered = 0;
  for (const l of head) if (/^\s*\d+(\t|→)/.test(l)) numbered++;
  return numbered >= Math.min(3, head.length);
}

export function trimToolOutput(text: string, opts: TrimOptions): TrimResult {
  if (!text || text.length < 400 || looksLikeFileRead(text)) {
    return { text, changed: false, removedChars: 0 };
  }
  let t = text.replace(ANSI_RE, '');
  // Progress bars: keep only what survives the last \r on each line.
  t = t
    .split('\n')
    .map((l) => {
      const parts = l.split('\r');
      return (parts.length > 1 ? parts.filter((p) => p !== '').pop() || '' : l).replace(/[ \t]+$/, '');
    })
    .join('\n');

  // Collapse runs of identical lines.
  const lines = t.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; ) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i]) j++;
    const run = j - i;
    if (run >= 3 && lines[i].trim() !== '') out.push(`${lines[i]}  [×${run}]`);
    else for (let k = i; k < j; k++) out.push(lines[k]);
    i = j;
  }
  t = out.join('\n').replace(/\n{4,}/g, '\n\n\n');

  if (t.length > opts.thresholdChars) {
    const headEnd = t.lastIndexOf('\n', opts.keepHeadChars);
    const tailStart = t.indexOf('\n', t.length - opts.keepTailChars);
    const h = headEnd > 0 ? headEnd : opts.keepHeadChars;
    const s = tailStart > h ? tailStart : t.length - opts.keepTailChars;
    const cut = t.slice(h, s);
    const cutLines = cut.split('\n').length;
    t =
      t.slice(0, h) +
      `\n\n[grug: ${cutLines} lines (${cut.length} chars) of repetitive/long output hidden here. ` +
      `Re-run a narrower command (grep, head, tail, sed -n) if you need them.]\n\n` +
      t.slice(s);
  }
  return { text: t, changed: t !== text, removedChars: Math.max(0, text.length - t.length) };
}
