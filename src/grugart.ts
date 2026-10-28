/** grug the caveman for grug-live: per thing grug is doing, an animated stage (SVG) for the band above the prompt, a
 *  short and a long caveman line, and text frames for the terminal, which draws no SVG. */
import type { ActivityKind } from './stats.js';

/** grug's face where only text fits (status line, app summary). */
export const GRUG_FACE = 'ᕦ(ò_ó)ᕤ';

export type GrugAct =
  | 'smash' | 'dig' | 'guard' | 'map' | 'carry' | 'check' | 'shrink' | 'send'
  | 'alarm' | 'cold' | 'sleep' | 'work' | 'proud' | 'watch';

export const GRUG_ACTS: GrugAct[] = ['smash', 'dig', 'guard', 'map', 'carry', 'check', 'shrink', 'send', 'alarm', 'cold', 'sleep', 'work', 'proud', 'watch'];

/** What grug is shown doing for one of his own activity kinds (undefined: not worth a scene). */
export function actFor(kind: ActivityKind | string | undefined): GrugAct | undefined {
  switch (kind) {
    case 'trim': case 'dedupe': case 'testsum': case 'cmdrules': case 'json': case 'fallback': case 'cache':
      return 'smash';
    case 'recall': case 'auto-recall': case 'history': case 'brief': case 'facts': case 'remember': case 'consolidate':
      return 'dig';
    case 'read-guard': case 'reread': case 'guard': case 'convention':
      return 'guard';
    case 'graph': case 'outline': case 'nav':
      return 'map';
    case 'handoff': case 'window': case 'task-shift':
      return 'carry';
    case 'verify':
      return 'check';
    case 'media':
      return 'shrink';
    case 'subagent': case 'routing': case 'bridge':
      return 'send';
    case 'context-alert':
      return 'alarm';
    case 'idle-alert': case 'cache-miss':
      return 'cold';
    default:
      return undefined;
  }
}

export interface SceneInput {
  /** grug's latest action kind (last ~45 s), if any. */
  kind?: string;
  alerts?: string[];
  busy?: boolean;
  idleMs?: number;
  savedPct?: number;
  netUsd?: number;
  /** The act the band showed before this one: a change between awake and asleep plays grug's walk once. */
  from?: string;
}

/** Idle this long after the last reply (and Claude not working): grug walks into his cave and sleeps. */
const NAP_MS = 90000;

/** Pick the scene: a cold cache first, then a nap when idle, then a too-big chat, grug's own latest action, Claude
 *  working, idle moods. */
export function pickAct(s: SceneInput): GrugAct {
  const alert = s.alerts?.[0] ?? '';
  if (/cache/i.test(alert)) return 'cold';
  if (!s.busy && (s.idleMs ?? 0) > NAP_MS) return 'sleep';
  if (alert) return 'alarm';
  const a = actFor(s.kind);
  if (a) return a;
  if (s.busy) return 'work';
  return (s.savedPct ?? 0) > 0 ? 'proud' : 'watch';
}

