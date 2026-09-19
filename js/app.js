/* VSRG lite — ultra lightweight 4K VSRG engine (vanilla, no deps) */
'use strict';
const $ = id => document.getElementById(id);
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const fmtT = ms => { ms=Math.max(0,Math.round(ms)); const s=Math.floor(ms/1000); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };

/* ============ SETTINGS ============ */
const DEF = { scroll:20, offset:0, rate:1.0, tap:true, tapVol:50, bgm:80,
  laneW:100, noteSize:100, judgePos:86, keys:['KeyD','KeyF','KeyJ','KeyK'], lastDiff:1 };
let S = {...DEF};
try{ const j=JSON.parse(localStorage.getItem('vsrg_s1')||'{}'); S={...DEF,...j}; if(!Array.isArray(S.keys)||S.keys.length!==4)S.keys=[...DEF.keys]; }catch(e){}
let saveT=null;
function save(){ clearTimeout(saveT); saveT=setTimeout(()=>{ try{localStorage.setItem('vsrg_s1',JSON.stringify(S));}catch(e){} },200); }

/* ============ JUDGE WINDOWS (fixed) ============ */
const W_P=34, W_GR=67, W_GO=97, W_ME=122;
const JC=['#00e5ff','#5dff8f','#ffd54a','#ff9a3d','#ff4d6d']; // P Gr Go Meh Miss
const JN=['PERFECT','GREAT','GOOD','MEH','MISS'];

/* ============ STATE ============ */
let SONGS=[], song=null, diffIdx=S.lastDiff|0;
let chartCache={}, audioCache={}; // file->chart, songId->AudioBuffer
let chart=null, lanes=[[],[],[],[]], ptr=[0,0,0,0];
let totalJud=0, judged=0, counts={p:0,gr:0,go:0,me:0,mi:0}, combo=0, maxCombo=0;
let state='select', rate=1, approach=750, lastT=0;
let songMs=-99999, startCtx=0, leadSec=2;
let hold=[null,null,null,null], laneCnt=[0,0,0,0], laneLit=[0,0,0,0];
let judgePop={t:-1,txt:'',col:'#fff',early:''};
let paused=false, finished=false;
let lastHUD={s:'',a:'',p:-1};
let tpIdx=0;

/* ============ AUDIO ============ */
let AC=null, bgmGain=null, clickBuf=null;
async function ensureCtx(){
  if(!AC){
    const C=window.AudioContext||window.webkitAudioContext; if(!C){toast('WebAudio非対応のブラウザです');return false;}
    AC=new C(); bgmGain=AC.createGain(); bgmGain.connect(AC.destination); bgmGain.gain.value=S.bgm/100;
    // synthesize tap click (60ms decaying blip+noise) — zero assets
    const sr=AC.sampleRate, n=Math.floor(sr*0.06);
    clickBuf=AC.createBuffer(1,n,sr); const d=clickBuf.getChannelData(0);
    for(let i=0;i<n;i++){ const t=i/sr, k=Math.exp(-t*90);
      d[i]=(Math.sin(2*Math.PI*(1900-900*t*20)*t)*0.7+(Math.random()*2-1)*0.25)*k*0.9; }
  }
  if(AC.state==='suspended'){ try{await AC.resume();}catch(e){} }
  return true;
}
function playTap(){
  if(!S.tap||!AC||AC.state!=='running')return;
  try{
    const src=AC.createBufferSource(); src.buffer=clickBuf;
    const g=AC.createGain(); g.gain.value=(S.tapVol/100)*0.8;
    src.connect(g); g.connect(AC.destination); src.start();
  }catch(e){}
}
let srcNode=null, audioBuf=null;
async function loadAudio(url){
  if(audioCache[song.id]){ audioBuf=audioCache[song.id]; return true; }
  const r=await fetch(url); if(!r.ok)throw new Error('audio '+r.status);
  const ab=await r.arrayBuffer();
  audioBuf=await AC.decodeAudioData(ab);
  audioCache[song.id]=audioBuf; return true;
}
function startAudio(){
  stopAudio();
  srcNode=AC.createBufferSource(); srcNode.buffer=audioBuf;
  srcNode.playbackRate.value=rate; srcNode.connect(bgmGain);
  startCtx=AC.currentTime+leadSec; srcNode.start(startCtx);
}
function stopAudio(){ if(srcNode){ try{srcNode.onended=null;srcNode.stop();}catch(e){} try{srcNode.disconnect();}catch(e){} srcNode=null; } }
function rawSongMs(){ if(!AC||!srcNode)return -leadSec*1000; return (AC.currentTime-startCtx)*rate*1000+S.offset; }

