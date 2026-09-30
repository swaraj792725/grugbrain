/**
 * Images, PDFs and video without paying for them twice.
 *
 * Token facts (measured with Claude Code 2.1): an image costs about 1 token per 880 pixels plus ~330
 * of tool overhead, and Claude Code shrinks anything past ~1.3 megapixels first, so one image tops
 * out near 1.5k tokens. The real cost is that every image stays in the context and is
 * re-read on each later reply. So grug (1) skips repeats, (2) can shrink big image files before they
 * are read, (3) gives text-first ways into PDFs and frame sheets for video.
 *
 * Zero dependencies: PNG resizing is done in JS (zlib ships with Node); other formats use sips
 * (macOS), ImageMagick or ffmpeg when present, otherwise they are left alone.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';

export const IMAGE_RE = /\.(png|jpe?g|gif|webp)$/i;
export const PDF_RE = /\.pdf$/i;
export const VIDEO_RE = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

/**
 * Measured in Claude Code 2.1 (400x250 -> +440 tokens, 1000x625 -> +1038, 2400x1500 -> +1803, each with
 * ~330 of tool overhead): an image is shrunk to about 1.3 megapixels and costs ~1 token per 880 pixels.
 */
const API_LONG_EDGE = 1568;
const PIXEL_CAP = 1_300_000;
const PIXELS_PER_TOKEN = 880;

export interface ImageSize {
  w: number;
  h: number;
  type: 'png' | 'jpeg' | 'gif' | 'webp';
}

/** Width/height from the first bytes of an image (PNG, JPEG, GIF, WebP). */
export function imageSizeOf(b: Buffer): ImageSize | null {
  try {
    if (b.length > 24 && b.readUInt32BE(0) === 0x89504e47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
    if (b.length > 10 && b.toString('latin1', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), type: 'gif' };
    if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
      const kind = b.toString('latin1', 12, 16);
      if (kind === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
      if (kind === 'VP8L') {
        const v = b.readUInt32LE(21);
        return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, type: 'webp' };
      }
      if (kind === 'VP8X') return { w: (b.readUIntLE(24, 3) & 0xffffff) + 1, h: (b.readUIntLE(27, 3) & 0xffffff) + 1, type: 'webp' };
    }
    if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const m = b[i + 1];
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          i += 2;
          continue;
        }
        const len = b.readUInt16BE(i + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5), type: 'jpeg' };
        i += 2 + len;
      }
    }
  } catch {
    /* truncated header */
  }
  return null;
}

