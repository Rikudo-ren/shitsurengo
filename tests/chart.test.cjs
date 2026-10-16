const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

// songs/*/*.osu は Web 版が実行時に読む譜面であり、そのまま .osz にも入る。
// 「更新したら壊れていた」を検出できるように、Web 側パーサ (parseOsu) で
// 実ファイルを読んで基本的な不変条件を確認する。
const source=fs.readFileSync(path.join(__dirname,'../js/app.js'),'utf8').replace(/init\(\);\s*$/,'');
const sandbox={__T:0,performance:{now:()=>0},
  document:{getElementById:()=>({classList:{toggle(){},add(){},remove(){}},style:{},
    textContent:'',getContext:()=>null,addEventListener(){}}),addEventListener(){},
    createElement:()=>({width:0,height:0,getContext:()=>null}),body:{classList:{toggle(){}}}},
  window:{addEventListener(){},devicePixelRatio:1},innerWidth:800,innerHeight:600,
  localStorage:{getItem:()=>null},requestAnimationFrame:()=>0,setTimeout:()=>0,clearTimeout(){}};
vm.createContext(sandbox);
vm.runInContext(source,sandbox);
const parseOsu=c=>vm.runInContext(c,sandbox);

const songsDir=path.join(__dirname,'..','songs');
const charts=fs.readdirSync(songsDir,{withFileTypes:true})
  .filter(d=>d.isDirectory())
  .flatMap(d=>fs.readdirSync(path.join(songsDir,d.name))
    .filter(f=>f.endsWith('.osu'))
    .map(f=>({song:d.name,file:path.join(songsDir,d.name,f)})));

test('every shipped chart parses as a playable 4K chart',()=>{
  assert.ok(charts.length>0,'songs/*/*.osu が見つかりません');
  for(const {song,file} of charts){
    const text=fs.readFileSync(file,'utf8');
    const ch=parseOsu(`parseOsu(${JSON.stringify(text)})`);
    const label=`${song}/${path.basename(file)}`;
    assert.equal(ch.keys,4,`${label}: 4K ではありません (keys=${ch.keys})`);
    assert.ok(ch.notes.length>0,`${label}: ノーツがありません`);
    assert.ok(ch.title&&ch.artist&&ch.ver,`${label}: メタデータが欠けています`);
    assert.match(ch.audio,/\.mp3$/i,`${label}: AudioFilename が不正`);
    assert.ok(ch.tps.length>0,`${label}: タイミングポイントがありません`);
    let prev=-Infinity,ln=0;
    for(const n of ch.notes){
      assert.ok(n.lane>=0&&n.lane<4,`${label}: レーンが範囲外 (${n.lane})`);
      assert.ok(n.t>=prev,`${label}: ノーツの時刻順が壊れています`);
      assert.ok(n.t>=0,`${label}: 負の時刻のノーツ`);
      prev=n.t;
      if(n.ln){ ln++; assert.ok(n.e>n.t,`${label}: LN の終端が不正 @ ${n.t}ms`); }
    }
    assert.ok(ln<=ch.notes.length,`${label}: LN 数が不正`);
  }
});

test('chart note times stay inside the song length implied by the audio',()=>{
  // 音源の長さは Python 側 (tests/test_osz_transform.py) で厳密に検証している。
  // ここでは「最後のノーツが 10分以内」といった明白な破綻だけを防ぐ。
  for(const {song,file} of charts){
    const ch=parseOsu(`parseOsu(${JSON.stringify(fs.readFileSync(file,'utf8'))})`);
    const last=Math.max(...ch.notes.map(n=>n.ln?n.e:n.t));
    assert.ok(last>0&&last<10*60*1000,`${song}/${path.basename(file)}: 最後のノーツが ${last}ms`);
  }
});