/* ============ OSU PARSER (mania) ============ */
function parseOsu(text){
  let keys=4, audio='', title='', artist='', ver='', od=8;
  const tps=[]; const notes=[];
  let sec='';
  const lines=text.split(/\r?\n/);
  for(let ln=0; ln<lines.length; ln++){
    const L=lines[ln].trim(); if(!L||L.startsWith('//'))continue;
    if(L.startsWith('[')&&L.endsWith(']')){ sec=L; continue; }
    if(sec==='[General]'){ if(L.startsWith('AudioFilename:'))audio=L.slice(14).trim(); }
    else if(sec==='[Metadata]'){
      if(L.startsWith('TitleUnicode:')){ const v=L.slice(13).trim(); if(v)title=v; }
      else if(L.startsWith('Title:')){ const v=L.slice(6).trim(); if(v&&!title)title=v; }
      else if(L.startsWith('ArtistUnicode:')){ const v=L.slice(14).trim(); if(v)artist=v; }
      else if(L.startsWith('Artist:')){ const v=L.slice(7).trim(); if(v&&!artist)artist=v; }
      else if(L.startsWith('Version:'))ver=L.slice(8).trim();
    }
    else if(sec==='[Difficulty]'){
      if(L.startsWith('CircleSize:'))keys=parseInt(L.slice(11))||4;
      else if(L.startsWith('OverallDifficulty:'))od=parseFloat(L.slice(18))||8;
    }
    else if(sec==='[TimingPoints]'){
      const p=L.split(','); if(p.length>=2){ const t=+p[0], b=+p[1];
        tps.push({t, b, un:+p[6]!==0}); }
    }
    else if(sec==='[HitObjects]'){
      const p=L.split(','); if(p.length<5)continue;
      const x=+p[0], t=+p[2], type=+p[3]|0;
      let lane=Math.floor(x*keys/512); lane=clamp(lane,0,keys-1);
      if(type&128){ const e=parseInt((p[5]||'0').split(':')[0])||t;
        notes.push({lane,t,e:Math.max(e,t+1),ln:true,hs:0,ts:0}); }
      else notes.push({lane,t,e:0,ln:false,hs:0,ts:1});
    }
  }
  keys=clamp(keys,1,10);
  notes.sort((a,b)=>a.t-b.t||a.lane-b.lane);
  tps.sort((a,b)=>a.t-b.t);
  return {keys,audio,title,artist,ver,od,tps,notes};
}

/* ============ CANVAS / LAYOUT ============ */
const cv=$('cv'), ctx=cv.getContext('2d',{alpha:true});
let W=0,H=0,DPR=1, fieldX=0,fieldW=0,laneWpx=0,judgeY=0,topY=70,noteR=20;
let sprites=[], lnSprites=[];
const LANE_COL=['#ffffff','#ffffff','#ffffff','#ffffff']; // mono white
const LN_COL='#a9aebf'; // long-note gray
function resize(){
  DPR=Math.min(window.devicePixelRatio||1,2);
  const r=cv.getBoundingClientRect(); W=Math.max(50,r.width||innerWidth); H=Math.max(50,r.height||innerHeight);
  cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR);
  const base=Math.min(W*0.94, 480);
  fieldW=Math.min(base*(S.laneW/100), W*0.98);
  fieldX=(W-fieldW)/2; laneWpx=fieldW/4;
  judgeY=H*(S.judgePos/100); topY=64;
  noteR=clamp(laneWpx*0.5*(S.noteSize/100),10,laneWpx*0.65); // 100% = diameter fits lane
  buildSprites();
}
function circleSprite(color,ring,mid,edge,stroke){
  const pad=noteR*0.5, d=Math.ceil((noteR*2+pad*2)*2);
  const c=document.createElement('canvas'); c.width=c.height=d;
  const g=c.getContext('2d'), cx=d/2, cy=d/2, R=d/2-pad;
  const glow=g.createRadialGradient(cx,cy,R*0.2,cx,cy,R+pad);
  glow.addColorStop(0,color); glow.addColorStop(0.55,color+'55'); glow.addColorStop(1,'rgba(0,0,0,0)');
  g.fillStyle=glow; g.beginPath(); g.arc(cx,cy,R+pad,0,7); g.fill();
  if(ring){ g.lineWidth=R*0.28; g.strokeStyle=color; g.beginPath(); g.arc(cx,cy,R*0.78,0,7); g.stroke();
    g.fillStyle='rgba(255,255,255,.85)'; g.beginPath(); g.arc(cx,cy,R*0.22,0,7); g.fill();
  }else{
    const core=g.createRadialGradient(cx-R*0.3,cy-R*0.35,R*0.1,cx,cy,R);
    core.addColorStop(0,'#ffffff'); core.addColorStop(0.72,mid||color); core.addColorStop(1,edge||color);
    g.fillStyle=core; g.beginPath(); g.arc(cx,cy,R,0,7); g.fill();
    g.lineWidth=Math.max(2,R*0.1); g.strokeStyle=stroke||'rgba(255,255,255,.9)';
    g.beginPath(); g.arc(cx,cy,R,0,7); g.stroke();
  }
  return {c, R};
}
function buildSprites(){ sprites=[]; lnSprites=[];
  for(let i=0;i<4;i++){ sprites.push(circleSprite('#ffffff',false,'#ffffff','#eef1fa','rgba(255,255,255,.95)')); lnSprites.push(circleSprite(LN_COL,false,'#c3c8d6','#6f7488','rgba(225,228,240,.9)')); } }
