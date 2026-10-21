/** grug the caveman for the grug-live band: one animated SVG scene per thing grug is doing (SMIL, so the
 *  surface animates it with no redraws), a caveman line to say, and text frames for surfaces without SVG. */
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
    case 'subagent': case 'routing':
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
}

const NAP_MS = 20 * 60000;

/** Pick the scene: alerts first, then grug's own latest action, then Claude working, then idle moods. */
export function pickAct(s: SceneInput): GrugAct {
  const alert = s.alerts?.[0] ?? '';
  if (alert) return /cache/i.test(alert) ? 'cold' : 'alarm';
  const a = actFor(s.kind);
  if (a) return a;
  if (s.busy) return 'work';
  if ((s.idleMs ?? 0) > NAP_MS) return 'sleep';
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

/** Text frames (cycled once a second) for surfaces that draw no SVG, and for the status entry. */
export function grugFrames(act: GrugAct): string[] {
  switch (act) {
    case 'smash': return ['ᕦ(ò_ó)ᕤ🦴 🪨', '(ง ò_ó)ง🦴💥', 'ᕦ(ò_ó)ᕤ  ·.·'];
    case 'dig': return ['(ò_ó)⛏ ▂▃', '(ò_ó)⛏ ▃▅', '(ò_ó)⛏ 💎'];
    case 'guard': return ['(ò_ó)🛡 📄', '(ò_ó)🛡📄', '(ò_ó)🛡  📄'];
    case 'map': return ['(ò_ó)📜 ·', '(ò_ó)📜 ·─·', '(ò_ó)📜 ·─·─·'];
    case 'carry': return ['🗿/(ò_ó)\\ ', ' 🗿/(ò_ó)\\', '🗿/(ò_ó)\\ '];
    case 'check': return ['(ò_ó)🔍 ▢', '(ò_ó) 🔍▢', '(ò_ó)🔍 ✅'];
    case 'shrink': return ['(ò_ó)🦴 🖼', '(ò_ó)🦴 ▫', '(ò_ó)🦴 🖼'];
    case 'send': return ['(ò_ó)/ ᕕ(•_•)', '(ò_ó)/   ᕕ(•_•)', '(ò_ó)/     ᕕ(•_•)'];
    case 'alarm': return ['(⊙_⊙)!', '\\(⊙o⊙)/!!', '(⊙_⊙)!'];
    case 'cold': return ['(⊙_⊙)❄', '(⊙o⊙)❄!', '(⊙_⊙) ❄'];
    case 'sleep': return ['(-_-) z', '(-_-)  zZ', '(-_-)   zZz'];
    case 'work': return ['(ò_ó)🦴', '(ò_ó)🦴.', '(ò_ó)🦴..', '(ò_ó)🦴...'];
    case 'proud': return ['ᕦ(ò‿ó)ᕤ ✨', 'ᕦ(ò‿ó)ᕤ💰', 'ᕦ(ò‿ó)ᕤ ✨'];
    default: return ['(ò_ó)', '(ò_ó)', '(-_ó)', '(ò_ó)'];
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

export interface GrugScene {
  act: GrugAct;
  say: string;
  svg: string;
  frames: string[];
}

export function grugScene(s: SceneInput): GrugScene {
  const act = pickAct(s);
  return { act, say: grugSay(act, s), svg: grugSvg(act), frames: grugFrames(act) };
}