const usd = (n: number) => (n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2)}`);

/** grug's line for the scene, caveman style. */
export function grugSay(act: GrugAct, s: SceneInput = {}): string {
  switch (act) {
    case 'smash': return 'GRUG SMASH NOISY OUTPUT. keep good rocks only';
    case 'dig': return 'GRUG DIG MEMORY CAVE. bring back old wisdom';
    case 'guard': return 'GRUG GUARD CAVE. Claude read that already';
    case 'map': return 'GRUG DRAW CODE MAP. Claude no get lost';
    case 'carry': return 'GRUG CARRY HANDOFF. nothing forgotten';
    case 'check': return 'GRUG CHECK WORK. no say done before proof';
    case 'shrink': return 'GRUG SHRINK BIG PICTURE. cheaper to look';
    case 'send': return 'GRUG SEND SMALL FAST GRUG. cheap errand';
    case 'alarm': return 'CHAT TOO BIG! /clear soon, grug keep notes';
    case 'cold': return 'CACHE GO COLD! next reply cost more';
    case 'sleep': return 'grug nap. zzz';
    case 'work': return 'GRUG WATCH CLAUDE WORK. club ready';
    case 'proud':
      return s.netUsd && s.netUsd >= 0.01 ? `GRUG SAVE ${usd(s.netUsd)} THIS WEEK. grug strong` : `GRUG SAVE ~${Math.round((s.savedPct ?? 0) * 100)}% THIS WEEK`;
    default: return 'grug on. grug watching';
  }
}

/** grug's short line for the footer entry below the prompt (fits beside the model picker). */
export function grugShort(act: GrugAct, s: SceneInput = {}): string {
  switch (act) {
    case 'smash': return 'SMASH NOISE';
    case 'dig': return 'DIG MEMORY';
    case 'guard': return 'NO RE-READ';
    case 'map': return 'DRAW MAP';
    case 'carry': return 'CARRY NOTES';
    case 'check': return 'CHECK WORK';
    case 'shrink': return 'SHRINK PIC';
    case 'send': return 'SEND HELPER';
    case 'alarm': return 'CHAT TOO BIG';
    case 'cold': return 'CACHE COLD';
    case 'sleep': return 'nap';
    case 'work': return 'WATCH CLAUDE';
    case 'proud': return s.netUsd && s.netUsd >= 0.01 ? `SAVE ${usd(s.netUsd)}` : 'grug strong';
    default: return 'grug watch';
  }
}

/** Text frames for the footer entry, cycled every FRAME_MS: grug acts out the scene, a small loop per act. */
export const FRAME_MS = 450;
export function grugFrames(act: GrugAct): string[] {
  // 🧔 is grug (a whole man with a beard, not a face); the footer is one text line, so props are emoji.
  switch (act) {
    case 'smash': return ['🧔🦴   ≋≋≋', '🧔 🦴  ≋≋≋', '🧔  💥 ≋≋', '🧔🦴   ≋≋', '🧔  💥 ≋', '🧔🦴   ✓'];
    case 'dig': return ['🧔⛏  ▁▁▁', '🧔 ⛏ ▂▁▁', '🧔⛏  ▄▂▁', '🧔 ⛏ ▆▄▂', '🧔✨ 💎'];
    case 'guard': return ['🧔🛡    📄', '🧔🛡   📄', '🧔🛡  📄', '🧔🛡 📄', '🧔✋  📄'];
    case 'map': return ['🧔📜 ·', '🧔📜 ·─·', '🧔📜 ·─·─·', '🧔📜 ·─·─·─·', '🧔📜 ✓'];
    case 'carry': return ['🧔📦···', '·🧔📦··', '··🧔📦·', '···🧔📦'];
    case 'check': return ['🧔🔍  ▢', '🧔 🔍 ▢', '🧔  🔍▢', '🧔   ✅'];
    case 'shrink': return ['🧔🦴 ⬛', '🧔🦴 ◼', '🧔🦴 ▪', '🧔🦴 ·'];
    case 'send': return ['🧔👉🧒', '🧔👉 🧒', '🧔👉  🧒💨', '🧔👋   💨'];
    case 'alarm': return ['🧔❗ 📚', '🧔❗ 📚📚', '🧔‼ 📚📚📚', '🧔‼ 📚📚📚'];
    case 'cold': return ['🧔🔥 ❄❄❄', '🧔💨🔥 ❄❄', '🧔🔥 ❄❄❄', '🧔💨🔥 ❄'];
    case 'sleep': return ['🛌 z', '🛌 zZ', '🛌 zZz', '🛌 zZ'];
    case 'work': return ['🧔🦴 ·', '🧔🦴 ··', '🧔🦴 ···', '🧔👀 ···'];
    case 'proud': return ['🧔💰', '🧔💰✨', '🧔🙌✨', '🧔💰✨'];
    default: return ['🧔🦴', '🧔🦴', '🧔 🦴', '🧔🦴'];
  }
}

// ---- SVG ------------------------------------------------------------------------------------------------

const C = { skin: '#e7a86f', skinDark: '#b97a45', hair: '#3d2614', fur: '#a5672f', furDark: '#6e4220', wood: '#b0753a', woodDark: '#6e4220', stone: '#9a9a9a', stoneDark: '#5d5d5d', line: '#2b1a0b' };

const rot = (vals: number[], cx: number, cy: number, dur: number, keyTimes?: number[]) =>
  `<animateTransform attributeName="transform" type="rotate" values="${vals.map((v) => `${v} ${cx} ${cy}`).join(';')}"${keyTimes ? ` keyTimes="${keyTimes.join(';')}"` : ''} dur="${dur}s" repeatCount="indefinite"/>`;
const move = (vals: [number, number][], dur: number, begin = 0, keyTimes?: number[]) =>
  `<animateTransform attributeName="transform" type="translate" values="${vals.map(([x, y]) => `${x} ${y}`).join(';')}"${keyTimes ? ` keyTimes="${keyTimes.join(';')}"` : ''} dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`;
const anim = (attr: string, vals: (number | string)[], dur: number, begin = 0, keyTimes?: number[]) =>
  `<animate attributeName="${attr}" values="${vals.join(';')}"${keyTimes ? ` keyTimes="${keyTimes.join(';')}"` : ''} dur="${dur}s" begin="${begin}s" repeatCount="indefinite"/>`;

type Eyes = 'open' | 'closed' | 'wide' | 'happy';

/** The arm that does the work: pivots at the shoulder (38,27); the prop is drawn in arm space. */
function arm(prop: string, motion: string): string {
  return `<g>${motion}<path d="M38 27 L46 27" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>${prop}<circle cx="46.5" cy="27" r="2" fill="${C.skin}" stroke="${C.skinDark}" stroke-width=".5"/></g>`;
}

const CLUB = `<path d="M45.5 28 L47.2 14 Q47.6 9 51 9.6 Q54.6 10.8 52.4 15.4 L48 28.6 Z" fill="${C.wood}" stroke="${C.woodDark}" stroke-width=".8"/><circle cx="50.2" cy="12.6" r=".8" fill="${C.woodDark}"/><circle cx="51.6" cy="14.8" r=".6" fill="${C.woodDark}"/>`;

function head(eyes: Eyes): string {
  const blink = anim('ry', [1.4, 1.4, 0.15, 1.4], 4, 0, [0, 0.9, 0.95, 1]);
  let eye: string;
  if (eyes === 'closed') eye = `<path d="M25.6 14.2 q1.5 1.1 3 0 M31.4 14.2 q1.5 1.1 3 0" stroke="${C.line}" stroke-width=".9" fill="none"/>`;
  else if (eyes === 'happy') eye = `<path d="M25.6 14.8 q1.5 -1.6 3 0 M31.4 14.8 q1.5 -1.6 3 0" stroke="${C.line}" stroke-width=".9" fill="none"/>`;
  else if (eyes === 'wide') eye = `<circle cx="27" cy="14" r="1.9" fill="#fff" stroke="${C.line}" stroke-width=".5"/><circle cx="33" cy="14" r="1.9" fill="#fff" stroke="${C.line}" stroke-width=".5"/><circle cx="27" cy="14" r=".8" fill="${C.line}"/><circle cx="33" cy="14" r=".8" fill="${C.line}"/>`;
  else eye = `<ellipse cx="27" cy="14" rx="1.1" ry="1.4" fill="${C.line}">${blink}</ellipse><ellipse cx="33" cy="14" rx="1.1" ry="1.4" fill="${C.line}">${blink}</ellipse>`;
  const brow = eyes === 'wide' ? 'M24 10.6 Q30 8.6 36 10.6' : eyes === 'open' ? 'M24 11.6 Q27 13 30 11.8 Q33 13 36 11.6' : 'M24 12 Q30 10.6 36 12';
  const mouth = eyes === 'wide' ? `<ellipse cx="30" cy="21.4" rx="1.6" ry="1.9" fill="${C.line}"/>` : eyes === 'happy' ? `<path d="M27.6 20.6 Q30 23 32.4 20.6" stroke="${C.line}" stroke-width=".8" fill="#fff"/>` : `<path d="M28 21.4 L32 21.2" stroke="${C.line}" stroke-width=".8"/>`;
  return (
    `<circle cx="30" cy="15" r="8.2" fill="${C.skin}" stroke="${C.skinDark}" stroke-width=".6"/>` +
    `<path d="M23 18 Q23.6 26.6 30 26.6 Q36.4 26.6 37 18 Q34 22 30 21.6 Q26 22 23 18 Z" fill="${C.hair}"/>` +
    `<path d="M21.4 13 Q21.4 4.4 30 5 Q38.6 4.4 38.6 13 L37 9.8 L35.4 11.4 L34 8.2 L32 10.4 L30 7.4 L28 10.4 L26 8.2 L24.6 11.4 L23 9.8 Z" fill="${C.hair}"/>` +
    `<path d="${brow}" stroke="${C.hair}" stroke-width="1.9" fill="none" stroke-linecap="round"/>` +
    eye +
    `<ellipse cx="30" cy="17.4" rx="2" ry="1.5" fill="${C.skinDark}"/>` +
    mouth
  );
}

function legs(walk: boolean): string {
  const l = walk ? rot([-18, 18, -18], 27, 37, 0.5) : '';
  const r = walk ? rot([18, -18, 18], 33, 37, 0.5) : '';
  return (
    `<g>${l}<rect x="25.2" y="36" width="3.6" height="8.6" rx="1.4" fill="${C.skin}"/><ellipse cx="26.4" cy="45" rx="3" ry="1.4" fill="${C.furDark}"/></g>` +
    `<g>${r}<rect x="31.2" y="36" width="3.6" height="8.6" rx="1.4" fill="${C.skin}"/><ellipse cx="34" cy="45" rx="3" ry="1.4" fill="${C.furDark}"/></g>`
  );
}

const TUNIC =
  `<path d="M20 28.6 Q30 20.6 40 28.6 L41.2 38.6 L37.4 36.4 L34.4 39.6 L30.4 36.6 L26.4 39.6 L23 36.4 L18.8 38.6 Z" fill="${C.fur}" stroke="${C.furDark}" stroke-width=".7"/>` +
  `<circle cx="25" cy="32" r="1.3" fill="${C.furDark}"/><circle cx="33.4" cy="30.4" r="1.1" fill="${C.furDark}"/><circle cx="29" cy="35.4" r="1.2" fill="${C.furDark}"/><circle cx="36.6" cy="34.4" r=".9" fill="${C.furDark}"/>` +
  `<path d="M24 23.6 L35 34" stroke="${C.furDark}" stroke-width="1.2"/>`;

function grug(o: { eyes?: Eyes; workArm?: string; leftArm?: 'down' | 'up'; walk?: boolean; body?: string }): string {
  const left = o.leftArm === 'up' ? `<path d="M22 27 L19 18" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>` : `<path d="M22 27.4 L17.6 34.4" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>`;
  return `<g>${o.body ?? ''}${legs(!!o.walk)}${left}${TUNIC}${head(o.eyes ?? 'open')}${o.workArm ?? arm(CLUB, rot([-30, -26, -30], 38, 27, 2.4))}</g>`;
}

const spark = (x: number, y: number, color: string, begin: number, dur = 1.2) =>
  `<path d="M${x} ${y - 2.6} L${x + 0.7} ${y - 0.7} L${x + 2.6} ${y} L${x + 0.7} ${y + 0.7} L${x} ${y + 2.6} L${x - 0.7} ${y + 0.7} L${x - 2.6} ${y} L${x - 0.7} ${y - 0.7} Z" fill="${color}" opacity="0">${anim('opacity', [0, 1, 0], dur, begin)}</path>`;
const ground = (to = 112) => `<path d="M4 46.6 L${to} 46.6" stroke="${C.stoneDark}" stroke-width=".8" stroke-dasharray="3 2" opacity=".6"/>`;
const word = (x: number, y: number, text: string, color: string, size = 7, blink?: number) =>
  `<text x="${x}" y="${y}" font-family="Impact, 'Arial Black', sans-serif" font-size="${size}" font-weight="900" fill="${color}" stroke="${C.line}" stroke-width=".35"${blink ? ' opacity="0"' : ''}>${text}${blink ? anim('opacity', [0, 1, 1, 0], blink, 0, [0, 0.35, 0.6, 1]) : ''}</text>`;

function scene(act: GrugAct): string {
  switch (act) {
    case 'smash': {
      const sw = rot([-50, -50, 82, 82, -50], 38, 27, 0.8, [0, 0.35, 0.5, 0.7, 1]);
      const pebble = (dx: number, dy: number, b: number) =>
        `<circle cx="62" cy="40" r="1.3" fill="${C.stone}" opacity="0">${move([[0, 0], [0, 0], [dx, dy]], 0.8, b, [0, 0.5, 1])}${anim('opacity', [0, 0, 1, 0], 0.8, b, [0, 0.49, 0.5, 1])}</circle>`;
      return (
        ground() +
        `<g><path d="M53 46.4 L55.4 38.6 L61 35.4 L67.6 37.4 L70 46.4 Z" fill="${C.stone}" stroke="${C.stoneDark}" stroke-width=".8"/>${anim('opacity', [1, 1, 0.75, 1], 0.8, 0, [0, 0.5, 0.55, 1])}</g>` +
        `<path d="M59 38 L61.4 42 L60 46" stroke="${C.stoneDark}" stroke-width=".7" fill="none"/>` +
        pebble(14, -10, 0) + pebble(20, -2, 0) + pebble(8, -16, 0) + pebble(24, -8, 0) +
        `<g opacity="0">${anim('opacity', [0, 0, 1, 0], 0.8, 0, [0, 0.48, 0.52, 0.8])}<path d="M58 31 L60.6 34.6 L64.6 33 L62.6 36.6 L66.6 39 L62 39 L61 43 L59 39.4 L55 40 L57.6 36.4 Z" fill="#ffd23f" stroke="#d27c00" stroke-width=".5"/></g>` +
        word(74, 22, 'SMASH!', '#ff5a36', 9, 0.8) +
        grug({ eyes: 'open', workArm: arm(CLUB, sw) })
      );
    }
    case 'dig': {
      const shovel = `<path d="M46 27 L54 20" stroke="#efe6d2" stroke-width="2.2" stroke-linecap="round"/><circle cx="54.6" cy="19.2" r="1.6" fill="#efe6d2"/><circle cx="53.2" cy="18.4" r="1.4" fill="#efe6d2"/>`;
      const dirt = (dx: number, dy: number, b: number) =>
        `<circle cx="60" cy="42" r="1.1" fill="${C.furDark}" opacity="0">${move([[0, 0], [dx, dy], [dx * 1.4, dy + 8]], 0.9, b)}${anim('opacity', [1, 1, 0], 0.9, b)}</circle>`;
      return (
        ground() +
        `<ellipse cx="62" cy="46" rx="11" ry="4.6" fill="${C.furDark}"/>` +
        dirt(8, -10, 0) + dirt(14, -6, 0.3) + dirt(5, -14, 0.6) +
        `<g opacity="0">${move([[0, 4], [0, -10], [0, -10]], 1.8, 0, [0, 0.5, 1])}${anim('opacity', [0, 1, 1, 0], 1.8, 0, [0, 0.3, 0.8, 1])}<path d="M78 34 L81.4 30 L84.8 34 L81.4 39 Z" fill="#5fd4ff" stroke="#1d7fb3" stroke-width=".6"/>${spark(86, 28, '#ffe66d', 0.4, 0.9)}</g>` +
        word(76, 18, 'MEMORY!', '#5fd4ff', 6.5, 1.8) +
        grug({ eyes: 'open', workArm: arm(shovel, rot([-10, 40, -10], 38, 27, 0.9)) })
      );
    }
    case 'guard': {
      const shield = `<circle cx="50" cy="26" r="7.4" fill="${C.stone}" stroke="${C.stoneDark}" stroke-width="1"/><circle cx="50" cy="26" r="4.6" fill="none" stroke="${C.stoneDark}" stroke-width=".7"/><path d="M46.6 22.6 L53.4 29.4" stroke="#e5484d" stroke-width="1.8" stroke-linecap="round"/>`;
      const file = `<g>${move([[30, 0], [4, 0], [10, 0], [30, 0]], 1.6, 0, [0, 0.45, 0.55, 1])}<path d="M58 20 L66 20 L69 23 L69 33 L58 33 Z" fill="#f4f4f4" stroke="${C.stoneDark}" stroke-width=".7"/><path d="M60 24 L66 24 M60 27 L67 27 M60 30 L65 30" stroke="#9aa" stroke-width=".7"/></g>`;
      return ground() + file + word(76, 14, 'NO REREAD!', '#e5484d', 6.5, 1.6) + grug({ eyes: 'open', workArm: arm(shield, rot([0, 6, 0], 38, 27, 1.6)) });
    }
    case 'map': {
      const scroll = `<rect x="47" y="17" width="20" height="15" rx="1.2" fill="#f2dca6" stroke="#a88545" stroke-width=".7"/><rect x="45.6" y="16" width="2.4" height="17" rx="1.2" fill="#d9b874"/><rect x="66.2" y="16" width="2.4" height="17" rx="1.2" fill="#d9b874"/>`;
      const draw = (d: string, b: number) => `<path d="${d}" stroke="#7a4b1c" stroke-width=".9" fill="none" stroke-dasharray="20" stroke-dashoffset="20">${anim('stroke-dashoffset', [20, 0, 0], 2.4, b, [0, 0.4, 1])}</path>`;
      const node = (x: number, y: number, b: number) => `<circle cx="${x}" cy="${y}" r="1.4" fill="#d2562f" opacity="0">${anim('opacity', [0, 0, 1, 1], 2.4, 0, [0, b, b + 0.05, 1])}</circle>`;
      return (
        ground() +
        word(74, 14, 'CODE MAP', '#f2dca6', 6.5, 2.4) +
        grug({ eyes: 'open', workArm: arm(scroll + draw('M51 21 L57 27 L63 21', 0) + draw('M57 27 L60 30', 0.5) + node(51, 21, 0.05) + node(57, 27, 0.2) + node(63, 21, 0.35) + node(60, 30, 0.6), rot([0, 2, 0], 38, 27, 2.4)) })
      );
    }
    case 'carry': {
      const tablet = `<g><rect x="17" y="-6.4" width="26" height="10" rx="2.4" fill="${C.stone}" stroke="${C.stoneDark}" stroke-width=".9"/><path d="M21 -3.4 L33 -3.4 M21 -0.4 L38 -0.4 M21 2.2 L29 2.2" stroke="${C.stoneDark}" stroke-width=".8"/></g>`;
      const upArm = `<path d="M38 27 L41 18" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>`;
      return (
        ground() +
        `<g>${move([[0, 0], [44, 0], [0, 0]], 6)}<g>${move([[0, 0], [0, -1.2], [0, 0]], 0.5)}${tablet}<path d="M19 18 L20 4 M41 18 L40 4" stroke="${C.skin}" stroke-width="3" stroke-linecap="round"/>${grug({ eyes: 'open', leftArm: 'up', walk: true, workArm: upArm })}</g></g>` +
        word(84, 16, 'HANDOFF', '#c9c9c9', 6.5, 3)
      );
    }
    case 'check': {
      const lens = `<path d="M46 27 L50 23" stroke="${C.woodDark}" stroke-width="1.8" stroke-linecap="round"/><circle cx="53" cy="20" r="4.4" fill="#bfe9ff" fill-opacity=".55" stroke="${C.line}" stroke-width="1.1"/>`;
      return (
        ground() +
        `<rect x="60" y="26" width="18" height="20" rx="2" fill="${C.stone}" stroke="${C.stoneDark}" stroke-width=".9"/><path d="M63 31 L73 31 M63 35 L75 35 M63 39 L70 39" stroke="${C.stoneDark}" stroke-width=".8"/>` +
        `<path d="M74 37 L78 42 L88 28" stroke="#30c06a" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="24" stroke-dashoffset="24">${anim('stroke-dashoffset', [24, 24, 0, 0], 2, 0, [0, 0.5, 0.7, 1])}</path>` +
        grug({ eyes: 'open', workArm: arm(lens, rot([0, 24, 34, 10, 0], 38, 27, 2)) })
      );
    }
    case 'shrink': {
      const pic = `<g transform="translate(70 32)"><g>${'<animateTransform attributeName="transform" type="scale" values="1.5;1.5;0.6;0.6;1.5" keyTimes="0;0.3;0.45;0.9;1" dur="1.6s" repeatCount="indefinite"/>'}<rect x="-8" y="-6" width="16" height="12" rx="1" fill="#f4f4f4" stroke="${C.stoneDark}" stroke-width=".8"/><path d="M-7 5 L-2 -1 L1 2 L4 -2 L7 5 Z" fill="#30c06a"/><circle cx="-3.6" cy="-2.6" r="1.6" fill="#ffd23f"/></g></g>`;
      return ground() + pic + word(84, 14, 'SMALLER!', '#ffd23f', 6.5, 1.6) + grug({ eyes: 'open', workArm: arm(CLUB, rot([-50, -50, 60, 60, -50], 38, 27, 1.6, [0, 0.25, 0.35, 0.9, 1])) });
    }
    case 'send': {
      const wave = `<path d="M38 27 L44 20" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/><circle cx="44.6" cy="19.2" r="2" fill="${C.skin}"/>`;
      return (
        ground() +
        `<g opacity="0">${move([[46, 14], [100, 14]], 2.2)}${anim('opacity', [0, 1, 1, 0], 2.2, 0, [0, 0.1, 0.8, 1])}<g transform="scale(.6)">${grug({ eyes: 'open', walk: true })}</g></g>` +
        word(78, 12, 'GO!', '#30c06a', 7.5, 2.2) +
        grug({ eyes: 'happy', workArm: `<g>${rot([-10, 20, -10], 38, 27, 0.6)}${wave}</g>` })
      );
    }
    case 'alarm':
    case 'cold': {
      const icon = act === 'cold'
        ? `<g transform="translate(62 16)"><g>${rot([0, 360], 0, 0, 4)}<path d="M0 -7 L0 7 M-6 -3.5 L6 3.5 M-6 3.5 L6 -3.5" stroke="#7fd3ff" stroke-width="1.8" stroke-linecap="round"/><path d="M-1.6 -5.4 L0 -4 L1.6 -5.4 M-1.6 5.4 L0 4 L1.6 5.4" stroke="#7fd3ff" stroke-width="1.1" fill="none"/></g></g>`
        : `<g><rect x="54" y="30" width="22" height="16" rx="1.6" fill="${C.stone}" stroke="${C.stoneDark}"/><rect x="56" y="18" width="18" height="12" rx="1.6" fill="${C.stone}" stroke="${C.stoneDark}"/><rect x="58" y="8" width="14" height="10" rx="1.6" fill="${C.stone}" stroke="${C.stoneDark}">${rot([-4, 4, -4], 65, 18, 0.5)}</rect></g>`;
      return (
        ground() + icon +
        word(80, 22, '!!', '#ff3b30', 14, 0.6) +
        word(80, 40, act === 'cold' ? 'COLD!' : 'TOO BIG!', act === 'cold' ? '#7fd3ff' : '#ff9f0a', 7) +
        `<g>${move([[0, 0], [0, -4], [0, 0], [-1, 0], [1, 0], [0, 0]], 0.7)}${grug({ eyes: 'wide', leftArm: 'up', workArm: `<path d="M38 27 L41 18" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>` })}</g>`
      );
    }
    case 'sleep': {
      const z = (x: number, b: number, s: number) => `<text x="${x}" y="8" font-family="Impact, sans-serif" font-size="${s}" fill="#9fb3ff" opacity="0">z${move([[0, 4], [6, -8]], 3, b)}${anim('opacity', [0, 1, 0], 3, b)}</text>`;
      return (
        ground() + z(40, 0, 6) + z(44, 1, 7.5) + z(48, 2, 9) +
        `<g>${'<animateTransform attributeName="transform" type="translate" values="0 0;0 .8;0 0" dur="3s" repeatCount="indefinite"/>'}${grug({ eyes: 'closed', workArm: `<g><path d="M38 27 L43 33" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/></g>` })}</g>` +
        `<path d="M44 45.6 L58 44.4 Q62 44 61.6 46.2 L44.4 46.8 Z" fill="${C.wood}" stroke="${C.woodDark}" stroke-width=".7"/>`
      );
    }
    case 'work': {
      const sparkAt = (dx: number, dy: number) => `<circle cx="58" cy="34" r=".9" fill="#ffd23f" opacity="0">${move([[0, 0], [0, 0], [dx, dy]], 0.6, 0, [0, 0.45, 1])}${anim('opacity', [0, 0, 1, 0], 0.6, 0, [0, 0.44, 0.46, 1])}</circle>`;
      return (
        ground() +
        `<rect x="57" y="28" width="16" height="18.4" rx="2" fill="${C.stone}" stroke="${C.stoneDark}" stroke-width=".9"/><path d="M60 33 L68 33 M60 37 L70 37" stroke="${C.stoneDark}" stroke-width=".8"/><path d="M60 41 L66 41" stroke="${C.stoneDark}" stroke-width=".8" stroke-dasharray="8" stroke-dashoffset="8">${anim('stroke-dashoffset', [8, 0, 0], 3)}</path>` +
        sparkAt(-4, -6) + sparkAt(3, -7) + sparkAt(-1, -9) +
        grug({ eyes: 'open', workArm: arm(CLUB, rot([-30, -30, 50, 50, -30], 38, 27, 0.6, [0, 0.3, 0.45, 0.6, 1])) })
      );
    }
    case 'proud': {
      const coin = `<g>${move([[0, 0], [0, -2], [0, 0]], 0.9)}<circle cx="50" cy="14" r="5" fill="#ffcf33" stroke="#c48a00" stroke-width=".9"/><text x="47.6" y="17.2" font-family="Impact, sans-serif" font-size="8" fill="#8a5a00">$</text></g>`;
      return (
        ground() +
        spark(60, 10, '#ffe66d', 0) + spark(70, 22, '#fff2a8', 0.4) + spark(64, 34, '#ffe66d', 0.8) + spark(14, 8, '#fff2a8', 0.6) +
        word(68, 16, 'SAVED!', '#ffcf33', 8, 2) +
        grug({ eyes: 'happy', leftArm: 'up', workArm: `<g>${rot([-4, 4, -4], 38, 27, 0.9)}<path d="M38 27 L46 18" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>${coin}</g>` })
      );
    }
    default:
      return ground() + spark(60, 14, '#fff2a8', 0, 3) + grug({ eyes: 'open' });
  }
}

/** The animated SVG for a scene (viewBox 120x56, the grug figure 46 units tall). */
export function grugSvg(act: GrugAct): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -9 120 57" width="120" height="57"><title>grug: ${grugSay(act).toLowerCase()}</title>${scene(act)}</svg>`;
}

