const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// 判定ランクの繰り上げ: ±34 Perfect+ / ±67 Perfect / ±97 Great / ±122 Good / Miss
// Perfect(旧Great窓) でも ACC・SCORE が下がらないことを実エンジンで検証する。
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8').replace(/init\(\);\s*$/, '');
// loop() は draw() まで走るので、何でも受け付ける疑似 Canvas を持たせる
function fakeCtx(){
  const state={};
  return new Proxy({},{
    get(_,k){
      if(k==='measureText')return t=>({width:8*String(t).length});
      if(k==='createLinearGradient'||k==='createRadialGradient')return ()=>({addColorStop(){}});
      if(k in state)return state[k];
      return ()=>{};
    },
    set(_,k,v){ state[k]=v; return true; }
  });
}
function engine(){
  const canvas={getContext:()=>fakeCtx(),addEventListener(){},getBoundingClientRect:()=>({width:390,height:844}),width:0,height:0};
  const el=()=>({classList:{toggle(){},add(){},remove(){}},style:{},textContent:'',getContext:()=>fakeCtx(),addEventListener(){}});
  const sandbox={__T:0,performance:{now:()=>sandbox.__T},
    document:{getElementById:id=>id==='cv'?canvas:el(),addEventListener(){},
      createElement:()=>({width:0,height:0,getContext:()=>fakeCtx()}),body:{classList:{toggle(){}}}},
    window:{addEventListener(){},devicePixelRatio:1},innerWidth:390,innerHeight:844,
    localStorage:{getItem:()=>null},requestAnimationFrame:()=>0,setTimeout:()=>0,clearTimeout(){}};
  vm.createContext(sandbox);
  vm.runInContext(source,sandbox);
  const run=code=>vm.runInContext(code,sandbox);
  run(`rate=1; S.offset=0; S.tap=false; state='playing'; applyScroll(); resize();
    srcNode={}; startCtx=0; AC={state:'running',currentTime:0,outputLatency:0,baseLatency:0}; resetClock();
    chart={tps:[],notes:[]}; lastT=99999;
    counts={pp:0,p:0,gr:0,go:0,mi:0}; judged=0; totalJud=0; combo=0; maxCombo=0; hitErrs=[]; errSum=0; errN=0;`);
  // 譜面時間 ms を直接指定して押す（resetClock 直後は clkOff=null → songMs = AC.currentTime*1000）
  const hitAt=(lane,ms)=>{ run(`resetClock(); AC.currentTime=${ms/1000}`); run(`press(${lane})`); };
  return {run,hitAt};
}
const near=(a,b,eps,msg)=>assert.ok(Math.abs(a-b)<=eps, `${msg||''} ${a} vs ${b} (±${eps})`);

test('judgeOf maps the fixed windows to the shifted ranks',()=>{
  const {run}=engine();
  assert.equal(run('JN.join()'),'PERFECT+,PERFECT,GREAT,GOOD,MISS');
  assert.equal(run('[0,34,35,67,68,97,98,122,123,500].map(judgeOf).join()'),'0,0,1,1,2,2,3,3,4,4');
  assert.equal(run('[W_P,W_GR,W_GO,W_GD].join()'),'34,67,97,122','窓幅そのものは従来どおり');
});

test('Perfect (old Great window) keeps accuracy at 100%',()=>{
  const {run,hitAt}=engine();
  run('lanes=[[{t:1000,e:0,ln:false,hs:0,ts:1},{t:2000,e:0,ln:false,hs:0,ts:1},{t:3000,e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; totalJud=3;');
  hitAt(0,1000);      // ど真ん中 → Perfect+
  hitAt(0,2000+50);   // +50ms → Perfect (SLOW)
  hitAt(0,3000-60);   // -60ms → Perfect (FAST)
  assert.equal(run('[counts.pp,counts.p,counts.gr,counts.go,counts.mi].join()'),'1,2,0,0,0');
  assert.equal(run('accNow()'),100,'Perfect を出しても ACC は 100% のまま');
  assert.equal(run('scoreNow()'),1000000,'SCORE も満点');
  assert.equal(run('gradeFor(accNow())'),'SS');
  assert.equal(run('combo'),3);
});