export function imageSizeOfFile(file: string): ImageSize | null {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024); // JPEG frame headers can sit behind EXIF/ICC blocks
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return imageSizeOf(buf.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Tokens one image costs once it is in context (after the API's own shrink). */
export function estimateImageTokens(w: number, h: number): number {
  if (!w || !h) return 1500;
  const s = Math.min(1, API_LONG_EDGE / Math.max(w, h), Math.sqrt(PIXEL_CAP / (w * h)));
  return Math.max(60, Math.round((w * s * (h * s)) / PIXELS_PER_TOKEN));
}

/** Size from a base64 image (a tool result's image block): decodes only the header. */
export function imageSizeOfBase64(b64: string): ImageSize | null {
  try {
    return imageSizeOf(Buffer.from(b64.slice(0, 350000), 'base64'));
  } catch {
    return null;
  }
}

// ---------- PNG resize (pure JS) ----------

interface Decoded {
  w: number;
  h: number;
  channels: number; // 1 gray, 2 gray+alpha, 3 rgb, 4 rgba
  data: Uint8Array;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 8-bit, non-interlaced PNG (gray / gray+alpha / RGB / RGBA / palette). Anything else: null. */
export function decodePng(buf: Buffer): Decoded | null {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let pos = 8;
  let w = 0;
  let h = 0;
  let depth = 0;
  let ctype = 0;
  let interlace = 0;
  let palette: Buffer | null = null;
  let trns: Buffer | null = null;
  const idat: Buffer[] = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('latin1', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      depth = body[8];
      ctype = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (!w || !h || depth !== 8 || interlace !== 0 || w * h > 60_000_000) return null;
  const chan = ctype === 0 ? 1 : ctype === 2 ? 3 : ctype === 3 ? 1 : ctype === 4 ? 2 : ctype === 6 ? 4 : 0;
  if (!chan || (ctype === 3 && !palette)) return null;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = w * chan;
  if (raw.length < (stride + 1) * h) return null;
  const px = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const up = dst - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= chan ? px[dst + x - chan] : 0;
      const b = y > 0 ? px[up + x] : 0;
      const c = x >= chan && y > 0 ? px[up + x - chan] : 0;
      const v = raw[src + x];
      px[dst + x] = f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : v + paeth(a, b, c);
    }
  }
  if (ctype !== 3) return { w, h, channels: chan, data: px };
  // palette -> RGB(A)
  const hasAlpha = !!trns;
  const out = new Uint8Array(w * h * (hasAlpha ? 4 : 3));
  for (let i = 0; i < w * h; i++) {
    const k = px[i] * 3;
    if (hasAlpha) {
      out[i * 4] = palette![k];
      out[i * 4 + 1] = palette![k + 1];
      out[i * 4 + 2] = palette![k + 2];
      out[i * 4 + 3] = px[i] < trns!.length ? trns![px[i]] : 255;
    } else {
      out[i * 3] = palette![k];
      out[i * 3 + 1] = palette![k + 1];
      out[i * 3 + 2] = palette![k + 2];
    }
  }
  return { w, h, channels: hasAlpha ? 4 : 3, data: out };
}

let crcTable: Uint32Array | null = null;
function crc32(b: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(img: Decoded): Buffer {
  const { w, h, channels, data } = img;
  const stride = w * channels;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 1; // Sub filter: much smaller than None for smooth images
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      raw[y * (stride + 1) + 1 + x] = (data[y * stride + x] - left) & 0xff;
    }
  }
  const chunk = (t: string, d: Buffer) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(d.length, 0);
    head.write(t, 4, 'latin1');
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), d])), 0);
    return Buffer.concat([head, d, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

/** Area-average downscale so the long edge is `maxEdge`. Never upscales. */
export function shrinkImage(img: Decoded, maxEdge: number): Decoded {
  const scale = Math.min(1, maxEdge / Math.max(img.w, img.h));
  if (scale >= 1) return img;
  const nw = Math.max(1, Math.round(img.w * scale));
  const nh = Math.max(1, Math.round(img.h * scale));
  const ch = img.channels;
  const out = new Uint8Array(nw * nh * ch);
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor((y * img.h) / nh);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * img.h) / nh));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor((x * img.w) / nw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * img.w) / nw));
      for (let c = 0; c < ch; c++) {
        let sum = 0;
        for (let yy = y0; yy < y1; yy++) {
          const row = yy * img.w * ch + c;
          for (let xx = x0; xx < x1; xx++) sum += img.data[row + xx * ch];
        }
        out[(y * nw + x) * ch + c] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return { w: nw, h: nh, channels: ch, data: out };
}

// ---------- external tools ----------

const found = new Map<string, boolean>();
/** Is `cmd` on PATH? (cached per process) */
export function hasTool(cmd: string): boolean {
  const key = `${process.env.PATH}|${cmd}`;
  let ok = found.get(key);
  if (ok === undefined) {
    ok = false;
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      try {
        if (dir && fs.statSync(path.join(dir, cmd)).isFile()) {
          ok = true;
          break;
        }
      } catch {
        /* not here */
      }
    }
    found.set(key, ok);
  }
  return ok;
}

function run(cmd: string, args: string[], timeout = 15000) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
}

