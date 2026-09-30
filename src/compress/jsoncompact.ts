/**
 * JSON compaction for big API/CLI payloads (gh api, curl, MCP tools). Repetitive arrays of
 * objects are where the waste is: the same 40 keys per item, most of them null, empty, or a
 * URL template. Keeps the first items in full, one identity line per remaining item, drops
 * null/empty fields and `*_url` template noise. The caller stores the untouched original, and
 * the marker says where. Non-JSON or small/irregular JSON is returned unchanged.
 */

export interface JsonCompact {
  text: string;
  changed: boolean;
  items: number;
}

const FULL_ITEMS = 3;
const MAX_LIST_LINES = 120;
const IDENTITY = ['id', 'number', 'name', 'full_name', 'title', 'login', 'path', 'key', 'sha', 'state', 'status', 'type', 'html_url', 'url', 'label', 'email', 'slug'];
const URL_NOISE = /_url$/;
const KEEP_URLS = new Set(['html_url', 'url', 'clone_url']);

function isEmpty(v: unknown): boolean {
  return v === null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v as object).length === 0);
}

function clean(v: any, depth = 0): any {
  if (Array.isArray(v)) return v.map((x) => clean(x, depth + 1));
  if (v && typeof v === 'object') {
    const o: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (isEmpty(val)) continue;
      if (URL_NOISE.test(k) && !KEEP_URLS.has(k) && typeof val === 'string') continue;
      o[k] = depth > 6 ? val : clean(val, depth + 1);
    }
    return o;
  }
  return v;
}

function identity(item: any): string {
  if (item === null || typeof item !== 'object') return String(item).slice(0, 160);
  const parts: string[] = [];
  for (const k of IDENTITY) {
    const val = item[k];
    if (val === undefined || val === null || typeof val === 'object') continue;
    parts.push(`${k}=${String(val).slice(0, 80)}`);
    if (parts.length >= 5) break;
  }
  if (!parts.length) for (const [k, val] of Object.entries(item).slice(0, 4)) if (typeof val !== 'object') parts.push(`${k}=${String(val).slice(0, 60)}`);
  return parts.join(' ');
}

/** Find the main array: the payload itself, or the largest array one level down ({items:[...]}). */
function findList(v: any): { list: any[]; wrap: (l: any[]) => any } | null {
  if (Array.isArray(v)) return { list: v, wrap: (l) => l };
  if (v && typeof v === 'object') {
    let best: string | null = null;
    for (const [k, val] of Object.entries(v)) if (Array.isArray(val) && (!best || (val as any[]).length > (v[best] as any[]).length)) best = k;
    if (best) return { list: v[best], wrap: (l) => ({ ...v, [best as string]: l }) };
  }
  return null;
}

export function compactJson(raw: string, minChars = 12000, minItems = 20): JsonCompact {
  const none: JsonCompact = { text: raw, changed: false, items: 0 };
  const s = raw.trim();
  if (s.length < minChars || (s[0] !== '[' && s[0] !== '{')) return none;
  let parsed: any;
  try {
    parsed = JSON.parse(s);
  } catch {
    return none;
  }
  const found = findList(parsed);
  if (!found || found.list.length < minItems) return none;
  // Only uniform lists of objects: anything else we cannot summarise without guessing.
  const objs = found.list.filter((x) => x && typeof x === 'object' && !Array.isArray(x));
  if (objs.length < found.list.length * 0.9) return none;

  const head = clean(found.list.slice(0, FULL_ITEMS));
  const rest = found.list.slice(FULL_ITEMS);
  const listed = rest.slice(0, MAX_LIST_LINES).map((x) => '  ' + identity(x));
  const more = rest.length > MAX_LIST_LINES ? [`  … and ${rest.length - MAX_LIST_LINES} more`] : [];
  const shell = found.wrap(head);
  const body = JSON.stringify(shell, null, 1);
  const text =
    `[grug: JSON with ${found.list.length} items; first ${FULL_ITEMS} in full (null/empty fields and *_url templates dropped), the other ${rest.length} as one identity line each]\n` +
    body +
    `\n[remaining ${rest.length} items, identity only:]\n` +
    listed.join('\n') +
    (more.length ? '\n' + more.join('\n') : '');
  if (text.length > raw.length * 0.6) return none;
  return { text, changed: true, items: found.list.length };
}