test('Great / Good / Miss weights: 200 / 100 / 0 (one rank up from before)',()=>{
  const {run,hitAt}=engine();
  run('lanes=[[{t:1000,e:0,ln:false,hs:0,ts:1},{t:2000,e:0,ln:false,hs:0,ts:1},{t:3000,e:0,ln:false,hs:0,ts:1},{t:4000,e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; totalJud=4;');
  hitAt(0,1000+20);   // Perfect+
  hitAt(0,2000+80);   // Great (旧 Good 窓)
  hitAt(0,3000+110);  // Good  (旧 Meh 窓)
  hitAt(0,4000+130);  // 窓外 → ノーツは残り、押下は空振り
  assert.equal(run('[counts.pp,counts.p,counts.gr,counts.go,counts.mi].join()'),'1,0,1,1,0');
  near(run('accNow()'),(300+200+100)/(300*3)*100,1e-9,'ACC = (300+200+100)/(300×3)');
  assert.equal(run('scoreNow()'),Math.floor(1000000*600/(300*4)));
  // 残ったノーツはループ側で Miss 扱い
  run('AC.currentTime=4.3; songMs=4300; loop(0);');
  assert.equal(run('counts.mi'),1);
  near(run('accNow()'),600/(300*4)*100,1e-9,'Miss は 0');
  assert.equal(run('combo'),0);
});

test('FAST/SLOW indicator: always shown for Perfect, only beyond ±8ms for Perfect+',()=>{
  const {run,hitAt}=engine();
  const note=t=>`{t:${t},e:0,ln:false,hs:0,ts:1}`;
  run(`lanes=[[${[1000,2000,3000,4000,5000].map(note).join(',')}],[],[],[]]; ptr=[0,0,0,0]; totalJud=5;`);
  hitAt(0,1000+3);  assert.equal(run('judgePop.early'),'',    'Perfect+ で ±8ms 以内は無表示');
  hitAt(0,2000-20); assert.equal(run('judgePop.early'),'FAST','Perfect+ でも 8ms 超はこれまで通り表示');
  hitAt(0,3000+36); assert.equal(run('judgePop.early'),'SLOW','Perfect は必ず SLOW/FAST を表示');
  hitAt(0,4000-36); assert.equal(run('judgePop.early'),'FAST');
  hitAt(0,5000+70); assert.equal(run('judgePop.early'),'SLOW','Great 以下は従来どおり');
  assert.equal(run('[counts.pp,counts.p,counts.gr].join()'),'2,2,1');
  assert.equal(run('judgePop.j'),2);
});

test('long note: held to the end counts as Perfect+, early release is a Miss',()=>{
  const {run,hitAt}=engine();
  run('lanes=[[{t:1000,e:2000,ln:true,hs:0,ts:0},{t:3000,e:4000,ln:true,hs:0,ts:0}],[],[],[]]; ptr=[0,0,0,0]; totalJud=4;');
  hitAt(0,1000+40);                       // 始端 Perfect
  assert.equal(run('hold[0]===lanes[0][0]'),true);
  run('AC.currentTime=2.05; songMs=2050; loop(0);');   // 終端まで保持 → Perfect+
  assert.equal(run('[counts.pp,counts.p,counts.mi].join()'),'1,1,0');
  assert.equal(run('hold[0]'),null);
  assert.equal(run('accNow()'),100);
  hitAt(0,3000);                          // 2本目: 始端 Perfect+
  assert.equal(run('hold[0]===lanes[0][1]'),true);
  run('resetClock(); AC.currentTime=3.5; release(0);'); // 500ms 早く離す → Miss
  assert.equal(run('[counts.pp,counts.p,counts.mi].join()'),'2,1,1');
  assert.equal(run('judgePop.early'),'EARLY RELEASE');
  near(run('accNow()'),900/(300*4)*100,1e-9);
});