// ---- stage: the wide band above the prompt --------------------------------------------------------------

/** The scene is drawn this wide and the frame shows its left part (cave first), so any band width is filled edge to
 *  edge with no margin; the sky, hills and grass repeat every TILE. */
const STAGE_W = 2400;
const STAGE_H = 72;
const TILE = 560;
/** The frame shows y 14-68 only: the empty top of the sky and the bottom of the ground are cut for a thin strip. */
const VIEW_Y = 14;
const VIEW_H = 54;
const tiles = (f: (dx: number) => string) => Array.from({ length: Math.ceil(STAGE_W / TILE) }, (_, i) => f(i * TILE)).join('');
/** Where grug's feet stand (stage units); his figure is drawn with feet at y 46.6. */
const FLOOR = 62;
const LIFT = FLOOR - 46.6;
/** grug's x offset at the cave mouth and at the work spot (figure centre is offset + 30). */
const CAVE_X = -2;
const WORK_X = 214;

type Sky = 'dusk' | 'night' | 'ice';

const SKIES: Record<Sky, [string, string][]> = {
  dusk: [['0', '#1c1836'], ['.3', '#3f2758'], ['.55', '#a4506a'], ['.75', '#f08a4b'], ['1', '#ffc06a']],
  night: [['0', '#070b1f'], ['.6', '#151d45'], ['1', '#2b3a6e']],
  ice: [['0', '#0f1d33'], ['.6', '#284865'], ['1', '#7fb0cf']],
};

