const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// 判定: ±34 Perfect+ / ±67 Perfect / ±97 Great / ±122 Good / ±151 Meh(50) / Miss
// ACC/SCORE は osu!mania stable (ScoreV1) に準拠（osu!wiki: Gameplay/Accuracy, Gameplay/Score/ScoreV1/osu!mania）:
//   ACC   = (300×(P+ + P) + 200×Gr + 100×Go + 50×Meh) ÷ (300×総判定数)   … P+ は MAX (rainbow 300) として 300 扱い
//   SCORE = Base + Bonus（各上限 500,000、合計 1,000,000 上限）
//     BaseScore  = (500000 ÷ 総判定数) × (HitValue ÷ 320)             … HitValue: P+=320, P=300, Gr=200, Go=100, Meh=50, Miss=0
//     BonusScore = (500000 ÷ 総判定数) × (HitBonusValue × √Bonus ÷ 320) … HitBonusValue: P+/P=32, Gr=16, Go=8, Meh=4, Miss=0
//     Bonus は [0,100] の浮動値（開始値 100）。ヒット毎に Bonus += HitBonus − HitPunishment
//     （P+ +2 / P +1 / Gr −8 / Go −24 / Meh −44 / Miss → 0 にリセット）。BonusScore は更新前の Bonus で評価。
// を実エンジンで検証する。
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
    counts={pp:0,p:0,gr:0,go:0,me:0,mi:0}; judged=0; totalJud=0; combo=0; maxCombo=0; hitErrs=[]; errSum=0; errN=0;
    bonusVal=100; scoreBase=0; scoreBonus=0;`);
  // 譜面時間 ms を直接指定して押す（resetClock 直後は clkOff=null → songMs = AC.currentTime*1000）
  const hitAt=(lane,ms)=>{ run(`resetClock(); AC.currentTime=${ms/1000}`); run(`press(${lane})`); };
  return {run,hitAt};
}
const near=(a,b,eps,msg)=>assert.ok(Math.abs(a-b)<=eps, `${msg||''} ${a} vs ${b} (±${eps})`);

test('judgeOf maps the fixed windows to the shifted ranks (50/MEH あり)',()=>{
  const {run}=engine();
  assert.equal(run('JN.join()'),'PERFECT+,PERFECT,GREAT,GOOD,MEH,MISS');
  assert.equal(run('[0,34,35,67,68,97,98,122,123,151,152,500].map(judgeOf).join()'),'0,0,1,1,2,2,3,3,4,4,5,5');
  assert.equal(run('[W_P,W_GR,W_GO,W_GD,W_MEH].join()'),'34,67,97,122,151');
});

test('Perfect (old Great window) keeps accuracy at 100% (MAX/300 は ACC 同価)',()=>{
  const {run,hitAt}=engine();
  run('lanes=[[{t:1000,e:0,ln:false,hs:0,ts:1},{t:2000,e:0,ln:false,hs:0,ts:1},{t:3000,e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; totalJud=3;');
  hitAt(0,1000);      // ど真ん中 → Perfect+
  hitAt(0,2000+50);   // +50ms → Perfect (SLOW)
  hitAt(0,3000-60);   // -60ms → Perfect (FAST)
  assert.equal(run('[counts.pp,counts.p,counts.gr,counts.go,counts.me,counts.mi].join()'),'1,2,0,0,0,0');
  assert.equal(run('accNow()'),100,'Perfect を出しても ACC は 100% のまま');
  // ScoreV1: base = (500000/3)×(320+300+300)/320 ≈ 479166.67 + bonus 満額 500000 → 979167（all-P+ でないので満点ではない）
  near(run('scoreNow()'),Math.round(500000/3*(320+300+300)/320+500000),1,'base は HitValue 依存（P+=320, P=300）+ Bonus 500,000');
  assert.equal(run('gradeFor(accNow())'),'SS');
  assert.equal(run('combo'),3);
});

test('Great / Good / Meh / Miss: ACC 重み 200 / 100 / 50 / 0',()=>{
  const {run,hitAt}=engine();
  const note=t=>`{t:${t},e:0,ln:false,hs:0,ts:1}`;
  run(`lanes=[[${[1000,2000,3000,4000,5000].map(note).join(',')}],[],[],[]]; ptr=[0,0,0,0]; totalJud=5;`);
  hitAt(0,1000+20);   // Perfect+
  hitAt(0,2000+80);   // Great
  hitAt(0,3000+110);  // Good
  hitAt(0,4000+130);  // Meh (122〜151ms 帯)
  assert.equal(run('[counts.pp,counts.p,counts.gr,counts.go,counts.me,counts.mi].join()'),'1,0,1,1,1,0');
  near(run('accNow()'),(300+200+100+50)/(300*4)*100,1e-9,'ACC = (300+200+100+50)/(300×4)');
  assert.equal(run('combo'),4,'Meh でもコンボは途切れない（stable と同じ）');
  // ScoreV1: per=100000。base = 100000×(320+200+100+50)/320
  // bonus = 100000×(32×√100 + 16×√100 + 8×√92 + 4×√68)/320（Gr で 100→92 / Go で 92→68）
  const per=500000/5;
  const expScore=Math.round(
    per*(320+200+100+50)/320 +
    per*(32*Math.sqrt(100)+16*Math.sqrt(100)+8*Math.sqrt(92)+4*Math.sqrt(68))/320);
  near(run('scoreNow()'),expScore,1,'ScoreV1 Base+Bonus（Meh は HitBonusValue=4 / 罰 −44）');
  assert.equal(run('bonusVal'),24,'100 →(P+) 100 →(Gr) 92 →(Go) 68 →(Meh) 24');
  // 5本目は放置 → ループ側で Miss 扱い（W_MEH 超過で自動Miss）
  run('AC.currentTime=5.4; songMs=5400; loop(0);');
  assert.equal(run('counts.mi'),1);
  assert.equal(run('bonusVal'),0,'Miss で Bonus は 0 にリセット');
  near(run('accNow()'),650/(300*5)*100,1e-9,'Miss は 0');
  assert.equal(run('combo'),0);
  near(run('scoreNow()'),expScore,1,'Miss は Base/Bonus とも 0 加算');
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

test('long note: held to the end counts as Perfect+, 151ms 超の早離しは Miss, 窓内は通常判定',()=>{
  const {run,hitAt}=engine();
  run('lanes=[[{t:1000,e:2000,ln:true,hs:0,ts:0},{t:3000,e:4000,ln:true,hs:0,ts:0},{t:5000,e:6000,ln:true,hs:0,ts:0}],[],[],[]]; ptr=[0,0,0,0]; totalJud=6;');
  hitAt(0,1000+40);                       // 始端 Perfect
  assert.equal(run('hold[0]===lanes[0][0]'),true);
  run('AC.currentTime=2.05; songMs=2050; loop(0);');   // 終端まで保持 → Perfect+
  assert.equal(run('[counts.pp,counts.p,counts.mi].join()'),'1,1,0');
  assert.equal(run('hold[0]'),null);
  hitAt(0,3000);                          // 2本目: 始端 Perfect+
  assert.equal(run('hold[0]===lanes[0][1]'),true);
  run('resetClock(); AC.currentTime=3.5; release(0);'); // 500ms 早く離す → Miss
  assert.equal(run('[counts.pp,counts.p,counts.mi].join()'),'2,1,1');
  assert.equal(run('judgePop.early'),'EARLY RELEASE');
  // 3本目: 始端 Perfect+ → 130ms 早く離す → Meh(50)（±151 窓内なので救済）
  hitAt(0,5000);
  run('resetClock(); AC.currentTime=5.87; release(0);');
  assert.equal(run('counts.me'),1,'Meh 窓内の早離しは Meh');
  assert.equal(run('judgePop.j'),4);
  assert.equal(run('judgePop.early'),'FAST');
  near(run('accNow()'),(300*4+50)/(300*6)*100,1e-9,'pp×3 + p×1 = 300換算4つ + Meh 50（6判定）');
});

test('ScoreV1: all-P+ = 1,000,000 / all-P = 968,750 — SCORE は ACC×10000 ではない',()=>{
  { // all Perfect+ (MAX=320): base 500,000 + bonus 500,000 = 1,000,000
    const {run,hitAt}=engine();
    run('lanes=[[{t:1000,e:0,ln:false,hs:0,ts:1},{t:2000,e:0,ln:false,hs:0,ts:1},{t:3000,e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; totalJud=3;');
    hitAt(0,1000); hitAt(0,2000); hitAt(0,3000);
    assert.equal(run('accNow()'),100);
    assert.equal(run('scoreNow()'),1000000,'all-P+ (all-MAX) は満点');
    assert.equal(run('gradeFor(accNow())'),'SS');
  }
  { // all Perfect (300): base = 500,000×300/320 = 468,750 + bonus 500,000 = 968,750（ACC は 100% のまま）
    const {run,hitAt}=engine();
    run('lanes=[[{t:1000,e:0,ln:false,hs:0,ts:1},{t:2000,e:0,ln:false,hs:0,ts:1},{t:3000,e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; totalJud=3;');
    hitAt(0,1000+40); hitAt(0,2000+40); hitAt(0,3000+40);   // いずれも Perfect 窓
    assert.equal(run('[counts.pp,counts.p].join()'),'0,3');
    assert.equal(run('accNow()'),100,'MAX も 300 も ACC 的には同価');
    near(run('scoreNow()'),968750,1,'all-P は ACC 100% でも SCORE 968,750（旧実装の acc×10000 ではない）');
    assert.equal(run('gradeFor(accNow())'),'SS');
  }
});

test('ScoreV1 bonus: Miss で Bonus は 0 になり、回復は P+ +2 ずつ（BonusScore は更新前の Bonus で評価）',()=>{
  const {run,hitAt}=engine();
  run('lanes=[[{t:1000,e:0,ln:false,hs:0,ts:1},{t:2000,e:0,ln:false,hs:0,ts:1},{t:3000,e:0,ln:false,hs:0,ts:1},{t:4000,e:0,ln:false,hs:0,ts:1}],[],[],[]]; ptr=[0,0,0,0]; totalJud=4;');
  run('AC.currentTime=1.2; loop(0);');   // 1000ms のノーツを自動 Miss（Bonus → 0）
  assert.equal(run('counts.mi'),1);
  assert.equal(run('bonusVal'),0,'Miss で Bonus は 0 にリセット');
  hitAt(0,2000);   // P+ だが Bonus=0 → BonusScore 0、Bonus → 2
  assert.equal(run('bonusVal'),2);
  hitAt(0,3000);   // BonusScore = 125000×32×√2/320 ≈ 17677.7、Bonus → 4
  hitAt(0,4000);   // BonusScore = 125000×32×√4/320 = 25000、Bonus → 6
  assert.equal(run('[counts.pp,counts.mi].join()'),'3,1');
  near(run('accNow()'),900/(300*4)*100,1e-9);
  // base = 125000×3 = 375000 / bonus = 0 + 17677.7 + 25000 = 42677.7 → 417678
  near(run('scoreNow()'),Math.round(375000+125000*(32*Math.sqrt(2)/320+32*Math.sqrt(4)/320)),1);
  assert.equal(run('bonusVal'),6);
});
