/**
 * grug in the Claude desktop chat: an MCP App (a `ui://` resource the chat draws as a card when the
 * grug_status tool runs). Shows grug's stage, the week's savings and the open Code sessions the chat can message.
 */

import * as path from 'node:path';
import { VERSION } from './config.js';
import { grugScene } from './grugart.js';
import { cachedSaved, lastAction } from './statusline.js';
import { ago, liveSessions, outstanding } from './bridge.js';

export const CARD_URI = 'ui://grug/card';
export const APP_MIME = 'text/html;profile=mcp-app';

export interface CardData {
  act: string;
  say: string;
  svg: string;
  savedPct?: number;
  netUsd?: number;
  recent?: string;
  sessions: { project: string; cwd: string; busy: boolean; seen: string }[];
  waiting: number;
}

export function cardData(now = Date.now()): CardData {
  const saved = cachedSaved(now);
  const last = lastAction(now);
  const sessions = liveSessions(now);
  const busy = sessions.some((s) => s.busy);
  const idleMs = last ? now - last.ts : Infinity;
  const g = grugScene({ kind: last?.kind, alerts: [], busy, idleMs: busy ? 0 : idleMs, savedPct: saved?.pct, netUsd: saved?.netUsd });
  return {
    act: g.act,
    say: g.say,
    svg: g.svg,
    savedPct: saved?.pct,
    netUsd: saved?.netUsd,
    recent: last && now - last.ts < 3600_000 ? last.msg : undefined,
    sessions: sessions.map((s) => ({ project: path.basename(s.cwd), cwd: s.cwd, busy: !!s.busy, seen: ago(now - s.seen) })),
    waiting: outstanding().length
  };
}

export function cardText(d: CardData): string {
  const head = [
    `grug: ${d.say.toLowerCase()}`,
    d.savedPct !== undefined ? `${Math.round(d.savedPct * 100)}% saved this week` : '',
    d.netUsd !== undefined && d.netUsd >= 1 ? `~$${Math.round(d.netUsd)} (estimate)` : ''
  ].filter(Boolean).join(' · ');
  const ss = d.sessions.length
    ? d.sessions.map((s) => `- ${s.project} · ${s.busy ? 'working' : 'idle'} · ${s.cwd}`).join('\n')
    : '- none open (open a Code session in the desktop app to message it)';
  return `${head}\nOpen Code sessions (ask_code can message them):\n${ss}${d.waiting ? `\n${d.waiting} message(s) waiting for a Code reply (code_inbox).` : ''}`;
}

/** The card page. Drawn with the numbers as they are when the chat reads the resource; a later tool result
 *  (`ui/notifications/tool-result` with structuredContent) redraws it in place. */
export function cardHtml(d: CardData = cardData()): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
:root{--bg:#1b1410;--fg:#f3e6d6;--dim:#b9a58f;--line:#3a2c22;--ok:#9fd37a;--busy:#f2b25c}
@media (prefers-color-scheme: light){:root{--bg:#fbf6ef;--fg:#2b2018;--dim:#7a6654;--line:#e6d9c8;--ok:#3f8a2a;--busy:#b8741a}}
*{box-sizing:border-box}html,body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,sans-serif}
.stage{height:72px;overflow:hidden;border-radius:10px 10px 0 0}
.stage svg{width:100%;height:100%;display:block}
.body{padding:10px 14px 12px;border:1px solid var(--line);border-top:0;border-radius:0 0 10px 10px}
.row{display:flex;gap:14px;align-items:baseline;flex-wrap:wrap}
.big{font-size:20px;font-weight:650}.dim{color:var(--dim)}
ul{list-style:none;margin:8px 0 0;padding:0}li{display:flex;gap:8px;align-items:center;padding:3px 0;border-top:1px solid var(--line)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok);flex:none}.dot.busy{background:var(--busy)}
.cwd{color:var(--dim);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
</style></head><body>
<div class="stage" id="stage">${d.svg}</div>
<div class="body"><div class="row"><span class="big" id="pct"></span><span id="usd" class="dim"></span><span id="say"></span></div>
<div class="dim" id="recent"></div><ul id="ss"></ul><div class="dim" id="wait"></div></div>
<script>
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function draw(d){
  if(d.svg&&d.svg!==draw.svg){document.getElementById('stage').innerHTML=d.svg;draw.svg=d.svg}
  document.getElementById('pct').textContent=d.savedPct!=null?Math.round(d.savedPct*100)+'% saved':'grug on';
  document.getElementById('usd').textContent=d.netUsd>=1?'~$'+Math.round(d.netUsd)+' this week (estimate)':'';
  document.getElementById('say').textContent=(d.say||'').toLowerCase();
  document.getElementById('recent').textContent=d.recent||'';
  document.getElementById('ss').innerHTML=(d.sessions||[]).length?d.sessions.map(s=>'<li><span class="dot'+(s.busy?' busy':'')+'"></span><b>'+esc(s.project)+'</b><span class="dim">'+(s.busy?'working':'idle')+'</span><span class="cwd">'+esc(s.cwd)+'</span></li>').join(''):'<li class="dim">No Code session open: chat can message one once it is.</li>';
  document.getElementById('wait').textContent=d.waiting?d.waiting+' message(s) waiting for a Code reply':'';
  size();
}
const send=m=>{try{parent.postMessage(m,'*')}catch(e){}};
function size(){send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight}})}
addEventListener('message',e=>{const m=e.data;if(!m||m.jsonrpc!=='2.0')return;
  if(m.id===1&&(m.result||m.error)){send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});size()}
  if(m.method==='ui/notifications/tool-result'){const sc=m.params&&m.params.structuredContent;if(sc)draw(sc)}
  if(m.method==='ui/resource-teardown'&&m.id!=null)send({jsonrpc:'2.0',id:m.id,result:{}});
});
send({jsonrpc:'2.0',id:1,method:'ui/initialize',params:{protocolVersion:'2026-01-26',appInfo:{name:'grugbrain',version:${JSON.stringify(VERSION)}},appCapabilities:{}}});
draw(${JSON.stringify({ ...d, svg: undefined }).replace(/</g, '\\u003c')});draw.svg=1;
</script></body></html>`;
}