/** One-shot pieces for a change between awake and asleep: they play once when the band gets the new drawing and hold. */
const slide = (vals: [number, number][], dur: number, begin = 0) =>
  `<animateTransform attributeName="transform" type="translate" values="${vals.map(([x, y]) => `${x} ${y}`).join(';')}" dur="${dur}s" begin="${begin}s" fill="freeze"/>`;
const fade = (vals: number[], dur: number, begin = 0) =>
  `<animate attributeName="opacity" values="${vals.join(';')}" dur="${dur}s" begin="${begin}s" fill="freeze"/>`;

function backdrop(sky: Sky, id = 'gsky'): string {
  const stops = SKIES[sky].map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('');
  const star = (x: number, y: number, r: number, b: number) =>
    `<circle cx="${x}" cy="${y}" r="${r}" fill="#fff6dd" opacity=".2">${anim('opacity', [0.15, 0.9, 0.15], 3.4, b)}</circle>`;
  const stars = tiles((dx) => [[150, 9, 0.7, 0], [196, 20, 0.5, 1.1], [262, 7, 0.6, 2.2], [318, 15, 0.5, 0.6], [372, 6, 0.8, 1.7], [420, 22, 0.5, 2.8], [520, 10, 0.6, 0.3], [88, 14, 0.5, 2.5], [238, 28, 0.4, 1.4]]
    .map(([x, y, r, b]) => star(x + dx + (dx ? (y * 7) % 40 : 0), y, sky === 'night' ? r * 1.4 : r, b + dx / 700)).join(''));
  const sun = sky === 'night'
    ? `<circle cx="486" cy="20" r="11" fill="#fff3c4" opacity=".14"/><circle cx="486" cy="20" r="7.5" fill="#fff1c2"/><circle cx="489.5" cy="17.5" r="6.6" fill="#151d45" opacity=".92"/>`
    : sky === 'ice'
      ? `<circle cx="480" cy="30" r="9" fill="#e9f6ff" opacity=".55"/>`
      : `<circle cx="474" cy="31" r="30" fill="#ff9a4a" opacity=".22">${anim('r', [26, 32, 26], 6)}</circle><circle cx="474" cy="31" r="13" fill="#ffb347"/><circle cx="474" cy="31" r="9.5" fill="#ffd27a" opacity=".8"/>`;
  const cloud = (y: number, dur: number, begin: number, o: number) =>
    `<g opacity="${o}">${move([[-120, 0], [STAGE_W + 40, 0]], dur * ((STAGE_W + 160) / (TILE + 160)), begin)}<ellipse cx="0" cy="${y}" rx="22" ry="4.2" fill="#f6d1c0"/><ellipse cx="12" cy="${y - 3}" rx="12" ry="4" fill="#f6d1c0"/></g>`;
  const far = sky === 'ice' ? '#3b5d7e' : sky === 'night' ? '#1c2454' : '#4b2c56';
  const near = sky === 'ice' ? '#2a445f' : sky === 'night' ? '#121838' : '#2d1b36';
  return (
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1">${stops}</linearGradient>` +
    (id === 'gsky' ? `<radialGradient id="gfire"><stop offset="0" stop-color="#ffb347" stop-opacity=".55"/><stop offset="1" stop-color="#ffb347" stop-opacity="0"/></radialGradient>` : '') +
    `</defs>` +
    `<rect width="${STAGE_W}" height="${STAGE_H}" fill="url(#${id})"/>` +
    stars + sun +
    (sky === 'dusk' ? cloud(16, 70, -20, 0.22) + cloud(26, 95, -70, 0.15) + cloud(12, 120, -40, 0.12) : '') +
    tiles((dx) => `<path transform="translate(${dx} 0)" d="M0 ${FLOOR} L0 40 L40 30 L70 40 L118 22 L160 38 L205 26 L262 42 L300 30 L350 40 L396 24 L440 38 L500 28 L560 40 L560 ${FLOOR} Z" fill="${far}" opacity=".9"/>`) +
    tiles((dx) => `<path transform="translate(${dx} 0)" d="M0 ${FLOOR} L0 48 Q70 42 140 52 T290 50 T430 52 T560 48 L560 ${FLOOR} Z" fill="${near}"/>`) +
    `<rect y="${FLOOR}" width="${STAGE_W}" height="${STAGE_H - FLOOR}" fill="#150d18"/>` +
    `<path d="M0 ${FLOOR} L${STAGE_W} ${FLOOR}" stroke="${sky === 'ice' ? '#dbeefa' : '#5a3b4a'}" stroke-width="${sky === 'ice' ? 1.6 : 0.9}"/>` +
    tiles((dx) => [36, 132, 188, 330, 392, 446, 530].map((x) => `<path d="M${x + dx} ${FLOOR} l1.4 -3.4 l1 3 l1.2 -2.6 l.8 3" stroke="#3f2b38" stroke-width=".8" fill="none"/>`).join('')) +
    tiles((dx) => [[150, 0.9], [366, 1.3], [508, 1]].map(([x, r]) => `<ellipse cx="${x + dx}" cy="${FLOOR + 3}" rx="${r * 3}" ry="${r * 1.3}" fill="#2b1f2b"/>`).join(''))
  );
}

