/* VSRG lite — ultra lightweight 4K VSRG engine (vanilla, no deps) — low latency */
'use strict';
const $ = id => document.getElementById(id);
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const fmtT = ms => { ms=Math.max(0,Math.round(ms)); const s=Math.floor(ms/1000); return Math.floor(s/60)+':'+String(s%60).padStart(2,'0'); };

/* ============ SETTINGS ============ */
const DEF = { scroll:20, offset:0, rate:1.0, tap:true, tapVol:50, bgm:80,
  laneW:100, noteSize:100, judgePos:86, res:'auto', keys:['KeyD','KeyF','KeyJ','KeyK'], lastDiff:1 };
let S = {...DEF};
try{ const j=JSON.parse(localStorage.getItem('vsrg_s1')||'{}'); S={...DEF,...j}; if(!Array.isArray(S.keys)||S.keys.length!==4)S.keys=[...DEF.keys]; }catch(e){}
if(S.res!=='auto'&&S.res!=='high'&&S.res!=='low')S.res='auto';
let saveT=null;
function save(){ clearTimeout(saveT); saveT=setTimeout(()=>{ try{localStorage.setItem('vsrg_s1',JSON.stringify(S));}catch(e){} },200); }

/* ============ JUDGE WINDOWS (fixed) ============
 * 窓幅は従来どおり。表示名だけ押し上げ:
 *   ±34 Perfect+ / ±67 Perfect / ±97 Great / ±122 Good / Miss
 * Perfect(旧Great窓)も ACC・SCORE は 300 扱い → 精度が以前より出しやすい */
const W_P=34, W_GR=67, W_GO=97, W_GD=122;
const JC=['#ffffff','#00e5ff','#5dff8f','#ffd54a','#ff4d6d'];
const JN=['PERFECT+','PERFECT','GREAT','GOOD','MISS'];

/* ============ STATE ============ */
let SONGS=[], song=null, diffIdx=S.lastDiff|0;
let chartCache={}, audioCache={};
let chart=null, lanes=[[],[],[],[]], ptr=[0,0,0,0];
let totalJud=0, judged=0, counts={pp:0,p:0,gr:0,go:0,mi:0}, combo=0, maxCombo=0;
let state='select', rate=1, approach=750, approachC=750, lastT=0;
let songMs=-99999, startCtx=0, leadSec=2;
let hold=[null,null,null,null], laneCnt=[0,0,0,0], laneLit=[0,0,0,0];
let judgePop={t:-1,j:0,early:''};
let paused=false, finished=false;
let lastHUD={s:'',a:'',p:-1,t:0};
let tpIdx=0;
const HE_N=24; let hitErrs=[], errSum=0, errN=0;   // 直近の入力ズレ（判定ライン下のエラーバー用）/ プレイ全体の平均

/* ============ AUDIO — low latency (no asset files) ============ */
let AC=null, bgmGain=null, clickBuf=null;
async function ensureCtx(){
  if(!AC){
    const C=window.AudioContext||window.webkitAudioContext; if(!C){toast('WebAudio非対応のブラウザです');return false;}
    // sampleRate は指定しない: 端末ネイティブと違う値を強制するとリサンプラが挟まり遅延とCPU負荷が増える
    try{ AC=new C({latencyHint:'interactive'}); }catch(e1){ AC=new C(); }
    bgmGain=AC.createGain(); bgmGain.connect(AC.destination); bgmGain.gain.value=S.bgm/100;
    // synthesize tap click (60ms decaying blip+noise) — zero assets, lowest latency
    const sr=AC.sampleRate, n=Math.floor(sr*0.06);
    clickBuf=AC.createBuffer(1,n,sr); const d=clickBuf.getChannelData(0);
    for(let i=0;i<n;i++){ const t=i/sr, k=Math.exp(-t*90);
      d[i]=(Math.sin(2*Math.PI*(1900-900*t*20)*t)*0.7+(Math.random()*2-1)*0.25)*k*0.9; }
  }
  if(AC.state==='suspended'){ try{await AC.resume();}catch(e){} }
  if(AC.state!=='running'){ try{ AC.resume(); }catch(e){} }
  return true;
}
function playTap(){
  if(!S.tap||!AC||!clickBuf) return;
  if(AC.state==='suspended'){ try{AC.resume();}catch(e){} }
  if(AC.state!=='running'&&AC.state!=='suspended') return;
  try{
    const src=AC.createBufferSource(); src.buffer=clickBuf;
    const g=AC.createGain(); g.gain.value=(S.tapVol/100)*0.9;
    src.connect(g); g.connect(AC.destination);
    src.start(AC.currentTime); // immediate, minimal latency
  }catch(e){}
}
let srcNode=null, audioBuf=null;
let audioLoading={};
async function loadAudio(url){
  if(audioCache[song.id]){ audioBuf=audioCache[song.id]; return true; }
  if(audioLoading[song.id]){ await audioLoading[song.id]; audioBuf=audioCache[song.id]; return true; }
  const p=(async()=>{
    const r=await fetch(url); if(!r.ok)throw new Error('audio '+r.status);
    const ab=await r.arrayBuffer();
    audioCache[song.id]=await AC.decodeAudioData(ab);
  })();
  audioLoading[song.id]=p;
  try{ await p; } finally{ delete audioLoading[song.id]; }
  audioBuf=audioCache[song.id]; return true;
}
let prevNode=null;
async function startPreview(){
  if(state!=='select')return;
  if(!await ensureCtx())return;
  try{
    await loadAudio(song.audio);
    if(state!=='select')return;
    stopPreview();
    prevNode=AC.createBufferSource();
    prevNode.buffer=audioCache[song.id]; prevNode.loop=true; prevNode.playbackRate.value=1;
    prevNode.connect(bgmGain); prevNode.start();
  }catch(e){}
}
function stopPreview(){ if(prevNode){ try{prevNode.stop();}catch(e){} try{prevNode.disconnect();}catch(e){} prevNode=null; } }
function startAudio(){
  stopAudio();
  srcNode=AC.createBufferSource(); srcNode.buffer=audioBuf;
  srcNode.playbackRate.value=rate; srcNode.connect(bgmGain);
  startCtx=AC.currentTime+leadSec; srcNode.start(startCtx);
  resetClock();
}
function stopAudio(){ if(srcNode){ try{srcNode.onended=null;srcNode.stop();}catch(e){} try{srcNode.disconnect();}catch(e){} srcNode=null; } }