window.addEventListener('resize',resize);

/* ============ GAME FLOW ============ */
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.add('hidden'),2200); }
function show(id){ for(const s of ['screenSelect','screenGame','screenResult'])$(s).classList.toggle('active',s===id); }

async function ensureChart(d){
  const f=song.diffs[d].file;
  if(chartCache[f])return chartCache[f];
  const r=await fetch(f); if(!r.ok)throw new Error('譜面読込失敗 '+r.status);
  const ch=parseOsu(await r.text());
  if(ch.keys!==4){ // 4K以外は4Kへ丸め
    for(const n of ch.notes)n.lane=clamp(Math.floor(n.lane*4/ch.keys),0,3);
    ch.keys=4;
  }
  chartCache[f]=ch; return ch;
}
function buildLanes(){
  lanes=[[],[],[],[]]; ptr=[0,0,0,0]; hold=[null,null,null,null];
  for(const n of chart.notes){ n.hs=0; n.ts=n.ln?0:1; lanes[n.lane].push(n); }
  let ln=0; for(const n of chart.notes)if(n.ln)ln++;
  totalJud=chart.notes.length+ln;
  judged=0; counts={p:0,gr:0,go:0,me:0,mi:0}; combo=0; maxCombo=0;
  lastT=chart.notes.length?chart.notes[chart.notes.length-1].t:0;
  const e=chart.notes.reduce((m,n)=>Math.max(m,n.ln?n.e:n.t),0); lastT=Math.max(lastT,e);
  tpIdx=0; judgePop.t=-1;
}
const scoreNow=()=> totalJud?Math.floor(1000000*(counts.p*300+counts.gr*200+counts.go*100+counts.me*50)/(300*totalJud)):0;
const accNow=()=>{ const w=counts.p*300+counts.gr*200+counts.go*100+counts.me*50;
  return judged?w/(300*judged)*100:100; };
function gradeFor(a){ if(a>=100-1e-9)return 'SS'; if(a>95)return 'S'; if(a>90)return 'A'; if(a>80)return 'B'; if(a>70)return 'C'; return 'D'; }

async function startPlay(){
  if(state==='loading'||state==='ready')return;
  if(!await ensureCtx())return;
  state='loading'; $('btnStart').disabled=true; $('loadStatus').textContent='読み込み中…';
  paused=false; finished=false;
  try{
    rate=Math.round(S.rate*10)/10;
    approach=15000/clamp(S.scroll,5,35);
    chart=await ensureChart(diffIdx);
    buildLanes();
    $('loadStatus').textContent='音源デコード中…';
    await loadAudio(song.audio);
    if(bgmGain)bgmGain.gain.value=S.bgm/100;
    show('screenGame'); state='ready'; resize();
    $('gameBg').style.backgroundImage='none';
    $('hudSong').textContent=`${song.title} [${song.diffs[diffIdx].name}] ${rate.toFixed(1)}x`;
    laneCnt=[0,0,0,0]; laneLit=[0,0,0,0];
    lastHUD={s:'',a:'',p:-1}; lastFrame=0;
    leadSec=Math.max(1.6, approach/1000+0.6);
    // countdown表示
    const cd=$('countdown'); cd.classList.remove('hidden'); cd.textContent='READY';
    startAudio();
    state='playing';
    setTimeout(()=>{ if(state==='playing')cd.classList.add('hidden'); }, Math.min(1200,leadSec*1000*0.7));
    requestAnimationFrame(loop);
  }catch(e){ console.error(e); toast('読込エラー: '+e.message); show('screenSelect'); state='select'; }
  finally{ $('btnStart').disabled=false; $('loadStatus').textContent=''; }
}
function finish(){
  if(finished)return; finished=true; state='result';
  stopAudio(); laneCnt=[0,0,0,0];
  const sc=scoreNow(), ac=accNow(), gr=gradeFor(ac);
  // best保存
  const k='vsrg_best_v1'; let best={}; try{best=JSON.parse(localStorage.getItem(k)||'{}');}catch(e){}
  const key=song.id+'|'+song.diffs[diffIdx].name;
  const isNew=!best[key]||sc>best[key].score;
  if(isNew){ best[key]={score:sc,acc:ac,grade:gr,combo:maxCombo,rate}; try{localStorage.setItem(k,JSON.stringify(best));}catch(e){} }
  $('resThumb').src=song.thumb;
  $('resTitle').textContent=song.title;
  $('resDiff').textContent=`${song.diffs[diffIdx].name} Lv.${song.diffs[diffIdx].level} · ${rate.toFixed(1)}x`;
  const g=$('resGrade'); g.textContent=gr; g.className='grade '+gr[0];
  $('resScore').textContent=sc.toLocaleString();
  $('resAcc').textContent=ac.toFixed(2)+'%';
  $('resNew').classList.toggle('hidden',!isNew);
  $('cP').textContent=counts.p; $('cGr').textContent=counts.gr; $('cGo').textContent=counts.go;
  $('cMe').textContent=counts.me; $('cMi').textContent=counts.mi; $('cCb').textContent=maxCombo+' / '+totalJud;
  $('resStats').textContent=`SCROLL ${S.scroll} · OFFSET ${S.offset>0?'+':''}${S.offset}ms · ${totalJud} JUDGES`;
  show('screenResult'); updateBestLine();
}
function quitToSelect(){ stopAudio(); state='select'; paused=false; $('pauseMenu').classList.add('hidden'); show('screenSelect'); updateBestLine(); }