/** The cave grug lives in, at the left edge; the mouth is drawn before grug, the rim after, so he steps out of it. */
const MOUTH = `M12 ${FLOOR} Q12 30 30 28 Q48 30 48 ${FLOOR} Z`;
const CAVE_BACK = `<path d="M0 ${FLOOR} L0 18 Q14 8 36 12 Q58 16 64 34 Q70 48 66 ${FLOOR} Z" fill="#2c2233" stroke="#45364a" stroke-width="1"/><path d="${MOUTH}" fill="#06040a"/>`;
const CAVE_RIM = `<path d="M8 ${FLOOR} Q8 26 30 24 Q52 26 52 ${FLOOR} L48 ${FLOOR} Q48 30 30 28 Q12 30 12 ${FLOOR} Z" fill="#3b2e42"/><path d="M20 20 l4 -2 M44 22 l3 2 M56 40 l3 1" stroke="#5a4860" stroke-width="1" stroke-linecap="round"/>`;
const ICICLES = [17, 23, 31, 38, 44].map((x, i) => `<path d="M${x - 1.6} ${i % 2 ? 28.6 : 29.6} l1.6 ${4 + (i % 3) * 1.6} l1.6 ${-(4 + (i % 3) * 1.6)} Z" fill="#dff3ff" opacity=".85"/>`).join('');

