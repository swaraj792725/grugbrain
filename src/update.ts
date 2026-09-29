/**
 * Version tracking via GitHub Releases (the source of truth for grugbrain versions).
 * Checks at most once a day, notify-only; installing an update is always an explicit command.
 */

import * as https from 'node:https';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { paths, readJson, VERSION, writeJsonAtomic } from './config.js';

export const REPO = 'swaraj792725/token-diet';
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

function getJson(url: string, timeoutMs = 6000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'user-agent': `grugbrain/${VERSION}`, accept: 'application/vnd.github+json' }, timeout: timeoutMs }, (res) => {
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

export async function checkForUpdate(force = false): Promise<UpdateInfo> {
  const cached = cachedUpdate();
  if (!force && cached && Date.now() - cached.checkedAt < DAY) return cached;
  try {
    const rel = await getJson(`https://api.github.com/repos/${REPO}/releases/latest`);
    const tag: string = rel.tag_name;
    const latest = tag.replace(/^v/, '');
    const asset = (rel.assets || []).find((a: any) => /\.tgz$/.test(a.name));
    const info: UpdateInfo = {
      current: VERSION,
      latest,
      newer: compareVersions(latest, VERSION) > 0,
      tag,
      url: rel.html_url,
      tarball: asset?.browser_download_url,
      checkedAt: Date.now()
    };
    writeJsonAtomic(file(), info);
    return info;
  } catch (err: any) {
    const info: UpdateInfo = { current: VERSION, latest: cached?.latest ?? null, newer: false, checkedAt: Date.now(), error: err.message };
    writeJsonAtomic(file(), info);
    return info;
  }
}

/** Install a release: prefer the release tarball, else the git tag. Re-runs `install` from the new version. */
export function installRelease(info: UpdateInfo, extraArgs: string[] = []): number {
  const spec = info.tarball || `github:${REPO}#${info.tag}`;
  const r = spawnSync('npx', ['--yes', `--package=${spec}`, 'grugbrain', 'install', ...extraArgs], { stdio: 'inherit' });
  return r.status ?? 1;
}
