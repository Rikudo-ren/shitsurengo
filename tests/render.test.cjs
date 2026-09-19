const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// 描画経路（resize/buildSprites/draw/loop）を疑似 Canvas で実行し、実行時エラーが無いこと・
// 毎フレームの重い API（shadowBlur / fillText / createLinearGradient）を使っていないことを確認する。
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8').replace(/init\(\);\s*$/, '');
function fakeCtx(log){
  const state={};
  return new Proxy({},{
    get(_,k){
      if(k==='measureText')return t=>({width:8*String(t).length});
      if(k==='createLinearGradient'||k==='createRadialGradient'){ return (...a)=>{ log.push(k); return {addColorStop(){}}; }; }
      if(k==='getContextAttributes')return ()=>({alpha:false,desynchronized:true});
      if(k in state)return state[k];
      return (...a)=>{ log.push(k); };
    },
    set(_,k,v){ if(k==='shadowBlur'&&v>0)log.push('shadowBlur'); state[k]=v; return true; }
  });
}
function engine(){
  const log=[]; const spriteLog=[];
  const mainCanvas={getContext:()=>fakeCtx(log),addEventListener(){},getBoundingClientRect:()=>({width:390,height:844}),width:0,height:0,setPointerCapture(){}};
  const el=()=>({classList:{toggle(){},add(){},remove(){}},style:{},textContent:'',getContext:()=>fakeCtx(log),addEventListener(){}});
  const sandbox={__T:0,performance:{now:()=>sandbox.__T},
    document:{getElementById:id=>id==='cv'?mainCanvas:el(),addEventListener(){},
      createElement:()=>({width:0,height:0,getContext:()=>fakeCtx(spriteLog)}),body:{classList:{toggle(){}}}},
    window:{addEventListener(){},devicePixelRatio:3},innerWidth:390,innerHeight:844,
    localStorage:{getItem:()=>null},requestAnimationFrame:()=>0,setTimeout:()=>0,clearTimeout(){}};
  vm.createContext(sandbox);
  vm.runInContext(source,sandbox);
  return {run:c=>vm.runInContext(c,sandbox),log,spriteLog,sandbox};
}

test('draw() runs on a fake canvas without per-frame text/shadow/gradient work',()=>{
  const {run,log,spriteLog,sandbox}=engine();
  run(`state='playing'; rate=1; S.offset=0; applyScroll(); srcNode={}; startCtx=1;
    AC={state:'running',currentTime:6,outputLatency:0.02,baseLatency:0.005}; resetClock();
    chart={tps:[{t:0,b:500}],notes:[]}; resize();`);
  assert.equal(run('DPR'),2,'auto は DPR 上限 2');
  assert.ok(spriteLog.includes('shadowBlur')&&spriteLog.includes('fillText'),'文字は起動時にスプライト化される');
  assert.equal(run('txt.judge.length'),5); assert.equal(run('txt.digit.length'),10);
  // ノーツ / LN / ホールド中 / 判定表示 / コンボ / エラーバー を全部含む状態で数フレーム描く
  run(`lanes=[[{t:5200,e:0,ln:false,hs:0,ts:1},{t:5600,e:6400,ln:true,hs:0,ts:0}],[{t:5300,e:0,ln:false,hs:0,ts:1}],[],[{t:4900,e:5900,ln:true,hs:1,ts:0}]];
    ptr=[0,0,0,0]; hold=[null,null,null,lanes[3][0]]; laneCnt=[1,0,0,1]; laneLit=[1,0.5,0,0];
    combo=123; judgePop={t:1,j:1,early:'SLOW'}; hitErrs=[{dt:-12,at:0},{dt:30,at:0},{dt:5,at:0}]; lastT=99999;`);
  log.length=0;
  for(let f=0; f<5; f++){ sandbox.__T=100+f*16; run('loop(performance.now())'); }
  assert.ok(!log.includes('shadowBlur'),'毎フレーム shadowBlur を使わない');
  assert.ok(!log.includes('fillText'),'毎フレーム fillText を使わない');
  assert.ok(!log.includes('createLinearGradient'),'毎フレーム gradient を作らない');
  // 1フレーム = 通常ノーツ2 + 判定文字1 + SLOW 1 + コンボ数字3 + COMBO 1 = 8 枚の drawImage
  assert.equal(log.filter(k=>k==='drawImage').length,5*8,'ノーツ・判定文字・コンボ数字はスプライト描画');
  assert.equal(run('state'),'playing');
});

test('immediateDraw is throttled so chords do not stack full redraws',()=>{
  const {run,log,sandbox}=engine();
  run(`state='playing'; rate=1; applyScroll(); srcNode={}; startCtx=1; AC={state:'running',currentTime:6}; resetClock(); chart={tps:[],notes:[]}; resize();`);
  sandbox.__T=1000; log.length=0;
  run('immediateDraw()'); const n1=log.filter(k=>k==='fillRect').length;
  sandbox.__T=1001; run('immediateDraw()');
  assert.equal(log.filter(k=>k==='fillRect').length,n1,'3ms 以内の再描画はスキップ');
  sandbox.__T=1010; run('immediateDraw()');
  assert.ok(log.filter(k=>k==='fillRect').length>n1,'間隔が空けば描画する');
});

test('resolution setting: low=1x, high=device DPR, auto adapts down only when frames are slow AND draw is expensive',()=>{
  const {run,sandbox}=engine();
  run(`state='playing'; rate=1; applyScroll(); srcNode={}; startCtx=1; AC={state:'running',currentTime:6}; resetClock(); chart={tps:[],notes:[]}; lastT=1e9;`);
  run("S.res='low'; resize();"); assert.equal(run('DPR'),1);
  run("S.res='high'; resize();"); assert.equal(run('DPR'),3);
  run("S.res='auto'; resize();"); assert.equal(run('DPR'),2);
  // 遅いフレームが続いても描画コストが小さければ（rAF が 30fps に制限されているだけ等）解像度は下げない
  run('lastFrame=0;');
  for(let f=0; f<260; f++){ sandbox.__T=1000+f*33; run('loop(performance.now())'); }
  assert.equal(run('DPR'),2);
  // 描画に時間が掛かる端末を模擬: draw 中に performance.now() が 6ms 進む
  run('const _d=draw; draw=function(n){ __T+=6; return _d(n); };');
  run('frameN=0; slowN=0; drawAcc=0;');
  for(let f=0; f<260; f++){ sandbox.__T=20000+f*33; run('loop(performance.now())'); }
  assert.equal(run('DPR'),1.5,'内部解像度を一段下げる');
  assert.equal(run('dprCap'),1.5);
});