/** Write a copy of `src` with its long edge at most `maxEdge` to `dst`. False when it cannot. */
export function resizeImageFile(src: string, dst: string, maxEdge: number): boolean {
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const head = imageSizeOfFile(src);
    if (!head) return false;
    if (head.type === 'png') {
      const img = decodePng(fs.readFileSync(src));
      if (img) {
        fs.writeFileSync(dst, encodePng(shrinkImage(img, maxEdge)));
        return true;
      }
    }
    if (hasTool('sips')) {
      const r = run('sips', ['-Z', String(maxEdge), src, '--out', dst]);
      if (r.status === 0 && fs.existsSync(dst)) return true;
    }
    for (const bin of ['magick', 'convert']) {
      if (!hasTool(bin)) continue;
      const r = run(bin, [src, '-resize', `${maxEdge}x${maxEdge}>`, dst]);
      if (r.status === 0 && fs.existsSync(dst)) return true;
    }
    if (hasTool('ffmpeg')) {
      const r = run('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-vf', `scale='min(${maxEdge},iw)':'min(${maxEdge},ih)':force_original_aspect_ratio=decrease`, '-frames:v', '1', dst]);
      if (r.status === 0 && fs.existsSync(dst)) return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

// ---------- PDF ----------

/** Page count without a PDF library: /Count of the page tree root, else /Type /Page objects. */
export function pdfPageCount(file: string): number {
  try {
    if (hasTool('pdfinfo')) {
      const r = run('pdfinfo', [file], 8000);
      const m = /^Pages:\s+(\d+)/m.exec(r.stdout || '');
      if (r.status === 0 && m) return Number(m[1]);
    }
    const s = fs.readFileSync(file).toString('latin1');
    const counts = [...s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
    if (counts.length) return Math.max(...counts);
    return (s.match(/\/Type\s*\/Page\b(?!s)/g) || []).length;
  } catch {
    return 0;
  }
}

/** "1-5", "3", "1,4-6" -> number of pages (0 when it cannot be parsed). */
export function countPageRange(spec: string | undefined, total: number): number {
  if (!spec) return total;
  let n = 0;
  for (const part of String(spec).split(',')) {
    const m = /^\s*(\d+)\s*(?:-\s*(\d+))?\s*$/.exec(part);
    if (!m) return 0;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    n += Math.max(0, b - a + 1);
  }
  return n;
}

export interface PdfTextResult {
  ok: boolean;
  text: string;
  pages: number;
  from: number;
  to: number;
  /** Pages in the range with almost no text: scans or figures. Read these as images. */
  imagePages: number[];
  truncated: boolean;
}

/** Text of pages [from..to] via pdftotext (poppler; Claude Code needs it for PDF pages anyway). */
export function pdfText(file: string, from = 1, to = 0, maxChars = 24000): PdfTextResult {
  const empty: PdfTextResult = { ok: false, text: '', pages: 0, from, to, imagePages: [], truncated: false };
  if (!hasTool('pdftotext')) return { ...empty, text: 'pdftotext is not installed (brew install poppler / apt install poppler-utils). Use Read with a pages range instead.' };
  const pages = pdfPageCount(file);
  const last = Math.min(to > 0 ? to : from + 19, pages || from + 19);
  const r = run('pdftotext', ['-layout', '-f', String(from), '-l', String(last), file, '-'], 30000);
  if (r.status !== 0) return { ...empty, pages, text: `pdftotext failed: ${(r.stderr || '').slice(0, 200)}` };
  const chunks = (r.stdout || '').split('\f');
  if (chunks.length && !chunks[chunks.length - 1].trim()) chunks.pop();
  const imagePages: number[] = [];
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  chunks.forEach((c, i) => {
    const page = from + i;
    const t = c.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.length < 40) imagePages.push(page);
    if (truncated) return;
    const block = `--- page ${page} ---\n${t || '(no text: scan or figure)'}\n`;
    if (used + block.length > maxChars) {
      truncated = true;
      return;
    }
    parts.push(block);
    used += block.length;
  });
  return { ok: true, text: parts.join('\n'), pages: pages || last, from, to: last, imagePages, truncated };
}

// ---------- video ----------

export interface FramesResult {
  ok: boolean;
  message: string;
  sheet?: string;
  times: number[];
}

function probeDuration(file: string): number {
  if (!hasTool('ffprobe')) return 0;
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], 10000);
  return Number((r.stdout || '').trim()) || 0;
}

/** One contact-sheet image of `count` evenly spaced frames (costs about one image, not `count`). */
export function videoFrames(file: string, outDir: string, count = 9, from = 0, to = 0, tileEdge = 480): FramesResult {
  if (!hasTool('ffmpeg')) return { ok: false, message: 'ffmpeg is not installed (brew install ffmpeg / apt install ffmpeg).', times: [] };
  const dur = probeDuration(file);
  const start = Math.max(0, from);
  const end = to > 0 ? to : dur;
  const n = Math.max(1, Math.min(16, Math.round(count)));
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push(end > start ? Math.round((start + ((i + 0.5) * (end - start)) / n) * 10) / 10 : start + i);
  fs.mkdirSync(outDir, { recursive: true });
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  const sheet = path.join(outDir, `frames-${path.basename(file).replace(/[^\w.-]/g, '_')}-${Math.round(start)}-${Math.round(end)}-${n}.jpg`);
  let got = 0;
  for (let i = 0; i < n; i++) {
    const f = path.join(outDir, `tmp${String(got + 1).padStart(3, '0')}.jpg`);
    const r = run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(times[i]), '-i', file, '-frames:v', '1', '-vf', `scale=${tileEdge}:-2`, f], 30000);
    if (r.status === 0 && fs.existsSync(f)) got++;
  }
  const cleanup = () => {
    for (let i = 1; i <= n; i++) fs.rmSync(path.join(outDir, `tmp${String(i).padStart(3, '0')}.jpg`), { force: true });
  };
  if (!got) {
    cleanup();
    return { ok: false, message: 'Could not read frames from this video.', times };
  }
  const r = run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', '1', '-i', path.join(outDir, 'tmp%03d.jpg'), '-vf', `tile=${Math.min(cols, got)}x${Math.ceil(got / cols) || rows}`, '-frames:v', '1', sheet], 60000);
  cleanup();
  if (r.status !== 0 || !fs.existsSync(sheet)) return { ok: false, message: `Could not build the frame sheet: ${(r.stderr || '').slice(0, 200)}`, times };
  return { ok: true, message: '', sheet, times: times.slice(0, got) };
}

export function videoDuration(file: string): number {
  return probeDuration(file);
}