/* ============ CLOCK — smooth + output-latency compensated ============
 * ゲームの基準時計は「今スピーカーから鳴っている音源位置」。
 * AC.currentTime をそのまま使うと
 *   1) 数ms〜20ms刻みの階段状にしか進まないので、フレームごとの進み量がばらつき描画がカクつく
 *   2) 出力遅延(outputLatency)ぶん "未来" の時刻を指すので、耳で合わせた入力が一律 SLOW になる
 * ので、performance.now() ベースの連続時計に対して
 *   heardCtx(t) = clkOff + t/1000   （clkOff は音声側の情報から滑らかに追従）
 * という写像を作り、描画・入力判定・LN終端すべてで同じ時計を使う。
 * 入力は event.timeStamp（OSが押下を記録した時刻）で評価するため、
 * メインスレッドが描画で塞がっていても判定の正確さは落ちない。 */
let clkOff=null, clkN=0, clkSrc='', latMs=0;
function outLat(){
  if(!AC)return 0; let l=0;
  if(AC.outputLatency>0&&AC.outputLatency<2)l+=AC.outputLatency;
  if(AC.baseLatency>0&&AC.baseLatency<1)l+=AC.baseLatency;
  return l;
}
function resetClock(){ clkOff=null; clkN=0; }
function syncClock(pn){
  if(!AC||AC.state!=='running')return;
  const ct=AC.currentTime; if(!(ct>0))return;
  const offB=ct-outLat()-pn/1000;   // currentTime + 報告された遅延 から推定
  let off=offB, src='currentTime';
  if(typeof AC.getOutputTimestamp==='function'){
    try{
      const ts=AC.getOutputTimestamp();   // 「今鳴っているサンプル」と performance 時刻のペア（対応環境のみ信頼できる）
      if(ts&&ts.contextTime>0&&ts.performanceTime>0){
        const dc=ct-ts.contextTime, dp=pn-ts.performanceTime;
        if(dc>=0&&dc<0.5&&dp>=0&&dp<1000){
          const offA=ts.contextTime-ts.performanceTime/1000;
          if(Math.abs(offA-offB)<0.1){ off=offA; src='outputTimestamp'; }
        }
      }
    }catch(e){}
  }
  if(clkOff===null||Math.abs(off-clkOff)>0.15){ clkOff=off; clkN=0; }   // 開始直後 / 一時停止復帰 / 音声の途切れ
  else clkOff+=(off-clkOff)*(clkN<30?0.2:0.05);                          // ジッタは平滑化して見た目の飛びを防ぐ
  clkN++; clkSrc=src;
  latMs+=((ct-(clkOff+pn/1000))*1000-latMs)*0.1;
}
function heardCtx(pn){ return clkOff===null?(AC?AC.currentTime-outLat():0):clkOff+pn/1000; }
function songMsAt(pn){   // pn: performance.now() 系の時刻 → 譜面時間(ms)
  if(!AC||!srcNode) return (-leadSec*1000+S.offset)*rate;
  return ((heardCtx(pn)-startCtx)*1000+S.offset)*rate;
}
function rawSongMs(){ return songMsAt(performance.now()); }
function evTime(e){
  const pn=performance.now(), t=e?e.timeStamp:undefined;
  return (typeof t==='number'&&t>0&&Math.abs(pn-t)<1000)?t:pn;   // 旧実装のepoch値などは弾く
}

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

