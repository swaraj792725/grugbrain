/**
 * Self-contained interactive memory graph (one HTML file, no network, no dependencies).
 * Regenerated automatically after each consolidation at ~/.grug/graph.html.
 */

import { writeFileAtomic } from '../config.js';
import { MemoryDB, projectName, score } from './store.js';

export function renderGraphHtml(db: MemoryDB, halfLife: number): string {
  const nodes = Object.values(db.nodes).map((n) => {
    const s = score(n, halfLife);
    return {
      id: n.id,
      t: n.type,
      l: n.label.length > 90 ? n.label.slice(0, 89) + '…' : n.label,
      p: projectName(n.project),
      s: s === Infinity ? 10 : Math.round(s * 100) / 100,
      u: n.updated,
      o: n.data?.outcome ? String(n.data.outcome).slice(0, 300) : ''
    };
  });
  const edges = Object.values(db.edges).map((e) => [e.a, e.b, e.w]);
  const data = JSON.stringify({ nodes, edges, generated: Date.now() }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>grugbrain memory graph</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1b18;--mut:#6b665e;--card:#ffffffee;--line:#00000022;
--project:#c2410c;--session:#2563eb;--file:#059669;--topic:#9333ea;--note:#d97706;--digest:#64748b}
@media (prefers-color-scheme:dark){:root{--bg:#15130f;--fg:#ece8e1;--mut:#a39e94;--card:#1f1c17ee;--line:#ffffff22}}
*{box-sizing:border-box}html,body{margin:0;height:100%;background:var(--bg);color:var(--fg);font:14px/1.4 ui-sans-serif,system-ui,-apple-system,sans-serif}
canvas{display:block;width:100vw;height:100vh;cursor:grab}
#ui{position:fixed;top:12px;left:12px;right:12px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;pointer-events:none}
#ui>*{pointer-events:auto}
h1{font-size:15px;margin:0 8px 0 0}
input,select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:6px 10px;font:inherit}
.chip{display:inline-flex;align-items:center;gap:5px;background:var(--card);border:1px solid var(--line);border-radius:99px;padding:3px 9px;font-size:12px;cursor:pointer;user-select:none}
.chip i{width:9px;height:9px;border-radius:50%;display:inline-block}.chip.off{opacity:.35}
#info{position:fixed;bottom:12px;left:12px;max-width:min(460px,calc(100vw - 24px));background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px;display:none}
#info b{display:block;margin-bottom:4px}#info small{color:var(--mut)}
#stats{color:var(--mut);font-size:12px}
</style></head><body>
<canvas id="c"></canvas>
<div id="ui"><h1>🪨 grugbrain memory</h1>
<input id="q" placeholder="search…" size="16">
<select id="proj"><option value="">all projects</option></select>
<span id="legend"></span><span id="stats"></span></div>
<div id="hint" style="position:fixed;bottom:12px;right:12px;color:var(--mut);font-size:12px">drag · scroll to zoom · click node · f to fit</div>
<div id="info"></div>
<script>
const D=${data};
const css=getComputedStyle(document.documentElement);
const col=t=>css.getPropertyValue('--'+t).trim()||'#888';
const types=['project','session','digest','file','topic','note'];
const hidden=new Set();
const legend=document.getElementById('legend');
types.forEach(t=>{const c=document.createElement('span');c.className='chip';c.innerHTML='<i style="background:'+col(t)+'"></i>'+t;c.onclick=()=>{hidden.has(t)?hidden.delete(t):hidden.add(t);c.classList.toggle('off');};legend.appendChild(c)});
const projSel=document.getElementById('proj');
[...new Set(D.nodes.map(n=>n.p))].sort().forEach(p=>{const o=document.createElement('option');o.value=o.textContent=p;projSel.appendChild(o)});
const cv=document.getElementById('c'),ctx=cv.getContext('2d');let W,H,dpr;
function size(){dpr=devicePixelRatio||1;W=innerWidth;H=innerHeight;cv.width=W*dpr;cv.height=H*dpr}size();addEventListener('resize',size);
const byId=new Map();D.nodes.forEach((n,i)=>{const a=i*2.399;const r=30+Math.sqrt(i)*18;n.x=Math.cos(a)*r;n.y=Math.sin(a)*r;n.vx=0;n.vy=0;n.r=n.t==='project'?11:n.t==='digest'?8:3+Math.min(6,Math.sqrt(n.s)*2);byId.set(n.id,n)});
const E=D.edges.map(([a,b,w])=>[byId.get(a),byId.get(b),w]).filter(e=>e[0]&&e[1]);
document.getElementById('stats').textContent=D.nodes.length+' nodes · '+E.length+' links · updated '+new Date(D.generated).toLocaleString();
let view={x:0,y:0,k:1},alpha=1;
function visible(n){return !hidden.has(n.t)&&(!projSel.value||n.p===projSel.value)}
function tick(){const N=D.nodes.filter(visible);if(alpha<0.005)return;
for(let i=0;i<N.length;i++){const a=N[i];for(let j=i+1;j<N.length;j++){const b=N[j];let dx=a.x-b.x,dy=a.y-b.y,d2=dx*dx+dy*dy+.01;if(d2>90000)continue;const f=900/d2*alpha;a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f}}
E.forEach(([a,b,w])=>{if(!visible(a)||!visible(b))return;const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)+.01;const L=a.t==='project'||b.t==='project'?120:50;const f=(d-L)/d*0.02*alpha*Math.min(3,1+Math.log1p(w));a.vx+=dx*f;a.vy+=dy*f;b.vx-=dx*f;b.vy-=dy*f});
N.forEach(n=>{n.vx-=n.x*0.012*alpha;n.vy-=n.y*0.012*alpha;if(n!==drag){n.x+=n.vx;n.y+=n.vy}n.vx*=.6;n.vy*=.6});alpha*=.992}
const q=document.getElementById('q');let sel=null,hover=null,drag=null,frame=0,userMoved=false;
function fit(){const N=D.nodes.filter(visible);if(!N.length)return;let x0=1e9,y0=1e9,x1=-1e9,y1=-1e9;N.forEach(n=>{x0=Math.min(x0,n.x);y0=Math.min(y0,n.y);x1=Math.max(x1,n.x);y1=Math.max(y1,n.y)});
const k=Math.min(2,Math.min((W-60)/(x1-x0+80),(H-140)/(y1-y0+80)));view.k=k;view.x=-(x0+x1)/2*k;view.y=-(y0+y1)/2*k+30}
function draw(){tick();frame++;if(!userMoved&&(frame<240?frame%20===0:frame%120===0))fit();ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,W,H);ctx.translate(W/2+view.x,H/2+view.y);ctx.scale(view.k,view.k);
const term=q.value.toLowerCase();const focus=sel||hover;const nb=new Set();if(focus)E.forEach(([a,b])=>{if(a===focus)nb.add(b);if(b===focus)nb.add(a)});
ctx.lineWidth=1/view.k;E.forEach(([a,b,w])=>{if(!visible(a)||!visible(b))return;const on=focus&&(a===focus||b===focus);ctx.strokeStyle=on?col(focus.t):css.getPropertyValue('--line');ctx.globalAlpha=focus&&!on?.25:1;ctx.beginPath();ctx.moveTo(a.x,a.y);ctx.lineTo(b.x,b.y);ctx.stroke()});
D.nodes.forEach(n=>{if(!visible(n))return;const match=!term||n.l.toLowerCase().includes(term);ctx.globalAlpha=(!match||(focus&&n!==focus&&!nb.has(n)))?.18:1;ctx.fillStyle=col(n.t);ctx.beginPath();ctx.arc(n.x,n.y,n.r,0,7);ctx.fill();
if((n.t==='project'||n.t==='digest'||n===focus||nb.has(n)||(term&&match))&&view.k>.4){ctx.fillStyle=css.getPropertyValue('--fg');ctx.font=(n.t==='project'?13:11)/view.k+'px system-ui';ctx.fillText(n.l.slice(0,48),n.x+n.r+3,n.y+4)}});
ctx.globalAlpha=1;requestAnimationFrame(draw)}draw();
function pick(ev){const x=(ev.clientX-W/2-view.x)/view.k,y=(ev.clientY-H/2-view.y)/view.k;let best=null,bd=1e9;D.nodes.forEach(n=>{if(!visible(n))return;const d=(n.x-x)**2+(n.y-y)**2;if(d<bd&&d<(n.r+6)**2/Math.min(1,view.k)){bd=d;best=n}});return best}
let pan=null;
cv.onpointerdown=e=>{const n=pick(e);if(n){drag=n;alpha=Math.max(alpha,.3)}else{pan={x:e.clientX-view.x,y:e.clientY-view.y};userMoved=true}};
cv.onpointermove=e=>{if(drag){drag.x=(e.clientX-W/2-view.x)/view.k;drag.y=(e.clientY-H/2-view.y)/view.k}else if(pan){view.x=e.clientX-pan.x;view.y=e.clientY-pan.y}else hover=pick(e)};
cv.onpointerup=e=>{if(drag){const n=drag;drag=null;show(n)}else if(pan){pan=null}};
cv.onwheel=e=>{e.preventDefault();userMoved=true;const k=Math.exp(-e.deltaY*.0015);view.k=Math.max(.15,Math.min(5,view.k*k))};
const info=document.getElementById('info');
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
function show(n){sel=n;info.style.display='block';const links=E.filter(([a,b])=>a===n||b===n).length;info.innerHTML='<b>'+esc(n.l)+'</b><small>'+n.t+' · '+esc(n.p)+' · score '+n.s+' · '+links+' links · '+new Date(n.u).toLocaleDateString()+'</small>'+(n.o?'<p>'+esc(n.o)+'</p>':'')}
addEventListener('keydown',e=>{if(e.key==='Escape'){sel=null;info.style.display='none'}if(e.key==='f'&&document.activeElement!==q){userMoved=false;fit()}});
[q,projSel].forEach(el=>el.oninput=()=>{alpha=Math.max(alpha,.2);userMoved=false;frame=0});
</script></body></html>`;
}

export function writeGraphHtml(db: MemoryDB, file: string, halfLife: number): void {
  writeFileAtomic(file, renderGraphHtml(db, halfLife));
}
