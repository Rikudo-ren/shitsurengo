const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

// 実際のエンジンを実行。DOM初期化と音源ロードだけを省く。
const source=fs.readFileSync(require('node:path').join(__dirname,'../js/app.js'),'utf8').replace(/init\(\);\s*$/, '');
function engine(){
  const element={getContext:()=>({}),addEventListener(){}};
  const sandbox={document:{getElementById:()=>element,addEventListener(){}},
    window:{addEventListener(){}},localStorage:{getItem:()=>null},performance:{now:()=>0}};
  vm.createContext(sandbox);
  vm.runInContext(source,sandbox);
  return code=>vm.runInContext(code,sandbox);
}
function near(a,b){assert.ok(Math.abs(a-b)<1e-7, `${a} != ${b}`);}

for(let step=5;step<=30;step++){
  const rate=step/10;
  for(const offset of [-200,-100,0,100,200]){
    test(`${rate}x / ${offset}ms: real-time correction, rendering and input agree`,()=>{
      const run=engine();
      run(`rate=${rate}; S.offset=${offset}; S.tap=false;
        AC={currentTime:0}; srcNode={}; startCtx=2;
        state='playing'; applyScroll(); judgeY=800; topY=0;`);
      // 同じ音源位置における補正量は実時間で常にoffset。
      run('AC.currentTime=startCtx+10000/rate/1000;');
      near(run('(rawSongMs()-10000)/rate'),offset);
      // 補正後の到達時刻で描画と入力が一致。古いフレーム時刻を意図的に残す。
      run('AC.currentTime=startCtx+10000/rate/1000-S.offset/1000; songMs=rawSongMs();');
      near(run('yFor(10000)'),800);
      run(`lanes=[[{t:10000,e:12000,ln:true,hs:0,ts:0}],[],[],[]];
        songMs=-99999; press(0);`);
      assert.equal(run('counts.pp'),1);
      assert.equal(run('hold[0]===lanes[0][0]'),true);
      run('AC.currentTime=startCtx+12000/rate/1000-S.offset/1000; release(0);');
      assert.equal(run('counts.pp'),2);
      assert.equal(run('hold[0]'),null);
      // 未開始のカウントダウンも同じ単位で換算。
      run('srcNode=null;');
      near(run('rawSongMs()'),(-2000+offset)*rate);
    });
  }
}
test('1x preserves existing saved offset behavior',()=>{
  const run=engine();
  run('rate=1; S.offset=123; AC={currentTime:12}; srcNode={}; startCtx=2;');
  assert.equal(run('rawSongMs()'),10123);
});
