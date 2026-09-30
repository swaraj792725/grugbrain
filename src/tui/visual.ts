/** Terminal drawing helpers for the dashboard: big digits, a braille donut chart, spinner, colours. Pure and testable. */

const tty = () => !process.env.NO_COLOR && !!process.stdout.isTTY;
export const fg = (n: number) => (s: string) => (tty() ? `\x1b[38;5;${n}m${s}\x1b[0m` : s);
export const boldFg = (n: number) => (s: string) => (tty() ? `\x1b[1;38;5;${n}m${s}\x1b[0m` : s);

/** Distinct, colour-blind-friendly-ish 256-colour palette, one per saving source. */
export const PALETTE = [114, 75, 214, 176, 203, 80, 147, 221, 141];

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const DIGITS: Record<string, string[]> = {
  '0': ['█▀█', '█ █', '█ █', '█ █', '▀▀▀'],
  '1': [' █ ', '██ ', ' █ ', ' █ ', '███'],
  '2': ['▀▀█', '  █', '▄▀▀', '█  ', '███'],
  '3': ['▀▀█', '  █', ' ▀█', '  █', '▀▀▀'],
  '4': ['█ █', '█ █', '███', '  █', '  █'],
  '5': ['███', '█  ', '▀▀█', '  █', '▀▀▀'],
  '6': ['█▀▀', '█  ', '███', '█ █', '▀▀▀'],
  '7': ['███', '  █', ' █ ', ' █ ', ' █ '],
  '8': ['█▀█', '█ █', '█▀█', '█ █', '▀▀▀'],
  '9': ['█▀█', '█ █', '▀▀█', '  █', '▀▀▀'],
  '%': ['██  █', '██ █ ', '  █  ', ' █ ██', '█  ██'],
  '.': ['   ', '   ', '   ', '   ', ' █ ']
};

/** 5-row block digits for a headline number. */
export function bigText(text: string): string[] {
  const rows = ['', '', '', '', ''];
  for (const ch of text) {
    const g = DIGITS[ch] || DIGITS['0'];
    for (let i = 0; i < 5; i++) rows[i] += g[i] + ' ';
  }
  return rows.map((r) => r.replace(/\s+$/, ''));
}

const BRAILLE_BIT = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80]
];

export interface Slice {
  value: number;
  color: number;
}

/**
 * Donut chart made of braille dots (2x4 per cell). `sweep` (0..1) highlights a moving arc: the live-sync animation.
 * Returns `rows` lines, each `cols` cells wide. Slices start at 12 o'clock and run clockwise.
 */
export function donut(slices: Slice[], cols: number, rows: number, sweep = -1, hole = 0.55): string[] {
  const total = slices.reduce((n, s) => n + Math.max(0, s.value), 0);
  const W = cols * 2;
  const H = rows * 4;
  const cx = W / 2;
  const cy = H / 2;
  const R = Math.min(W, H) / 2 - 0.5;
  const out: string[] = [];
  const edges: number[] = [];
  let acc = 0;
  for (const s of slices) {
    acc += total > 0 ? Math.max(0, s.value) / total : 0;
    edges.push(acc);
  }
  const sliceAt = (frac: number) => {
    for (let i = 0; i < edges.length; i++) if (frac < edges[i]) return i;
    return edges.length - 1;
  };
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      let bits = 0;
      const votes = new Map<number, number>();
      let hot = 0;
      for (let dy = 0; dy < 4; dy++)
        for (let dx = 0; dx < 2; dx++) {
          const x = c * 2 + dx + 0.5 - cx;
          const y = r * 4 + dy + 0.5 - cy;
          const d = Math.hypot(x, y) / R;
          if (d > 1 || d < hole) continue;
          bits |= BRAILLE_BIT[dy][dx];
          let ang = Math.atan2(x, -y); // 0 at top, clockwise
          if (ang < 0) ang += Math.PI * 2;
          const frac = ang / (Math.PI * 2);
          if (total > 0) {
            const i = sliceAt(frac);
            votes.set(i, (votes.get(i) || 0) + 1);
          }
          if (sweep >= 0) {
            let dd = Math.abs(frac - sweep);
            dd = Math.min(dd, 1 - dd);
            if (dd < 0.05) hot++;
          }
        }
      if (!bits) {
        line += ' ';
        continue;
      }
      const ch = String.fromCharCode(0x2800 + bits);
      if (total <= 0) line += fg(240)(ch);
      else {
        const best = [...votes.entries()].sort((a, b) => b[1] - a[1])[0][0];
        const color = slices[best].color;
        line += hot >= 2 ? boldFg(255)(ch) : fg(color)(ch);
      }
    }
    out.push(line);
  }
  return out;
}

/** A horizontal bar in a given colour. */
export function colorBar(frac: number, width: number, color: number): string {
  const f = Math.max(0, Math.min(1, frac));
  const eighths = Math.round(f * width * 8);
  const full = Math.floor(eighths / 8);
  const part = eighths % 8;
  const partial = part ? '▏▎▍▌▋▊▉'[part - 1] : '';
  const used = full + (partial ? 1 : 0);
  return fg(color)('█'.repeat(full) + partial) + fg(238)('░'.repeat(Math.max(0, width - used)));
}

/** Events-per-bucket sparkline with a moving "now" cursor: the live pulse. */
export function pulse(buckets: number[], frame: number): string {
  const ramp = '▁▂▃▄▅▆▇█';
  const max = Math.max(...buckets, 1);
  return buckets
    .map((v, i) => {
      const ch = v === 0 ? '·' : ramp[Math.min(7, Math.floor((v / max) * 7.99))];
      return i === buckets.length - 1 && frame % 6 < 3 ? boldFg(120)(v === 0 ? '●' : ch) : v === 0 ? fg(240)(ch) : fg(114)(ch);
    })
    .join('');
}

/** Ease a shown number toward its target (count-up animation). */
export function ease(shown: number, target: number): number {
  const d = target - shown;
  return Math.abs(d) < 0.0005 ? target : shown + d * 0.18;
}