type Fire = 'lit' | 'embers' | 'out';

function campfire(fire: Fire): string {
  const x = 96;
  const logs = `<path d="M${x - 10} ${FLOOR} L${x + 10} ${FLOOR - 5}" stroke="#6e4220" stroke-width="3.4" stroke-linecap="round"/><path d="M${x - 10} ${FLOOR - 5} L${x + 10} ${FLOOR}" stroke="#8a5428" stroke-width="3.4" stroke-linecap="round"/>`;
  const stones = [-13, -6, 6, 13].map((d) => `<ellipse cx="${x + d}" cy="${FLOOR + 0.6}" rx="3" ry="1.8" fill="#4a4048"/>`).join('');
  const puff = (b: number, o: number) => `<circle cx="${x}" cy="${FLOOR - 6}" r="2.4" fill="#c9d6e2" opacity="0">${move([[0, 0], [4, -26]], 3.6, b)}${anim('opacity', [0, o, 0], 3.6, b)}${anim('r', [2, 6, 9], 3.6, b)}</circle>`;
  if (fire === 'out') return logs + stones + puff(0, 0.55) + puff(1.2, 0.55) + puff(2.4, 0.55);
  if (fire === 'embers') {
    const coal = (dx: number, b: number) => `<ellipse cx="${x + dx}" cy="${FLOOR - 1.6}" rx="2.2" ry="1.2" fill="#ff5a2b">${anim('opacity', [0.35, 1, 0.35], 2.6, b)}</ellipse>`;
    return (
      `<circle cx="${x}" cy="${FLOOR - 3}" r="16" fill="url(#gfire)" opacity=".45">${anim('opacity', [0.3, 0.55, 0.3], 3.2)}</circle>` +
      logs + stones + coal(-4, 0) + coal(1, 0.9) + coal(5, 1.7) + puff(0, 0.25) + puff(1.8, 0.25)
    );
  }
  const flame = (d: string, fill: string, dur: number) =>
    `<g transform="translate(${x} ${FLOOR - 3})"><path d="${d}" fill="${fill}"><animateTransform attributeName="transform" type="scale" values="1 1;.9 1.12;1.06 .92;1 1" dur="${dur}s" repeatCount="indefinite"/></path></g>`;
  const ember = (dx: number, b: number) => `<circle cx="${x + dx}" cy="${FLOOR - 10}" r=".9" fill="#ffd27a" opacity="0">${move([[0, 0], [dx * 0.6, -28]], 2.2, b)}${anim('opacity', [0, 1, 0], 2.2, b)}</circle>`;
  return (
    `<circle cx="${x}" cy="${FLOOR - 8}" r="34" fill="url(#gfire)">${anim('opacity', [0.75, 1, 0.8, 0.95, 0.75], 1.6)}</circle>` +
    logs + stones +
    flame('M-7 0 Q-8 -9 -2 -14 Q-1 -8 2 -10 Q1 -17 5 -21 Q9 -12 7 0 Z', '#ff6a2b', 0.7) +
    flame('M-4.6 0 Q-5 -7 -.6 -11 Q.6 -6 3 -8 Q4.6 -4 4.4 0 Z', '#ffb02e', 0.55) +
    flame('M-2.2 0 Q-2.6 -4 0 -6.4 Q2.6 -4 2.2 0 Z', '#fff0a8', 0.45) +
    ember(-3, 0) + ember(2, 0.7) + ember(5, 1.5) + ember(-6, 1.1)
  );
}