/* ============ INPUT ============ */
function laneFromX(x){ const l=Math.floor((x-fieldX)/laneWpx); return clamp(l,0,3); }
function judgeOf(adt){ return adt<=W_P?0:adt<=W_GR?1:adt<=W_GO?2:adt<=W_ME?3:4; }
function applyHit(j,dt){
  if(j===0)counts.p++; else if(j===1)counts.gr++; else if(j===2)counts.go++;
  else if(j===3)counts.me++; else counts.mi++;
  judged++;
  if(j===4){ combo=0; } else { combo++; if(combo>maxCombo)maxCombo=combo; }
  judgePop={t:performance.now(),txt:JN[j],col:JC[j],early:dt<-8?'FAST':dt>8?'SLOW':''};
}
function press(lane){
  laneCnt[lane]++; laneLit[lane]=1; playTap();
  if(state!=='playing'||paused)return;
  const arr=lanes[lane]; let cand=null;
  for(let i=ptr[lane]; i<arr.length && i<ptr[lane]+6; i++){
    const n=arr[i]; if(n.hs!==0)continue;
    const dt=songMs-n.t;
    if(dt<-W_ME)break; if(dt>W_ME)continue;
    cand=n; break;
  }
  if(!cand)return; // ghost: ペナルティなし
  const dt=songMs-cand.t, j=judgeOf(Math.abs(dt));
  cand.hs=1; applyHit(j,dt);
  if(cand.ln&&j!==4)hold[lane]=cand;
  else if(cand.ln&&j===4){ cand.ts=2; counts.mi++; judged++; combo=0; }
  while(ptr[lane]<arr.length&&arr[ptr[lane]].hs!==0)ptr[lane]++;
}
function release(lane){
  laneCnt[lane]=Math.max(0,laneCnt[lane]-1);
  if(state!=='playing'||paused)return;
  const n=hold[lane]; if(!n)return;
  const dt=songMs-n.e;
  if(dt<-W_ME){ n.ts=2; counts.mi++; judged++; combo=0;
    judgePop={t:performance.now(),txt:'MISS',col:JC[4],early:'EARLY RELEASE'}; }
  else { const j=judgeOf(Math.abs(dt)); n.ts=1; applyHit(j,dt); }
  hold[lane]=null;
}
window.addEventListener('keydown',e=>{
  if(e.repeat)return;
  const i=S.keys.indexOf(e.code);
  if(listenKey>=0){ e.preventDefault(); S.keys[listenKey]=e.code; listenKey=-1; save(); renderKeys(); return; }
  if(i>=0){ e.preventDefault(); press(i); return; }
  if(e.code==='Escape'||e.code==='KeyP'){ if(state==='playing')togglePause(); }
  if(e.code==='Enter'&&state==='select')startPlay();
});
window.addEventListener('keyup',e=>{ const i=S.keys.indexOf(e.code); if(i>=0){e.preventDefault();release(i);} });
const ptrMap=new Map();
cv.addEventListener('pointerdown',e=>{ e.preventDefault(); try{cv.setPointerCapture(e.pointerId);}catch(_){}
  const r=cv.getBoundingClientRect(), l=laneFromX(e.clientX-r.left);
  ptrMap.set(e.pointerId,l); press(l); },{passive:false});