/* ============ CANVAS / LAYOUT — low latency ============ */
const cv=$('cv');
let ctx;
// alpha:false — 不透明キャンバスはコンポジタの合成が不要になり、Chrome の低遅延(desynchronized)経路にも乗りやすい
try{ ctx=cv.getContext('2d',{alpha:false, desynchronized:true}); }catch(e){ ctx=cv.getContext('2d',{alpha:false}); }
if(!ctx){ ctx=cv.getContext('2d'); }
let W=0,H=0,DPR=1, fieldX=0,fieldW=0,laneWpx=0,judgeY=0,topY=70,noteR=20;
let sprites=[], laneGrad=null, txt={};
let dprCap=2;   // 自動解像度: 重い端末では下げる（セッション内で保持）
const LANE_COL=['#ffffff','#ffffff','#ffffff','#ffffff'];
const LN_COL='#a9aebf';
const LN_HEAD='#d8dce8';
function resize(){
  const dev=window.devicePixelRatio||1;
  DPR=S.res==='low'?1:S.res==='high'?Math.min(dev,3):Math.min(dev,dprCap);
  const r=cv.getBoundingClientRect(); W=Math.max(50,r.width||innerWidth); H=Math.max(50,r.height||innerHeight);
  cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR);
  const base=Math.min(W*0.94, 480);
  fieldW=Math.min(base*(S.laneW/100), W*0.98);
  fieldX=(W-fieldW)/2; laneWpx=fieldW/4;
  judgeY=H*(S.judgePos/100); topY=0;
  noteR=clamp(laneWpx*0.5*(S.noteSize/100),10,laneWpx*0.65);
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
// 文字は毎フレーム fillText + shadowBlur すると非常に重い（特にモバイル）ので、起動時に一度だけ画像化しておく
function textSprite(text,px,weight,color,glow,pad){
  const ss=Math.min(2,Math.max(1,DPR))*1.4;   // 拡大表示(pop)しても粗くならない程度に高解像度化
  const font=`${weight} ${px}px system-ui,sans-serif`;
  const c=document.createElement('canvas'); let g=c.getContext('2d');
  g.font=font; const tw=g.measureText(text).width;
  const w=Math.ceil(tw+pad*2), h=Math.ceil(px*1.4+pad*2);
  c.width=Math.ceil(w*ss); c.height=Math.ceil(h*ss);
  g=c.getContext('2d'); g.scale(ss,ss); g.font=font; g.textAlign='center'; g.textBaseline='middle';
  g.fillStyle=color;
  if(glow){ g.shadowColor=color; g.shadowBlur=18; g.fillText(text,w/2,h/2); g.shadowBlur=0; }
  g.fillText(text,w/2,h/2);
  return {c,w,h};
}
function buildSprites(){ sprites=[];
  for(let i=0;i<4;i++){ sprites.push(circleSprite('#ffffff',false,'#ffffff','#eef1fa','rgba(255,255,255,.95)')); }
  txt={judge:[],digit:[]};
  for(let j=0;j<5;j++)txt.judge.push(textSprite(JN[j],26,900,JC[j],true,22));
  for(let d=0;d<10;d++)txt.digit.push(textSprite(String(d),30,900,'rgba(255,255,255,.95)',false,1));
  txt.combo=textSprite('COMBO',10,700,'rgba(154,163,199,.9)',false,2);
  txt.fast=textSprite('FAST',11,700,'rgba(120,200,255,.9)',false,2);   // 早い=寒色 / 遅い=暖色 で打ち分けを一目で
  txt.slow=textSprite('SLOW',11,700,'rgba(255,170,120,.9)',false,2);
  txt.rel=textSprite('EARLY RELEASE',11,700,'rgba(255,255,255,.75)',false,2);
  // レーン点灯用グラデーション（毎フレーム生成しない）
  if(ctx&&ctx.createLinearGradient){
    laneGrad=ctx.createLinearGradient(0,judgeY-260,0,judgeY);
    laneGrad.addColorStop(0,'rgba(255,255,255,0)'); laneGrad.addColorStop(1,'rgba(255,255,255,1)');
  }
}
window.addEventListener('resize',resize);

/* ============ GAME FLOW ============ */
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.remove('hidden'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.add('hidden'),2200); }
function show(id){ for(const s of ['screenSelect','screenGame','screenResult'])$(s).classList.toggle('active',s===id);
  document.body.classList.toggle('playing',id==='screenGame'); }

