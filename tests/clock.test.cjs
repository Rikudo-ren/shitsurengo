const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// 実エンジンを読み込み、performance.now() と AudioContext を手動で進められるようにする。
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8').replace(/init\(\);\s*$/, '');
function engine(){
  const element={getContext:()=>({}),addEventListener(){}};
  const sandbox={document:{getElementById:()=>element,addEventListener(){}},
    window:{addEventListener(){}},localStorage:{getItem:()=>null},__T:0,performance:{now:()=>sandbox.__T}};
  vm.createContext(sandbox);
  vm.runInContext(source,sandbox);
  const run=code=>vm.runInContext(code,sandbox);
  run(`rate=1; S.offset=0; S.tap=false; state='playing'; applyScroll(); judgeY=800; topY=0; leadSec=2;
    srcNode={}; startCtx=1; AC={state:'running',currentTime:0,outputLatency:0,baseLatency:0}; resetClock();`);
  // AC は let 宣言のためグローバルオブジェクト経由では触れない → コンテキスト内で代入する
  return {run, set:(t,ct)=>{ sandbox.__T=t; if(ct!==undefined)run(`AC.currentTime=${ct}`); }};
}
const near=(a,b,eps,msg)=>assert.ok(Math.abs(a-b)<=eps, `${msg||''} ${a} vs ${b} (±${eps})`);

test('smooth clock: song time advances evenly per frame even though AC.currentTime moves in 10ms steps',()=>{
  const {run,set}=engine();
  // 音声コールバック: 10ms ごとに currentTime が階段状に進む。描画: 16.67ms ごとの rAF。
  const frame=1000/60, buf=10;
  const ctAt=t=>Math.floor(t/buf)*buf/1000+5;   // 時刻 t での currentTime（5秒から開始）
  let prev=null; const rawDeltas=[], smoothDeltas=[];
  for(let f=0; f<400; f++){
    const t=1000+f*frame; set(t, ctAt(t));
    run('syncClock(performance.now())');
    const smooth=run('songMsAt(performance.now())');
    const raw=(ctAt(t)-1)*1000;
    if(prev){ smoothDeltas.push(smooth-prev.smooth); rawDeltas.push(raw-prev.raw); }
    prev={smooth,raw};
  }
  const tail=a=>a.slice(120);
  const spread=a=>Math.max(...a)-Math.min(...a);
  assert.ok(spread(tail(rawDeltas))>=9, `currentTime そのままだとフレーム毎の進みがばらつく: ${spread(tail(rawDeltas))}`);
  assert.ok(spread(tail(smoothDeltas))<1.5, `平滑化後の進みは均一: spread=${spread(tail(smoothDeltas))}`);
  near(tail(smoothDeltas).reduce((a,b)=>a+b,0)/tail(smoothDeltas).length, frame, 0.2, '平均の進みは実時間と一致');
  // 位置そのものも真値（階段の上端≒連続時刻）から数ms以内
  const t=1000+399*frame; const truth=(t/1000+5-1)*1000;
  near(run('songMsAt(performance.now())'), truth, 8, '絶対位置');
});

test('output latency is compensated: the game clock follows what is actually heard',()=>{
  const {run,set}=engine();
  run('AC.outputLatency=0.1; AC.baseLatency=0.01;');
  for(let f=0; f<120; f++){ set(2000+f*16, 10+f*0.016); run('syncClock(performance.now())'); }
  // 聞こえている位置 = currentTime - (0.1+0.01)
  const ct=run('AC.currentTime');
  near(run('songMsAt(performance.now())'), (ct-0.11-1)*1000, 3, '補正後の譜面時間');
  near(run('latMs'), 110, 3, '表示用の遅延量');
  assert.equal(run('clkSrc'),'currentTime');
});