const snow = () =>
  Array.from({ length: 16 * Math.ceil(STAGE_W / TILE) }, (_, i) => {
    const x = 20 + ((i * 37) % 530) + Math.floor(i / 16) * TILE;
    const dur = 4 + (i % 4);
    return `<circle cx="${x}" cy="-4" r="${0.8 + (i % 3) * 0.4}" fill="#f3fbff" opacity=".85">${move([[0, 0], [((i % 5) - 2) * 6, STAGE_H + 6]], dur, -(i * 0.6) % dur)}</circle>`;
  }).join('');

/** A pterodactyl gliding right to left across the dusk sky now and then, wings flapping. */
function ptero(y: number, dur: number, begin: number, s: number): string {
  const wing = `<g><animateTransform attributeName="transform" type="scale" values="1 1;1 -.55;1 1" dur=".8s" repeatCount="indefinite"/><path d="M-1.4 0 L3 -7 L5.6 -6.2 L2 0 Z" fill="#2a1830"/></g>`;
  return (
    `<g>${move([[1500, y], [-60, y - 8], [-60, y - 8]], dur, begin, [0, 0.55, 1])}<g transform="scale(${s})">` +
    `<g>${move([[0, 0], [0, 1.6], [0, 0]], 1.6)}${wing}<ellipse cx="0" cy="0" rx="3.4" ry="1.3" fill="#2a1830"/><path d="M-3 -.4 L-8.6 .6 L-3 .8 Z M-3.4 -.6 L-1 -3 L-1.6 -.4 Z M3 0 L7 1.4 L3 .8 Z" fill="#2a1830"/></g>` +
    `</g></g>`
  );
}

/** A shooting star now and then in the night sky. */
const shootingStar = (x: number, y: number, dur: number, begin: number) =>
  `<g opacity="0">${move([[x, y], [x, y], [x - 70, y + 20], [x - 70, y + 20]], dur, begin, [0, 0.6, 0.67, 1])}${anim('opacity', [0, 0, 1, 0, 0], dur, begin, [0, 0.6, 0.62, 0.67, 1])}<path d="M0 0 L12 -3.4" stroke="#fff6dd" stroke-width=".8" stroke-linecap="round"/><circle r=".9" fill="#fff"/></g>`;

/** Fireflies drifting by the cave at night. */
const fireflies = () =>
  [[74, 50, 0], [118, 44, 1.3], [150, 54, 2.1], [186, 46, 0.6], [228, 52, 2.8], [62, 40, 1.9]].map(([x, y, b], i) =>
    `<circle cx="${x}" cy="${y}" r=".9" fill="#d8ff7a" opacity="0">${move([[0, 0], [6 - i * 2, -5], [-4, -2 + i], [0, 0]], 5 + i, -b)}${anim('opacity', [0, 0.9, 0.2, 0.9, 0], 2.6 + (i % 3) * 0.7, -b)}</circle>`).join('');

/** grug walking with his club on his shoulder; `left` mirrors him (walking back into the cave). */
function walker(left: boolean): string {
  const g = `<g>${move([[0, 0], [0, -1.2], [0, 0]], 0.25)}${grug({ eyes: 'open', walk: true, workArm: arm(CLUB, rot([-48, -36, -48], 38, 27, 0.5)) })}</g>`;
  return left ? `<g transform="translate(60 0) scale(-1 1)">${g}</g>` : g;
}

/** grug stretching at the cave mouth after a nap, both arms up. */
const stretcher = () =>
  `<g>${move([[0, 0], [0, -1.4], [0, 0]], 1)}${grug({ eyes: 'closed', leftArm: 'up', workArm: `<path d="M38 27 L41 18" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>` })}</g>`;

/** grug asleep on his side just inside the cave mouth, head on a stone, under a fur that rises and falls; `cold`
 *  shivers him and gives him a frosty fur. Drawn between the cave's mouth and rim. */