async function ensureChart(d){
  const f=song.diffs[d].file;
  if(chartCache[f])return chartCache[f];
  const r=await fetch(f); if(!r.ok)throw new Error('譜面読込失敗 '+r.status);
  const ch=parseOsu(await r.text());
  if(ch.keys!==4){
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
  judged=0; counts={pp:0,p:0,gr:0,go:0,mi:0}; combo=0; maxCombo=0;
  lastT=chart.notes.length?chart.notes[chart.notes.length-1].t:0;
  const e=chart.notes.reduce((m,n)=>Math.max(m,n.ln?n.e:n.t),0); lastT=Math.max(lastT,e);
  tpIdx=0; judgePop.t=-1; hitErrs=[]; errSum=0; errN=0;
}
// Perfect+ と Perfect はどちらも 300。Great=200 / Good=100（旧 Good/Meh 窓を一段繰り上げ）
const scoreNow=()=> totalJud?Math.floor(1000000*(counts.pp*300+counts.p*300+counts.gr*200+counts.go*100)/(300*totalJud)):0;
const accNow=()=>{ const w=counts.pp*300+counts.p*300+counts.gr*200+counts.go*100;
  return judged?w/(300*judged)*100:100; };
function gradeFor(a){ if(a>=100-1e-9)return 'SS'; if(a>95)return 'S'; if(a>90)return 'A'; if(a>80)return 'B'; if(a>70)return 'C'; return 'D'; }

function applyScroll(){
  approach=15000/clamp(S.scroll,5,35);
  approachC=approach*rate;
}
async function startPlay(){
  if(state==='loading'||state==='ready')return;
  stopPreview();
  $('settingsModal').classList.add('hidden');
  if(!await ensureCtx())return;
  state='loading'; $('btnStart').disabled=true; $('loadStatus').textContent='読み込み中…';
  paused=false; finished=false;
  try{
    rate=Math.round(S.rate*10)/10;
    applyScroll();
    chart=await ensureChart(diffIdx);
    buildLanes();
    $('loadStatus').textContent='音源デコード中…';
    await loadAudio(song.audio);
    if(bgmGain)bgmGain.gain.value=S.bgm/100;
    show('screenGame'); state='ready'; resize();
    $('gameBg').style.backgroundImage='none';
    $('hudSong').textContent=`${song.title} [${song.diffs[diffIdx].name}] ${rate.toFixed(1)}x`;
    laneCnt=[0,0,0,0]; laneLit=[0,0,0,0];
    lastHUD={s:'',a:'',p:-1,t:0}; lastFrame=0; frameN=0; slowN=0; drawAcc=0;
    leadSec=Math.max(1.6, approach/1000+0.6);
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
  $('cPp').textContent=counts.pp; $('cP').textContent=counts.p; $('cGr').textContent=counts.gr;
  $('cGo').textContent=counts.go; $('cMi').textContent=counts.mi; $('cCb').textContent=maxCombo+' / '+totalJud;
  const me=errN?errSum/errN:0;
  $('resStats').textContent=`SCROLL ${S.scroll} · OFFSET ${S.offset>0?'+':''}${S.offset}ms · 音声遅延補正 ${Math.round(latMs)}ms · 平均ズレ ${me>0?'+':''}${me.toFixed(0)}ms${errN?(me<-8?'(FAST→オフセット+)':me>8?'(SLOW→オフセット−)':''):''} · ${totalJud} JUDGES`;
  show('screenResult'); updateBestLine();
}
function quitToSelect(){ stopAudio(); state='select'; paused=false; $('pauseMenu').classList.add('hidden'); show('screenSelect'); updateBestLine(); startPreview(); }

/* ============ INPUT — ultra low latency (no asset) ============ */
function laneFromX(x){ const l=Math.floor((x-fieldX)/laneWpx); return clamp(l,0,3); }
function judgeOf(adt){ return adt<=W_P?0:adt<=W_GR?1:adt<=W_GO?2:adt<=W_GD?3:4; }
function applyHit(j,dt){
  if(j===0)counts.pp++; else if(j===1)counts.p++; else if(j===2)counts.gr++;
  else if(j===3)counts.go++; else counts.mi++;
  judged++;
  if(j===4){ combo=0; } else { combo++; if(combo>maxCombo)maxCombo=combo; }
  const now=performance.now();
  // ±8ms 超で FAST/SLOW を併記 → Perfect(±34〜67ms) 帯は必ず打ち分けが出る。Perfect+ はほぼ中央のみ無印
  judgePop={t:now,j,early:dt<-8?'FAST':dt>8?'SLOW':''};
  if(j!==4){ hitErrs.push({dt,at:now}); if(hitErrs.length>HE_N)hitErrs.shift(); errSum+=dt; errN++; }
}
let lastDrawAt=0;
function immediateDraw(){
  // 低遅延キャンバス(desynchronized)対応環境では rAF を待たずに反映される。
  // 同時押しで描画が積み重ならないよう数ms以内の連続呼び出しは間引く。
  if(state!=='playing'||paused) return;
  const pn=performance.now(); if(pn-lastDrawAt<3) return;
  try{ songMs=songMsAt(pn); draw(pn); }catch(e){}
}
function press(lane,t){
  if(t===undefined)t=performance.now();
  laneCnt[lane]++; laneLit[lane]=1;
  if(AC&&AC.state==='suspended'){ try{AC.resume();}catch(e){} }
  playTap();
  if(state!=='playing'||paused) return;
  const inputMs=songMsAt(t);   // イベント発生時刻で判定（ハンドラ実行の遅れを含めない）
  const arr=lanes[lane]; let cand=null;
  for(let i=ptr[lane]; i<arr.length && i<ptr[lane]+6; i++){
    const n=arr[i]; if(n.hs!==0)continue;
    const dt=inputMs-n.t;
    if(dt<-W_GD)break; if(dt>W_GD)continue;
    cand=n; break;
  }
  if(!cand){ immediateDraw(); return; }
  const dt=inputMs-cand.t, j=judgeOf(Math.abs(dt));
  cand.hs=1; applyHit(j,dt);
  if(cand.ln&&j!==4)hold[lane]=cand;
  else if(cand.ln&&j===4){ cand.ts=2; counts.mi++; judged++; combo=0; }
  while(ptr[lane]<arr.length&&arr[ptr[lane]].hs!==0)ptr[lane]++;
  immediateDraw();
}
function release(lane,t){
  if(t===undefined)t=performance.now();
  laneCnt[lane]=Math.max(0,laneCnt[lane]-1);
  if(state!=='playing'||paused){ if(state==='playing') immediateDraw(); return; }
  const n=hold[lane]; if(!n){ immediateDraw(); return; }
  const dt=songMsAt(t)-n.e;
  if(dt<-W_GD){ n.ts=2; counts.mi++; judged++; combo=0;
    judgePop={t:performance.now(),j:4,early:'EARLY RELEASE'}; }
  else { const j=judgeOf(Math.abs(dt)); n.ts=1; applyHit(j,dt); }
  hold[lane]=null;
  immediateDraw();
}
window.addEventListener('keydown',e=>{
  if(e.repeat) return;
  const i=S.keys.indexOf(e.code);
  if(listenKey>=0){ e.preventDefault(); S.keys[listenKey]=e.code; listenKey=-1; save(); renderKeys(); return; }
  if(i>=0){ e.preventDefault(); press(i,evTime(e)); return; }
  if(e.code==='Escape'||e.code==='KeyP'){ if(state==='playing'){ e.preventDefault(); togglePause(); } }
  if(e.code==='Enter'&&state==='select'){ e.preventDefault(); startPlay(); }
},{passive:false, capture:true});
window.addEventListener('keyup',e=>{
  const i=S.keys.indexOf(e.code);
  if(i>=0){ e.preventDefault(); release(i,evTime(e)); }
},{passive:false, capture:true});
const ptrMap=new Map();
cv.addEventListener('pointerdown',e=>{
  e.preventDefault();
  try{cv.setPointerCapture(e.pointerId);}catch(_){}
  const r=cv.getBoundingClientRect(), l=laneFromX(e.clientX-r.left);
  ptrMap.set(e.pointerId,l);
  if(AC&&AC.state==='suspended'){ try{AC.resume();}catch(e){} }
  press(l,evTime(e));
},{passive:false});
function ptrUp(e){ const l=ptrMap.get(e.pointerId); if(l!==undefined){ptrMap.delete(e.pointerId);release(l,evTime(e));} }
cv.addEventListener('pointerup',ptrUp,{passive:false});
cv.addEventListener('pointercancel',ptrUp,{passive:false});
cv.addEventListener('contextmenu',e=>e.preventDefault());
cv.addEventListener('touchstart',e=>{
  e.preventDefault();
  if(!AC){ ensureCtx(); }
  if(AC&&AC.state==='suspended'){ try{AC.resume();}catch(_){} }
},{passive:false});
document.addEventListener('visibilitychange',()=>{ if(document.hidden&&state==='playing'&&!paused)togglePause(); });
document.addEventListener('gesturestart',e=>e.preventDefault());

function togglePause(force){
  if(state!=='playing')return;
  const to=force!==undefined?force:!paused;
  if(to===paused)return; paused=to;
  $('pauseMenu').classList.toggle('hidden',!paused);
  if(paused){ AC.suspend(); }
  else {
    laneCnt=[0,0,0,0]; ptrMap.clear(); resetClock(); AC.resume(); requestAnimationFrame(loop); }
}

/* ============ UPDATE + RENDER LOOP ============ */
let lastFrame=0, frameN=0, slowN=0, drawAcc=0;
function yFor(t){ return judgeY-((t-songMs)/approachC)*(judgeY-topY); }
function noteAlpha(dHead){ return clamp((approachC-dHead)/(approachC*0.1),0.35,1); }
function belowAlpha(y){ return y>judgeY?clamp(1-(y-judgeY)/280,0.55,1):1; }
function loop(now){
  if(state!=='playing')return;
  if(paused)return;
  const fd=now-lastFrame;
  const dt=Math.min(0.05,fd/1000||0.016); lastFrame=now;
  syncClock(performance.now());
  songMs=songMsAt(now);   // このフレームの時刻で評価 → 毎フレーム等間隔に進む
  for(let l=0;l<4;l++){
    const arr=lanes[l];
    while(ptr[l]<arr.length){
      const n=arr[ptr[l]];
      if(n.hs!==0){ptr[l]++;continue;}
      if(songMs-n.t>W_GD){
        n.hs=2; applyHit(4,0);
        if(n.ln){ n.ts=2; counts.mi++; judged++; combo=0; }
        ptr[l]++;
      } else break;
    }
  }
  for(let l=0;l<4;l++){ const n=hold[l];
    // LN終端まで保持 → Perfect+（満点）
    if(n&&songMs>=n.e){ n.ts=1; counts.pp++; judged++; combo++; if(combo>maxCombo)maxCombo=combo; hold[l]=null; } }
  for(let l=0;l<4;l++)laneLit[l]=Math.max(0,laneLit[l]-dt*5);
  if(chart&&chart.tps.length){ while(tpIdx<chart.tps.length-1&&chart.tps[tpIdx+1].t<=songMs)tpIdx++;
    while(tpIdx>0&&chart.tps[tpIdx].t>songMs)tpIdx--; }
  const t0=performance.now();
  draw(now);
  drawAcc+=performance.now()-t0;
  // 自動解像度: フレーム落ちが続き、かつ描画自体に時間が掛かっている端末だけ内部解像度を下げる
  if(S.res==='auto'&&fd>0&&fd<1000){
    frameN++; if(fd>24)slowN++;
    if(frameN>=240){
      if(slowN>=36&&drawAcc/frameN>=4&&dprCap>1){ dprCap=Math.max(1,dprCap-0.5); resize(); }
      frameN=0; slowN=0; drawAcc=0;
    }
  }
  if(now-lastHUD.t>50){   // DOM 更新は 20回/秒 まで（レイアウト/ペイントの割り込みを減らす）
    lastHUD.t=now;
    const sc=String(scoreNow()), ac=accNow().toFixed(2)+'%';
    const pr=clamp(songMs/Math.max(1,lastT),0,1);
    if(sc!==lastHUD.s){$('hudScore').textContent=Number(sc).toLocaleString();lastHUD.s=sc;}
    if(ac!==lastHUD.a){$('hudAcc').textContent=ac;lastHUD.a=ac;}
    const pi=Math.round(pr*500); if(pi!==lastHUD.p){$('hudProg').style.transform='scaleX('+pr+')';lastHUD.p=pi;}
  }
  if((judged>=totalJud&&songMs>lastT+600)||songMs>lastT+2500){ finish(); return; }
  requestAnimationFrame(loop);
}

function drawText(sp,cx,cy,scale,alpha){
  if(!sp)return;
  const w=sp.w*scale, h=sp.h*scale;
  if(alpha!==undefined)ctx.globalAlpha=alpha;
  ctx.drawImage(sp.c,cx-w/2,cy-h/2,w,h);
  if(alpha!==undefined)ctx.globalAlpha=1;
}
function drawNumber(n,cx,cy,scale){
  const s=String(n), ds=txt.digit; if(!ds||!ds.length)return;
  let tw=0; for(let i=0;i<s.length;i++)tw+=ds[s.charCodeAt(i)-48].w*scale;
  let x=cx-tw/2;
  for(let i=0;i<s.length;i++){ const sp=ds[s.charCodeAt(i)-48]; const w=sp.w*scale, h=sp.h*scale;
    ctx.drawImage(sp.c,x,cy-h/2,w,h); x+=w; }
}
function draw(now){
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.fillStyle='#000000';
  ctx.fillRect(0,0,W,H);
  const span=judgeY-topY;
  for(let l=0;l<4;l++){
    const x=fieldX+l*laneWpx;
    const lit=laneLit[l];
    if(laneGrad&&(laneCnt[l]>0||lit>0.02)){
      ctx.globalAlpha=laneCnt[l]>0?0.22:lit*0.18;
      ctx.fillStyle=laneGrad; ctx.fillRect(x,judgeY-260,laneWpx,260);
      ctx.globalAlpha=1;
    }
    if(l>0){ ctx.fillStyle='rgba(255,255,255,.09)'; ctx.fillRect(x,0,1,H); }
  }
  ctx.fillStyle='rgba(255,255,255,.14)'; ctx.fillRect(fieldX,0,1.5,H); ctx.fillRect(fieldX+fieldW-1.5,0,1.5,H);
  const bodyW=noteR*2;
  for(let l=0;l<4;l++){
    const x=fieldX+l*laneWpx+laneWpx/2, arr=lanes[l];
    const h=hold[l];
    if(h){
      const ty=yFor(h.e), bot=judgeY+noteR*0.4, r=bodyW/2;
      ctx.fillStyle=hexA(LN_COL,0.55);
      ctx.beginPath();
      ctx.moveTo(x-r,bot); ctx.lineTo(x-r,ty); ctx.arc(x,ty,r,Math.PI,0); ctx.lineTo(x+r,bot);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle=hexA(LN_COL,0.4);
      ctx.beginPath(); ctx.arc(x,judgeY,noteR*1.25,0,7); ctx.fill();
    }
    for(let i=ptr[l];i<arr.length;i++){
      const n=arr[i];
      if(n.hs!==0&&!(n.ln&&n===h)) { if(n.t-songMs<-300)continue; }
      const dHead=n.t-songMs;
      if(dHead>approachC+250)break;
      if(n.hs!==0)continue;
      const hy=judgeY-(dHead/approachC)*span;
      if(hy>judgeY+120)continue;
      if(hy<-noteR*2&&(!n.ln||yFor(n.e)<-noteR*2))continue;
      if(n.ln){
        const ty=judgeY-((n.e-songMs)/approachC)*span, r=bodyW/2;
        ctx.globalAlpha=noteAlpha(dHead);
        ctx.fillStyle=hexA(LN_COL,0.45);
        const y1=clamp(Math.max(hy,ty),-60,H+60);
        ctx.beginPath();
        if(ty>-80&&ty<H+80){ ctx.moveTo(x-r,y1); ctx.lineTo(x-r,ty); ctx.arc(x,ty,r,Math.PI,0); ctx.lineTo(x+r,y1); ctx.closePath(); }
        else { const y0=clamp(Math.min(hy,ty),-60,H+60); ctx.rect(x-bodyW/2,y0,bodyW,Math.max(4,y1-y0)); }
        ctx.fill();
        ctx.fillStyle=LN_HEAD;
        ctx.globalAlpha=noteAlpha(dHead)*belowAlpha(hy);
        ctx.beginPath(); ctx.arc(x,hy,r,0,7); ctx.fill();
        ctx.globalAlpha=1;
      }
      else {
        ctx.globalAlpha=noteAlpha(dHead)*belowAlpha(hy);
        drawSprite(sprites[l],x,hy);
        ctx.globalAlpha=1;
      }
    }
  }
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
  // ---- judgement + combo (pre-rendered sprites, no per-frame text/shadow) ----
  const cx=fieldX+fieldW/2, jy=judgeY-span*0.34;
  const ja=now-judgePop.t;
  if(judgePop.t>0&&ja<700&&txt.judge){
    const k=1-Math.min(1,ja/700), pop=ja<90?1+(90-ja)/90*0.35:1;
    drawText(txt.judge[judgePop.j],cx,jy-9,pop,Math.min(1,k*2+0.15));
    if(judgePop.early){
      const sp=judgePop.early==='FAST'?txt.fast:judgePop.early==='SLOW'?txt.slow:txt.rel;
      drawText(sp,cx,jy+14,1,Math.min(1,k*2+0.15));
    }
  }
  if(combo>1&&txt.digit){
    drawNumber(combo,cx,jy+41,1);
    drawText(txt.combo,cx,jy+62,1);
  }
  // ---- hit error bar: 直近の入力ズレ（左=FAST / 右=SLOW）----
  if(hitErrs.length){
    const by=Math.min(judgeY+noteR+16,H-52), hw=Math.min(fieldW*0.42,150);
    const seg=(w,col,a)=>{ ctx.globalAlpha=a; ctx.fillStyle=col; ctx.fillRect(cx-hw*w/W_GD,by-1.5,2*hw*w/W_GD,3); };
    seg(W_GD,JC[3],0.25); seg(W_GO,JC[2],0.3); seg(W_GR,JC[1],0.3); seg(W_P,JC[0],0.4);
    let sum=0, cnt=0;
    for(let i=0;i<hitErrs.length;i++){ const h=hitErrs[i]; const age=now-h.at; if(age>3000)continue;
      const a=age<2000?0.85:0.85*(1-(age-2000)/1000);
      ctx.globalAlpha=a; ctx.fillStyle=JC[judgeOf(Math.abs(h.dt))];
      ctx.fillRect(cx+clamp(h.dt,-W_GD,W_GD)/W_GD*hw-1,by-6,2,12);
      sum+=h.dt; cnt++; }
    if(cnt){ ctx.globalAlpha=0.95; ctx.fillStyle='#fff'; ctx.fillRect(cx+clamp(sum/cnt,-W_GD,W_GD)/W_GD*hw-1.5,by-9,3,18); }
    ctx.globalAlpha=1;
  }
  lastDrawAt=performance.now();
}
function drawSprite(sp,x,y){
  const w=sp.c.width, h=sp.c.height, sc=noteR/sp.R;
  ctx.drawImage(sp.c,x-w*sc/2,y-h*sc/2,w*sc,h*sc);
}
function hexA(hex,a){ const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`; }
function shortKey(c){ return c.startsWith('Key')?c.slice(3):c.startsWith('Digit')?c.slice(5):c.replace('Arrow',''); }

/* ============ SELECT UI ============ */
let songIdx=0, openIdx=0;
const escapeHtml=v=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function getBest(){ try{return JSON.parse(localStorage.getItem('vsrg_best_v1')||'{}');}catch(e){return {};} }
function renderSongList(){
  const list=$('songList'), detail=$('songDetail'), best=getBest();
  list.innerHTML='';
  SONGS.forEach((s,i)=>{
    const wrap=document.createElement('div');
    wrap.className='song-item'+(i===openIdx?' on':'');
    const badges=s.diffs.map(d=>{
      const r=best[s.id+'|'+d.name];
      return `<span class=\"bd${r?' done':''}\">${escapeHtml(d.level)}</span>`;
    }).join('');
    const head=document.createElement('button');
    head.className='song-head';
    head.innerHTML=`<img src=\"${s.thumb}\" alt=\"\" loading=\"lazy\" draggable=\"false\">`
      +`<span class=\"si-meta\"><span class=\"si-title\">${escapeHtml(s.title)}</span>`
      +`<span class=\"si-artist\">${escapeHtml(s.artist)}</span></span>`
      +`<span class=\"si-badges\">${badges}</span>`;
    head.onclick=()=>{ if(openIdx===i){ openIdx=-1; renderSongList(); return; }
      const switched=songIdx!==i;
      songIdx=i; song=SONGS[i]; openIdx=i;
      diffIdx=clamp(diffIdx,0,song.diffs.length-1);
      $('bgBlur').style.backgroundImage=`url(\"${song.thumb}\")`;
      renderSongList(); renderDiffs(); refreshSongInfo();
      if(switched)startPreview(); };
    wrap.appendChild(head);
    if(i===openIdx){
      detail.style.display='';
      const slot=document.createElement('div'); slot.className='detail-slot';
      slot.appendChild(detail); wrap.appendChild(slot);
      detail.classList.remove('pop'); void detail.offsetWidth; detail.classList.add('pop');
    }
    list.appendChild(wrap);
  });
  if(openIdx===-1){ detail.style.display='none'; list.appendChild(detail); }
}
function renderDiffs(){
  const row=$('diffRow'); row.innerHTML='';
  song.diffs.forEach((d,i)=>{
    const b=document.createElement('button');
    b.className='diff-btn'+(i===diffIdx?' on':''); b.dataset.d=i;
    b.innerHTML=`<span class=\"dn\">${escapeHtml(d.name)}</span><span class=\"lv\">Lv.${escapeHtml(d.level)}</span>`;
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
function latText(){
  if(!AC)return '音声出力遅延: 未計測';
  const ms=Math.round(clkSrc?latMs:outLat()*1000);
  let s=`音声出力遅延 約${ms}ms を自動補正中`+(clkSrc?'':'（プレイ開始後に確定）');
  if(ms>80)s+=' · 遅延が大きい環境（Bluetooth等）ではタップ音OFF推奨';
  return s;
}
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
  $('sRes').value=S.res;
  $('sTap').checked=S.tap; $('sTapVal').textContent=S.tapVol;
  $('sTapVol').value=S.tapVol; $('sBgm').value=S.bgm; $('sBgmVal').textContent=S.bgm;
  $('latInfo').textContent=latText();
  $('keysHint').textContent=S.keys.map(shortKey).join(' ');
  renderKeys();
}
function renderKeys(){
  const r=$('keyRow'); r.innerHTML='';
  S.keys.forEach((k,i)=>{ const d=document.createElement('div');
    d.className='key-cap'+(listenKey===i?' listening':''); d.textContent=listenKey===i?'押して…':shortKey(k);
    d.onclick=()=>{ listenKey=i; renderKeys(); }; r.appendChild(d); });
  const kt=S.keys.map(shortKey).join(' ');
  $('keysHint').textContent=kt; $('hudKeys').textContent=kt;
}
function setRate(v){ S.rate=clamp(Math.round(v*10)/10,0.5,3); rate=S.rate; applyScroll(); save(); syncSettingsUI(); refreshSongInfo(); }

/* ============ INIT ============ */
async function init(){
  try{
    const r=await fetch('songs/songs.json'); const j=await r.json();
    SONGS=j.songs||[];
  }catch(e){ SONGS=[]; }
  if(!SONGS.length){
    SONGS=[{id:'shitsurengo',title:'失恋後',artist:'櫻優',audio:'songs/失恋後/失恋後.mp3',
      thumb:'songs/失恋後/サムネイル.png',
      diffs:[{name:'Easy',level:5,file:'songs/失恋後/easy.osu'},{name:'Normal',level:9,file:'songs/失恋後/normal.osu'},{name:'Hard',level:11,file:'songs/失恋後/hard.osu'}]}];
  }
  song=SONGS[0]; diffIdx=clamp(S.lastDiff|0,0,song.diffs.length-1); rate=S.rate;
  renderSongList(); renderDiffs(); syncSettingsUI(); refreshSongInfo(); resize();
  setTimeout(resize,300);
  try{ ensureCtx(); }catch(e){}
  $('btnStart').onclick=startPlay;
  $('rateSlider').oninput=e=>setRate(parseFloat(e.target.value));
  $('rateMinus').onclick=()=>setRate(S.rate-0.1);
  $('ratePlus').onclick=()=>setRate(S.rate+0.1);
  $('qScroll').oninput=e=>{S.scroll=+e.target.value;save();syncSettingsUI();};
  $('qOffset').oninput=e=>{S.offset=+e.target.value;save();syncSettingsUI();};
  $('btnPause').onclick=()=>togglePause();
  $('btnResume').onclick=()=>togglePause(false);
  $('btnRestart').onclick=()=>{ paused=false; $('pauseMenu').classList.add('hidden');
    if(AC&&AC.state==='suspended')AC.resume(); stopAudio(); state='select'; startPlay(); };
  $('btnQuit').onclick=quitToSelect;
  $('pScroll').oninput=e=>{S.scroll=+e.target.value;applyScroll();save();syncSettingsUI();};
  $('pOffset').oninput=e=>{S.offset=+e.target.value;save();syncSettingsUI();};
  $('btnRetry').onclick=()=>{ state='select'; startPlay(); };
  $('btnBack').onclick=quitToSelect;
  const M=$('settingsModal');
  $('btnSettingsTop').onclick=()=>{ $('latInfo').textContent=latText(); M.classList.remove('hidden'); };
  $('btnCloseSettings').onclick=()=>M.classList.add('hidden');
  M.addEventListener('click',e=>{ if(e.target===M)M.classList.add('hidden'); });
  $('sScroll').oninput=e=>{S.scroll=+e.target.value;applyScroll();save();syncSettingsUI();};
  $('sOffset').oninput=e=>{S.offset=+e.target.value;save();syncSettingsUI();};
  $('sRate').oninput=e=>setRate(parseFloat(e.target.value));
  $('sLane').oninput=e=>{S.laneW=+e.target.value;save();syncSettingsUI();resize();};
  $('sNote').oninput=e=>{S.noteSize=+e.target.value;save();syncSettingsUI();resize();};
  $('sJudge').oninput=e=>{S.judgePos=+e.target.value;save();syncSettingsUI();resize();};
  $('sRes').onchange=e=>{S.res=e.target.value;dprCap=2;save();syncSettingsUI();resize();};
  $('sTap').onchange=e=>{S.tap=e.target.checked;save();syncSettingsUI();};
  $('sTapVol').oninput=e=>{S.tapVol=+e.target.value;save();syncSettingsUI();playTap();};
  $('sBgm').oninput=e=>{S.bgm=+e.target.value;if(bgmGain)bgmGain.gain.value=S.bgm/100;save();syncSettingsUI();};
  $('btnResetSettings').onclick=()=>{ S={...DEF,lastDiff:diffIdx}; dprCap=2; save(); rate=S.rate; applyScroll(); syncSettingsUI(); resize(); refreshSongInfo(); toast('設定をリセットしました'); };
  const pre=()=>{ window.removeEventListener('pointerdown',pre); if(state==='select')startPreview(); };
  window.addEventListener('pointerdown',pre);
}
init();