test('getOutputTimestamp is used when sane and rejected when bogus (Safari) or inconsistent',()=>{
  const {run,set}=engine();
  // 正常: contextTime は currentTime より 50ms 過去、performanceTime は 3ms 前
  run('AC.getOutputTimestamp=()=>({contextTime:AC.currentTime-0.05, performanceTime:performance.now()-3});');
  for(let f=0; f<120; f++){ set(3000+f*16, 20+f*0.016); run('syncClock(performance.now())'); }
  assert.equal(run('clkSrc'),'outputTimestamp');
  const ct=run('AC.currentTime');
  near(run('heardCtx(performance.now())'), ct-0.05+0.003, 0.003, 'タイムスタンプの対応で写像');
  // Safari の壊れた値 (contextTime≒0.001) は使わない
  run('AC.getOutputTimestamp=()=>({contextTime:0.001, performanceTime:0.001}); resetClock();');
  for(let f=0; f<10; f++){ set(6000+f*16, 25+f*0.016); run('syncClock(performance.now())'); }
  assert.equal(run('clkSrc'),'currentTime');
  // currentTime ベースの推定と 100ms 以上食い違う値も使わない
  run('AC.getOutputTimestamp=()=>({contextTime:AC.currentTime-0.4, performanceTime:performance.now()-3}); resetClock();');
  for(let f=0; f<10; f++){ set(7000+f*16, 30+f*0.016); run('syncClock(performance.now())'); }
  assert.equal(run('clkSrc'),'currentTime');
});

test('hard resync after suspend/resume: no slow drift, immediately consistent',()=>{
  const {run,set}=engine();
  for(let f=0; f<120; f++){ set(1000+f*16, 5+f*0.016); run('syncClock(performance.now())'); }
  // 一時停止: 実時間だけ 5 秒進み currentTime は止まる
  run('resetClock()');
  set(1000+120*16+5000, 5+120*0.016); run('syncClock(performance.now())');
  near(run('songMsAt(performance.now())'), (run('AC.currentTime')-1)*1000, 1, '復帰直後');
  // resetClock を呼ばなくても 150ms 超のズレは即時再同期
  for(let f=0; f<60; f++){ set(9000+f*16, 8+f*0.016); run('syncClock(performance.now())'); }
  set(9000+60*16+3000, 8+60*0.016); run('syncClock(performance.now())');
  near(run('songMsAt(performance.now())'), (run('AC.currentTime')-1)*1000, 1, '自動再同期');
});

test('input is judged at the event timestamp, not when the handler happens to run',()=>{
  const {run,set}=engine();
  for(let f=0; f<120; f++){ set(1000+f*16, 5+f*0.016); run('syncClock(performance.now())'); }
  // 譜面時間 T にノーツ。イベントは T ちょうどに発生したが、ハンドラは 40ms 遅れて実行された。
  const tEvent=1000+119*16+8, noteT=run(`songMsAt(${tEvent})`);
  run(`lanes=[[{t:${noteT},e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; counts={p:0,gr:0,go:0,me:0,mi:0}; judged=0;`);
  set(tEvent+40, 5+119*0.016+0.048);
  run(`press(0, evTime({timeStamp:${tEvent}}))`);
  assert.equal(run('counts.p'),1,'イベント時刻で判定すれば PERFECT');
  near(run('hitErrs[0].dt'),0,0.5,'ズレは 0ms');
  // 比較: ハンドラ実行時刻で判定すると 40ms 遅れ = GREAT になってしまう
  run(`lanes=[[{t:${noteT},e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; counts={p:0,gr:0,go:0,me:0,mi:0};`);
  run('press(0)');
  assert.equal(run('counts.gr'),1);
});

test('evTime falls back to performance.now() for implausible timestamps',()=>{
  const {run,set}=engine();
  set(5000);
  assert.equal(run('evTime({timeStamp:4990})'),4990);
  assert.equal(run('evTime({timeStamp:1758283200000})'),5000,'epoch ms は無視');
  assert.equal(run('evTime({timeStamp:0})'),5000);
  assert.equal(run('evTime(undefined)'),5000);
});

test('countdown before audio start and existing offset semantics are unchanged',()=>{
  const {run,set}=engine();
  run('srcNode=null; S.offset=50; rate=1.5;');
  near(run('rawSongMs()'), (-2000+50)*1.5, 1e-9);
  run('srcNode={}; rate=1; S.offset=123; AC.currentTime=12; startCtx=2; resetClock();');
  assert.equal(run('rawSongMs()'),10123);
});
