/**
 * Version tracking via GitHub Releases (the source of truth for grugbrain versions).
 * Checks at most once a day, notify-only; installing an update is always an explicit command.
 */

import * as https from 'node:https';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readJson, VERSION, writeJsonAtomic } from './config.js';

export const REPO = 'swaraj792725/grugbrain'; // renamed from swaraj792725/token-diet (GitHub redirects old URLs)
const DAY = 86400000;

export interface UpdateInfo {
  current: string;
  latest: string | null;
  newer: boolean;
  tag?: string;
  url?: string;
  tarball?: string;
  checkedAt: number;
  error?: string;
}

const file = () => path.join(paths.home(), 'update.json');

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = b.replace(/^v/, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

function getJson(url: string, timeoutMs = 6000, redirects = 3): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': `grugbrain/${VERSION}`, accept: 'application/vnd.github+json' }, timeout: timeoutMs }, (res) => {
      // Renamed repos answer with a redirect; follow it.
      if ([301, 302, 307, 308].includes(res.statusCode || 0) && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(getJson(new URL(res.headers.location, url).toString(), timeoutMs, redirects - 1));
      }
      let t = '';
      res.on('data', (c) => (t += c));
      res.on('end', () => {
        if ((res.statusCode || 500) >= 400) return reject(new Error(`GitHub API ${res.statusCode}`));
        try {
          resolve(JSON.parse(t));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

export function cachedUpdate(): UpdateInfo | null {
  const r = readJson<UpdateInfo>(file());
  if (!r.ok || !r.value?.checkedAt) return null;
  // Re-evaluate against the running version (it may have been upgraded since the check).
  const v = r.value;
  return { ...v, current: VERSION, newer: !!v.latest && compareVersions(v.latest, VERSION) > 0 };
}

/** Fallback when the GitHub API is rate-limited: the web URL /releases/latest redirects to /releases/tag/<tag>. */
function latestTagViaWeb(timeoutMs = 6000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      `https://github.com/${REPO}/releases/latest`,
      { method: 'HEAD', headers: { 'user-agent': `grugbrain/${VERSION}` }, timeout: timeoutMs },
      (res) => {
        res.resume();
        const m = String(res.headers.location || '').match(/\/releases\/tag\/([^/?#]+)/);
        if (m) resolve(decodeURIComponent(m[1]));
        else reject(new Error(`no release redirect (HTTP ${res.statusCode})`));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

async function latestRelease(): Promise<{ tag: string; url: string; tarball?: string }> {
  try {
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    if (!rel.tag_name) throw new Error('no releases found');
    const asset = (rel.assets || []).find((a: any) => /\.tgz$/.test(a.name));
    return { tag: rel.tag_name, url: rel.html_url, tarball: asset?.browser_download_url };
  } catch (apiErr) {
    const tag = await latestTagViaWeb().catch(() => {
      throw apiErr;
    });
    const v = tag.replace(/^v/, '');
    return {
      tag,
      url: `https://github.com/${REPO}/releases/tag/${tag}`,
      tarball: `https://github.com/${REPO}/releases/download/${tag}/grugbrain-${v}.tgz`
    };
  }
}

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const cached = cachedUpdate();
  if (!force && cached && Date.now() - cached.checkedAt < DAY) return cached;
  try {
    const rel = await latestRelease();
    const tag = rel.tag;
    const latest = tag.replace(/^v/, '');
    const info: UpdateInfo = {
      current: VERSION,
      latest,
      newer: compareVersions(latest, VERSION) > 0,
      tag,
      url: rel.url,
      tarball: rel.tarball,
      checkedAt: Date.now()
    };
    writeJsonAtomic(file(), info);
    return info;
  } catch (err: any) {
    // Failed checks retry after an hour instead of a day.
    const info: UpdateInfo = { current: VERSION, latest: cached?.latest ?? null, newer: false, checkedAt: Date.now() - DAY + 3600000, error: err.message };
    writeJsonAtomic(file(), info);
    return info;
  }
}

/** Install a release: npm when published there, else the release tarball, else the git tag. */
export function installRelease(info: UpdateInfo, extraArgs: string[] = []): number {
  const onNpm = spawnSync('npm', ['view', `grugbrain@${info.latest}`, 'version'], { encoding: 'utf8', timeout: 20000 }).stdout?.trim() === info.latest;
  const spec = onNpm ? `grugbrain@${info.latest}` : info.tarball || `github:${REPO}#${info.tag}`;
  const r = spawnSync('npx', ['--yes', `--package=${spec}`, 'grugbrain', 'install', ...extraArgs], { stdio: 'inherit' });
  return r.status ?? 1;
}