function ptrUp(e){ const l=ptrMap.get(e.pointerId); if(l!==undefined){ptrMap.delete(e.pointerId);release(l);} }
cv.addEventListener('pointerup',ptrUp); cv.addEventListener('pointercancel',ptrUp);
cv.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('visibilitychange',()=>{ if(document.hidden&&state==='playing'&&!paused)togglePause(); });
document.addEventListener('gesturestart',e=>e.preventDefault());

function togglePause(force){
  if(state!=='playing')return;
  const to=force!==undefined?force:!paused;
  if(to===paused)return; paused=to;
  $('pauseMenu').classList.toggle('hidden',!paused);
  if(paused){ AC.suspend(); }
  else { // 中断中の入力クリア
    laneCnt=[0,0,0,0]; ptrMap.clear(); AC.resume(); requestAnimationFrame(loop); }
}

/* ============ UPDATE + RENDER LOOP ============ */
let lastFrame=0;
function yFor(t){ return judgeY-((t-songMs)/approach)*(judgeY-topY); }
function loop(now){
  if(state!=='playing')return;
  if(paused)return;
  const dt=Math.min(0.05,(now-lastFrame)/1000||0.016); lastFrame=now;
  songMs=rawSongMs();
  // miss検出
  for(let l=0;l<4;l++){
    const arr=lanes[l];
    while(ptr[l]<arr.length){
      const n=arr[ptr[l]];
      if(n.hs!==0){ptr[l]++;continue;}
      if(songMs-n.t>W_ME){
        n.hs=2; applyHit(4,0);
        if(n.ln){ n.ts=2; counts.mi++; judged++; combo=0; }
        ptr[l]++;
      } else break;
    }
  }
  // LN保持完了
  for(let l=0;l<4;l++){ const n=hold[l];
    if(n&&songMs>=n.e){ n.ts=1; counts.p++; judged++; combo++; if(combo>maxCombo)maxCombo=combo; hold[l]=null; } }
  for(let l=0;l<4;l++)laneLit[l]=Math.max(0,laneLit[l]-dt*5);
  // timing pulse用
  if(chart&&chart.tps.length){ while(tpIdx<chart.tps.length-1&&chart.tps[tpIdx+1].t<=songMs)tpIdx++;
    while(tpIdx>0&&chart.tps[tpIdx].t>songMs)tpIdx--; }
  draw(now);
  // HUD (変化時のみDOM更新)
  const sc=String(scoreNow()), ac=accNow().toFixed(2)+'%';
  const pr=clamp(songMs/Math.max(1,lastT),0,1);
  if(sc!==lastHUD.s){$('hudScore').textContent=Number(sc).toLocaleString();lastHUD.s=sc;}
  if(ac!==lastHUD.a){$('hudAcc').textContent=ac;lastHUD.a=ac;}
  const pi=Math.round(pr*500); if(pi!==lastHUD.p){$('hudProg').style.width=(pr*100)+'%';lastHUD.p=pi;}
  // 終了
  if((judged>=totalJud&&songMs>lastT+600)||songMs>lastT+2500){ finish(); return; }
  requestAnimationFrame(loop);
}