function sleeper(cold: boolean): string {
  const rest = `<path d="M38 27.4 L42.4 34.4" stroke="${C.skin}" stroke-width="3.4" stroke-linecap="round"/>`;
  const fur = cold ? '#8fa9bf' : C.fur;
  const shiver = cold ? move([[0, 0], [0.5, 0], [-0.5, 0], [0, 0]], 0.3) : '';
  const body =
    `<g transform="translate(10.5 36.7) scale(.66)">` +
    `<ellipse cx="11" cy="37" rx="8" ry="3" fill="${C.stone}" stroke="${C.stoneDark}" stroke-width=".8"/>` +
    `<g transform="rotate(-90 30 26)">${grug({ eyes: 'closed', workArm: rest })}</g>` +
    `<ellipse cx="34" cy="28" rx="15" ry="9" fill="${fur}" stroke="${C.furDark}" stroke-width=".8">${anim('ry', [8.4, 9.6, 8.4], 3.4)}${anim('cy', [28.6, 27.4, 28.6], 3.4)}</ellipse>` +
    `<circle cx="28" cy="25" r="1.4" fill="${C.furDark}"/><circle cx="38" cy="29" r="1.2" fill="${C.furDark}"/><circle cx="43" cy="23" r="1" fill="${C.furDark}"/>` +
    `</g>`;
  // what rises from the sleeper's head: z's, or frosty breath and a shiver word when cold
  const z = (b: number, s: number) =>
    `<text x="20" y="48" font-family="Impact, sans-serif" font-size="${s}" fill="#9fb3ff" opacity="0">z${move([[0, 0], [14, -12], [30, -24]], 4.2, b)}${anim('opacity', [0, 1, 0.8, 0], 4.2, b)}</text>`;
  const breath = (b: number) =>
    `<circle cx="14" cy="50" r="1.4" fill="#e9f6ff" opacity="0">${move([[0, 0], [8, -4]], 2.4, b)}${anim('opacity', [0, 0.7, 0], 2.4, b)}${anim('r', [1, 3, 4], 2.4, b)}</circle>`;
  const rising = cold
    ? breath(0) + breath(1.2) + word(50, 36, 'brr', '#9fdcff', 6, 3)
    : z(0, 5) + z(1.4, 6.5) + z(2.8, 8);
  return `<g>${shiver}${body}</g><path d="${MOUTH}" fill="#06040a" opacity=".28"/>${rising}`;
}

/** The club leaning on the cave while grug sleeps. */
const LEANING_CLUB = `<g transform="translate(66 ${FLOOR}) rotate(14) translate(-47 -28.6)">${CLUB}</g>`;

const asleep = (a?: string) => a === 'sleep' || a === 'cold';

/** The band above the prompt. Awake, grug stays out by the fire doing the job grugbrain is doing right now (a
 *  pterodactyl crosses the dusk sky now and then); idle, he walks into his cave and sleeps just inside the mouth under
 *  the night sky (shooting stars, fireflies, the fire burnt down); a cold cache snows him in. A change between awake
 *  and asleep (`from`: the act shown before) plays the walk once and the old sky fades out; with no `from` an awake
 *  grug comes out of the cave (a new session). SMIL only (the app's sandboxed frame). */
export function grugStage(act: GrugAct, from?: string): string {
  const down = asleep(act);
  const sky: Sky = act === 'cold' ? 'ice' : down ? 'night' : 'dusk';
  const fire: Fire = act === 'cold' ? 'out' : down ? 'embers' : 'lit';
  const turning = down ? from !== undefined && !asleep(from) : from === undefined || asleep(from);
  const oldSky: Sky | undefined = !turning || from === undefined ? undefined : from === 'cold' ? 'ice' : asleep(from) ? 'night' : 'dusk';
  const T = 2.8;
  let cast: string;
  let fireArt = campfire(fire);
  if (down) {
    const bed = sleeper(act === 'cold') + LEANING_CLUB;
    cast = turning
      ? `<g>${slide([[WORK_X, LIFT], [CAVE_X + 4, LIFT]], T)}${fade([1, 1, 0], T + 0.3)}${walker(true)}</g>` +
        `<g opacity="0">${fade([0, 1], 0.8, T)}${bed}</g>`
      : bed;
    if (turning) fireArt += `<g>${fade([1, 0], 4)}${campfire('lit')}</g>`;
  } else {
    const job = `<g transform="translate(${WORK_X} ${LIFT})">${scene(act).replace(ground(), '')}</g>`;
    if (turning) {
      const puff = (dx: number) =>
        `<circle cx="${WORK_X + 30 + dx}" cy="${FLOOR - 1}" r="1" fill="#d9c3b0" opacity="0">${fade([0, 0.6, 0], 0.8, 1.2 + T)}<animate attributeName="r" values="1;5" dur=".8s" begin="${1.2 + T}s" fill="freeze"/></circle>`;
      cast =
        `<g transform="translate(${CAVE_X} ${LIFT})">${fade([1, 1, 0], 1.3)}${stretcher()}</g>` +
        `<g opacity="0"><set attributeName="opacity" to="1" begin="1.2s" fill="freeze"/><set attributeName="opacity" to="0" begin="${1.2 + T}s" fill="freeze"/>` +
        `<g transform="translate(${CAVE_X} ${LIFT})">${slide([[CAVE_X, LIFT], [WORK_X, LIFT]], T, 1.2)}${walker(false)}</g></g>` +
        `<g opacity="0"><set attributeName="opacity" to="1" begin="${1.2 + T}s" fill="freeze"/>${job}</g>` +
        puff(-8) + puff(8);
      if (from !== undefined) fireArt = campfire('embers') + `<g opacity="0">${fade([0, 1], 3, 0.6)}${campfire('lit')}</g>`;
    } else cast = job;
  }
  const ambient = sky === 'dusk'
    ? ptero(24, 36, 6, 1) + ptero(18, 52, 30, 0.7)
    : sky === 'night' ? shootingStar(420, 6, 13, 4) + shootingStar(820, 10, 19, 11) + fireflies() : snow();
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 ${VIEW_Y} ${STAGE_W} ${VIEW_H}" width="100%" height="100%" preserveAspectRatio="xMinYMid slice" style="display:block"><title>grug: ${grugSay(act).toLowerCase()}</title>` +
    backdrop(sky) +
    (oldSky ? `<g>${fade([1, 0], 4)}${backdrop(oldSky, 'gsky0')}</g>` : '') +
    `${CAVE_BACK}${fireArt}${cast}${CAVE_RIM}${act === 'cold' ? ICICLES : ''}${ambient}</svg>`
  );
}

export interface GrugScene {
  act: GrugAct;
  say: string;
  short: string;
  frames: string[];
  /** grug's stage (SMIL-animated SVG) for the band above the prompt. */
  svg: string;
}

export function grugScene(s: SceneInput): GrugScene {
  const act = pickAct(s);
  return { act, say: grugSay(act, s), short: grugShort(act, s), frames: grugFrames(act), svg: grugStage(act, s.from) };
}