function draw(now){
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,W,H);
  const span=judgeY-topY;
  // field bg
  ctx.fillStyle='#000000';
  ctx.fillRect(fieldX,0,fieldW,H);
  for(let l=0;l<4;l++){
    const x=fieldX+l*laneWpx;
    const lit=laneLit[l];
    if(laneCnt[l]>0||lit>0.02){
      const a=laneCnt[l]>0?0.22:lit*0.18;
      const gr=ctx.createLinearGradient(0,judgeY-260,0,judgeY);
      gr.addColorStop(0,'rgba(0,0,0,0)'); gr.addColorStop(1,hexA(LANE_COL[l],a));
      ctx.fillStyle=gr; ctx.fillRect(x,0,laneWpx,judgeY);
    }
    if(l>0){ ctx.fillStyle='rgba(255,255,255,.09)'; ctx.fillRect(x,0,1,H); }
  }
  ctx.fillStyle='rgba(255,255,255,.14)'; ctx.fillRect(fieldX,0,1.5,H); ctx.fillRect(fieldX+fieldW-1.5,0,1.5,H);
  // ---- LN bodies + notes ----
  const bodyW=noteR*2; // LN body = same thickness as note
  for(let l=0;l<4;l++){
    const x=fieldX+l*laneWpx+laneWpx/2, arr=lanes[l];
    // hold中
    const h=hold[l];
    if(h){
      const ty=yFor(h.e), bot=judgeY+noteR*0.4, r=bodyW/2;
      ctx.fillStyle=hexA(LN_COL,0.55);
      ctx.beginPath();
      ctx.moveTo(x-r,bot); ctx.lineTo(x-r,ty); ctx.arc(x,ty,r,Math.PI,0); ctx.lineTo(x+r,bot);
      ctx.closePath(); ctx.fill();
      // 保持エフェクト
      ctx.fillStyle=hexA(LN_COL,0.4);
      ctx.beginPath(); ctx.arc(x,judgeY,noteR*1.25,0,7); ctx.fill();
    }
    for(let i=ptr[l];i<arr.length;i++){
      const n=arr[i];
      if(n.hs!==0&&!(n.ln&&n===h)) { if(n.t-songMs<-300)continue; }
      const dHead=n.t-songMs;
      if(dHead>approach+250)break;
      if(n.hs!==0)continue; // 判定済みheadは描かない(hold除く→上で描画)
      const hy=judgeY-(dHead/approach)*span;
      if(hy>judgeY+120)continue;
      if(hy<-80&&(!n.ln||yFor(n.e)<-80))continue;
      if(n.ln){
        const ty=judgeY-((n.e-songMs)/approach)*span, r=bodyW/2;
        ctx.fillStyle=hexA(LN_COL,0.45);
        const y1=clamp(Math.max(hy,ty),-60,H+60);
        ctx.beginPath();
        if(ty>-80&&ty<H+80){ ctx.moveTo(x-r,y1); ctx.lineTo(x-r,ty); ctx.arc(x,ty,r,Math.PI,0); ctx.lineTo(x+r,y1); ctx.closePath(); }
        else { const y0=clamp(Math.min(hy,ty),-60,H+60); ctx.rect(x-bodyW/2,y0,bodyW,Math.max(4,y1-y0)); }
        ctx.fill();
      }
      const a=dHead>approach*0.92?1-(dHead-approach*0.92)/(approach*0.08+250):1;
      ctx.globalAlpha=clamp(a,0,1);
      drawSprite(n.ln?lnSprites[l]:sprites[l],x,hy);
      ctx.globalAlpha=1;
    }
  }
  // judge rings (circle frames, beat pulse)
  let pulse=0;
  if(chart&&chart.tps.length){ const tp=chart.tps[tpIdx];
    if(tp&&tp.b>0&&songMs>=tp.t){ const ph=((songMs-tp.t)/tp.b)%1; pulse=Math.max(0,1-ph*2.5); } }
  for(let l=0;l<4;l++){ const x=fieldX+l*laneWpx+laneWpx/2, down=laneCnt[l]>0||hold[l];
    const lw=Math.max(2.5,noteR*0.09), rr=Math.max(4,noteR-lw/2);
    if(down){ ctx.fillStyle='rgba(255,255,255,.30)';
      ctx.beginPath(); ctx.arc(x,judgeY,rr,0,7); ctx.fill(); }
    ctx.lineWidth=lw;
    ctx.strokeStyle=down?'rgba(255,255,255,1)':`rgba(255,255,255,${0.55+pulse*0.3})`;
    ctx.beginPath(); ctx.arc(x,judgeY,rr,0,7); ctx.stroke(); }
  // judgement + combo
  const ja=now-judgePop.t;
  if(judgePop.t>0&&ja<700){
    const k=1-Math.min(1,ja/700), pop=ja<90?1+(90-ja)/90*0.35:1;
    ctx.save(); ctx.translate(fieldX+fieldW/2,judgeY-span*0.34); ctx.scale(pop,pop); ctx.globalAlpha=Math.min(1,k*2+0.15);
    ctx.font='900 26px system-ui,sans-serif'; ctx.textAlign='center';
    ctx.fillStyle=judgePop.col; ctx.shadowColor=judgePop.col; ctx.shadowBlur=18;
    ctx.fillText(judgePop.txt,0,0); ctx.shadowBlur=0;
    if(judgePop.early){ ctx.font='700 11px system-ui,sans-serif'; ctx.fillStyle='rgba(255,255,255,.75)'; ctx.fillText(judgePop.early,0,18); }
    ctx.restore();
  }
  if(combo>1){
    ctx.font='900 30px system-ui,sans-serif'; ctx.textAlign='center';
    ctx.fillStyle='rgba(255,255,255,.95)'; ctx.fillText(combo,fieldX+fieldW/2,judgeY-span*0.34+52);
    ctx.font='700 10px system-ui,sans-serif'; ctx.fillStyle='rgba(154,163,199,.9)'; ctx.fillText('COMBO',fieldX+fieldW/2,judgeY-span*0.34+66);
  }
  // key hints
  ctx.font='700 13px system-ui,sans-serif'; ctx.textAlign='center';
  for(let l=0;l<4;l++){ ctx.fillStyle='rgba(154,163,199,.8)';
    ctx.fillText(shortKey(S.keys[l]),fieldX+l*laneWpx+laneWpx/2,H-14); }
}
function drawSprite(sp,x,y){
  const w=sp.c.width, h=sp.c.height, sc=noteR/sp.R; // コア半径が正確にnoteRになる
  ctx.drawImage(sp.c,x-w*sc/2,y-h*sc/2,w*sc,h*sc);
}
function hexA(hex,a){ const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`; }
function shortKey(c){ return c.startsWith('Key')?c.slice(3):c.startsWith('Digit')?c.slice(5):c.replace('Arrow',''); }

/* ============ SELECT UI ============ */
let songIdx=0;
function renderSongs(){
  const row=$('songRow');
  if(SONGS.length<=1){ row.classList.add('hidden'); return; }
  row.classList.remove('hidden'); row.innerHTML='';
  SONGS.forEach((s,i)=>{
    const b=document.createElement('button');
    b.className='song-btn'+(i===songIdx?' on':''); b.textContent='♪ '+s.title;
    b.onclick=()=>{ songIdx=i; song=SONGS[i]; diffIdx=clamp(diffIdx,0,song.diffs.length-1);
      $('bgBlur').style.backgroundImage=`url("${song.thumb}")`;
      renderSongs(); renderDiffs(); refreshSongInfo(); };
    row.appendChild(b);
  });
}
function renderDiffs(){
  const row=$('diffRow'); row.innerHTML='';
  song.diffs.forEach((d,i)=>{
    const b=document.createElement('button');
    b.className='diff-btn'+(i===diffIdx?' on':''); b.dataset.d=i;
    b.innerHTML=`<span class="dn">${d.name}</span><span class="lv">Lv.${d.level}</span>`;
    b.onclick=()=>{ diffIdx=i; S.lastDiff=i; save(); renderDiffs(); refreshSongInfo(); };
    row.appendChild(b);
  });
}
async function refreshSongInfo(){
  $('songTitle').textContent=song.title; $('songArtist').textContent=song.artist;
  $('songThumb').src=song.thumb; $('songInfo').textContent='譜面解析中…';
  try{
    const ch=await ensureChart(diffIdx);
    const ln=ch.notes.filter(n=>n.ln).length;
    const last=ch.notes.reduce((m,n)=>Math.max(m,n.ln?n.e:n.t),0);
    $('songInfo').textContent=`${ch.notes.length} notes (+${ln} LN) · ${fmtT(last/rate)} @${rate.toFixed(1)}x`;
  }catch(e){ $('songInfo').textContent='譜面エラー'; }
  updateBestLine();
}
function updateBestLine(){
  let best={}; try{best=JSON.parse(localStorage.getItem('vsrg_best_v1')||'{}');}catch(e){}
  const b=best[song.id+'|'+song.diffs[diffIdx].name];
  $('bestInfo').textContent=b?`BEST ${b.score.toLocaleString()} · ${b.acc.toFixed(2)}% [${b.grade}] (${b.rate.toFixed(1)}x)`:'— NO RECORD —';
}

/* ============ SETTINGS UI ============ */
let listenKey=-1;
function syncSettingsUI(){
  $('qScroll').value=S.scroll; $('qScrollVal').textContent=S.scroll;
  $('qOffset').value=S.offset; $('qOffsetVal').textContent=S.offset+'ms';
  $('rateSlider').value=S.rate; $('rateVal').textContent=S.rate.toFixed(1)+'x'; rate=S.rate;
  $('pScroll').value=S.scroll; $('pScrollVal').textContent=S.scroll;
  $('pOffset').value=S.offset; $('pOffsetVal').textContent=S.offset+'ms';
  $('sScroll').value=S.scroll; $('sScrollVal').textContent=S.scroll;
  $('sOffset').value=S.offset; $('sOffsetVal').textContent=S.offset+'ms';
  $('sRate').value=S.rate; $('sRateVal').textContent=S.rate.toFixed(1)+'x';
  $('sLane').value=S.laneW; $('sLaneVal').textContent=S.laneW+'%';
  $('sNote').value=S.noteSize; $('sNoteVal').textContent=S.noteSize+'%';
  $('sJudge').value=S.judgePos; $('sJudgeVal').textContent=S.judgePos+'%';
  $('sTap').checked=S.tap; $('sTapVal').textContent=S.tapVol;
  $('sTapVol').value=S.tapVol; $('sBgm').value=S.bgm; $('sBgmVal').textContent=S.bgm;
  $('keysHint').textContent=S.keys.map(shortKey).join(' ');
  renderKeys();
}
function renderKeys(){
  const r=$('keyRow'); r.innerHTML='';
  S.keys.forEach((k,i)=>{ const d=document.createElement('div');
    d.className='key-cap'+(listenKey===i?' listening':''); d.textContent=listenKey===i?'押して…':shortKey(k);
    d.onclick=()=>{ listenKey=i; renderKeys(); }; r.appendChild(d); });
  $('keysHint').textContent=S.keys.map(shortKey).join(' ');
}
function setRate(v){ S.rate=clamp(Math.round(v*10)/10,0.5,3); rate=S.rate; save(); syncSettingsUI(); refreshSongInfo(); }

/* ============ INIT ============ */
async function init(){
  try{
    const r=await fetch('songs/songs.json'); const j=await r.json();
    SONGS=j.songs||[];
  }catch(e){ SONGS=[]; }
  if(!SONGS.length){ // フォールバック（songs.jsonが無い場合も失恋後で遊べる）
    SONGS=[{id:'shitsurengo',title:'失恋後',artist:'Rikudo-ren',audio:'songs/失恋後/失恋後.mp3',
      thumb:'songs/失恋後/サムネイル.png',
      diffs:[{name:'Easy',level:5,file:'songs/失恋後/easy.osu'},{name:'Normal',level:9,file:'songs/失恋後/normal.osu'},{name:'Hard',level:11,file:'songs/失恋後/hard.osu'}]}];
  }
  song=SONGS[0]; diffIdx=clamp(S.lastDiff|0,0,song.diffs.length-1); rate=S.rate;
  renderSongs(); renderDiffs(); syncSettingsUI(); refreshSongInfo(); resize();
  setTimeout(resize,300);
  // select bindings
  $('btnStart').onclick=startPlay;
  $('rateSlider').oninput=e=>setRate(parseFloat(e.target.value));
  $('rateMinus').onclick=()=>setRate(S.rate-0.1);
  $('ratePlus').onclick=()=>setRate(S.rate+0.1);
  $('qScroll').oninput=e=>{S.scroll=+e.target.value;save();syncSettingsUI();};
  $('qOffset').oninput=e=>{S.offset=+e.target.value;save();syncSettingsUI();};
  // pause
  $('btnPause').onclick=()=>togglePause();
  $('btnResume').onclick=()=>togglePause(false);
  $('btnRestart').onclick=()=>{ paused=false; $('pauseMenu').classList.add('hidden');
    if(AC&&AC.state==='suspended')AC.resume(); stopAudio(); state='select'; startPlay(); };
  $('btnQuit').onclick=quitToSelect;
  $('pScroll').oninput=e=>{S.scroll=+e.target.value;approach=15000/S.scroll;save();syncSettingsUI();};
  $('pOffset').oninput=e=>{S.offset=+e.target.value;save();syncSettingsUI();};
  // result
  $('btnRetry').onclick=()=>{ state='select'; startPlay(); };
  $('btnBack').onclick=quitToSelect;
  // settings modal
  const M=$('settingsModal');
  $('btnSettingsTop').onclick=()=>{M.classList.remove('hidden');};
  $('btnCloseSettings').onclick=()=>M.classList.add('hidden');
  M.addEventListener('click',e=>{ if(e.target===M)M.classList.add('hidden'); });
  $('sScroll').oninput=e=>{S.scroll=+e.target.value;approach=15000/S.scroll;save();syncSettingsUI();};
  $('sOffset').oninput=e=>{S.offset=+e.target.value;save();syncSettingsUI();};
  $('sRate').oninput=e=>setRate(parseFloat(e.target.value));
  $('sLane').oninput=e=>{S.laneW=+e.target.value;save();syncSettingsUI();resize();};
  $('sNote').oninput=e=>{S.noteSize=+e.target.value;save();syncSettingsUI();resize();};
  $('sJudge').oninput=e=>{S.judgePos=+e.target.value;save();syncSettingsUI();resize();};
  $('sTap').onchange=e=>{S.tap=e.target.checked;save();syncSettingsUI();};
  $('sTapVol').oninput=e=>{S.tapVol=+e.target.value;save();syncSettingsUI();playTap();};
  $('sBgm').oninput=e=>{S.bgm=+e.target.value;if(bgmGain)bgmGain.gain.value=S.bgm/100;save();syncSettingsUI();};
  $('btnResetSettings').onclick=()=>{ S={...DEF,lastDiff:diffIdx}; save(); rate=S.rate; approach=15000/S.scroll; syncSettingsUI(); resize(); refreshSongInfo(); toast('設定をリセットしました'); };
  // 音源プリフェッチ（初回タップで裏読み→開始高速化）
  const pre=()=>{ ensureCtx().then(ok=>{ if(ok&&!audioCache[song.id])loadAudio(song.audio).catch(()=>{}); }); window.removeEventListener('pointerdown',pre); };
  window.addEventListener('pointerdown',pre);
}
init();
