/**
 * tools/test-judge.js — 譜面パーサと判定ロジックの検証（npm test / ブラウザ不要）。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsu } from '../js/osu.js';
import { Judge, MAX_SCORE, WINDOWS, ACC_VALUE, judgeFor, rankFor } from '../js/judge.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SONGS = join(ROOT, 'songs');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.error('  ✗ ' + msg); }
}
function near(a, b, eps, msg) { ok(Math.abs(a - b) <= eps, `${msg} (got ${a}, want ${b})`); }

/** step 間隔で update() を回し、指定時刻に入力イベントを流すシミュレータ */
function simulate(chart, events, stepMs = 3) {
  const judge = new Judge({ columns: chart.keys, notes: chart.notes });
  const evs = events.slice().sort((a, b) => a.t - b.t || (a.type === 'release' ? 1 : -1));
  let ei = 0;
  const end = chart.durationMs + 2000;
  for (let t = -1000; t < end; t += stepMs) {
    while (ei < evs.length && evs[ei].t <= t) {
      const e = evs[ei++];
      if (e.type === 'press') judge.press(e.col, e.t);
      else judge.release(e.col, e.t);
    }
    judge.update(t);
  }
  return judge;
}

const playEvents = (chart, offset = 0, releaseFn = null) => {
  const evs = [];
  for (const n of chart.notes) {
    evs.push({ t: n.time + offset, type: 'press', col: n.col });
    if (n.isLN) evs.push({ t: (releaseFn ? releaseFn(n) : n.endTime) + offset, type: 'release', col: n.col });
  }
  return evs;
};

const note = (col, time, endTime = 0) => ({
  time, endTime: endTime || time, col, isLN: !!endTime && endTime > time,
  sv: time, svEnd: endTime || time,
  state: 'idle', headJudge: null, tailJudge: null, headErr: 0, tailErr: 0,
});

/* ================= 判定窓 ================= */
console.log('\n=== 判定窓 (osu!mania 準拠) ===');
ok(judgeFor(0) === 'perfect', '0ms → PERFECT');
ok(judgeFor(34) === 'perfect' && judgeFor(34.5) === 'great', `±${WINDOWS.perfect}ms まで PERFECT`);
ok(judgeFor(67) === 'great' && judgeFor(67.5) === 'good', `±${WINDOWS.great}ms まで GREAT`);
ok(judgeFor(97) === 'good' && judgeFor(97.5) === 'meh', `±${WINDOWS.good}ms まで GOOD`);
ok(judgeFor(122) === 'meh' && judgeFor(122.5) === null, `±${WINDOWS.meh}ms まで MEH / 外は MISS`);

/* ================= 合成譜面での厳密テスト ================= */
console.log('\n=== 合成譜面 (4K) ===');
const synth = {
  keys: 4,
  durationMs: 4000,
  hasSV: false,
  svTime: (t) => t,
  notes: [note(0, 1000), note(0, 2000), note(0, 3000), note(1, 1000, 2500)],
};
synth.notes.sort((a, b) => a.time - b.time);
const TOTAL = 5; // 通常3 + LN(ヘッド/テイル)2

let j = simulate(synth, playEvents(synth));
ok(j.counts.perfect === TOTAL, `オール Perfect = ${TOTAL} 判定`);
ok(j.score === MAX_SCORE, `スコア上限 ${MAX_SCORE}`);
near(j.accuracy, 100, 1e-9, 'Accuracy 100%');
ok(j.maxCombo === TOTAL, `MAX COMBO ${TOTAL}`);
ok(rankFor(j.accuracy, j.counts) === 'SS', 'Rank SS');

j = simulate(synth, []);
ok(j.counts.miss === TOTAL && j.score === 0 && j.accuracy === 0, '放置 → オール Miss / 0点 / 0%');
ok(rankFor(j.accuracy, j.counts) === 'D', 'Rank D');

j = simulate(synth, playEvents(synth, 200));
ok(j.counts.miss === TOTAL, '±122ms 外の入力は全て Miss（空振り扱い）');
ok(j.score === 0, 'Miss のみ → 0点');

j = simulate(synth, playEvents(synth, 50));
ok(j.counts.great === TOTAL && j.score === MAX_SCORE * 0.75, '一律 +50ms → GREAT / 750,000点');
near(j.accuracy, (ACC_VALUE.great / ACC_VALUE.perfect) * 100, 1e-9, 'Accuracy 66.67%');

j = simulate(synth, playEvents(synth, -110));
ok(j.counts.meh === TOTAL, '一律 -110ms → MEH');
near(j.accuracy, (ACC_VALUE.meh / ACC_VALUE.perfect) * 100, 1e-9, 'Accuracy 16.67%');
ok(j.averageError < 0 && j.early === TOTAL && j.late === 0, '平均誤差がマイナス（早押し）として記録される');

// LN を途中で離す
j = simulate(synth, playEvents(synth, 0, (n) => n.isLN ? n.time + 200 : n.time));
ok(j.counts.perfect === TOTAL - 1 && j.counts.miss === 1, 'LN 早期離し → テイル Miss のみ');
ok(j.maxCombo === 2 && j.combo === 2, 'LN 早期離しでコンボがリセットされる');

// LN を最後まで押さえきる（release イベント無し）
j = simulate(synth, synth.notes.map((n) => ({ t: n.time, type: 'press', col: n.col })));
ok(j.counts.perfect === TOTAL, 'LN 押さえきり → テイル自動 Perfect');

// 空打ち（ノーツの無いレーン / 窓外のタイミング）
const base = simulate(synth, []);
j = simulate(synth, [{ t: 3800, type: 'press', col: 3 }, { t: 500, type: 'press', col: 0 }]);
ok(j.judged === base.judged && j.score === base.score && JSON.stringify(j.counts) === JSON.stringify(base.counts),
  '空打ちはスコア・判定数に影響しない');

// オフセット込みの誤差記録
j = simulate(synth, playEvents(synth, 20));
ok(Math.abs(j.averageError - 20) < 30, `平均誤差 ≈ +20ms (got ${j.averageError.toFixed(1)})`);

/* ================= 実譜面 ================= */
const folders = readdirSync(SONGS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
  .map((d) => d.name);

for (const folder of folders) {
  const dir = join(SONGS, folder);
  const files = readdirSync(dir).filter((f) => f.endsWith('.osu'));
  if (!files.length) continue;
  console.log(`\n=== ${folder} ===`);
  for (const file of files.sort()) {
    const chart = parseOsu(readFileSync(join(dir, file), 'utf8'));
    const st = chart.stats;
    console.log(`-- ${file}: ${chart.keys}K / ${st.objects} notes (LN ${st.ln}) / BPM ${Math.round(chart.bpm)} / ${(chart.durationMs / 1000).toFixed(1)}s / ${st.nps.toFixed(2)} NPS`);

    ok(chart.general.Mode === 3, 'Mode 3 (osu!mania)');
    ok(/\.mp3$|\.ogg$|\.wav$/i.test(chart.general.AudioFilename), `AudioFilename = ${chart.general.AudioFilename}`);
    ok(chart.notes.length === st.objects && st.objects > 0, 'ノーツ数一致');
    ok(chart.notes.every((n) => n.col >= 0 && n.col < chart.keys), '全ノーツのレーンが範囲内');
    ok(chart.notes.every((n) => n.endTime >= n.time), 'LN の終了 >= 開始');
    ok(st.totalJudgements === st.objects + st.ln, '総判定数 = notes + LN');
    ok(chart.notes.every((n, i) => i === 0 || chart.notes[i - 1].time <= n.time), '時刻順にソート済み');

    const p = simulate(chart, playEvents(chart));
    ok(p.counts.perfect === st.totalJudgements, `オール Perfect = ${st.totalJudgements} 判定`);
    ok(p.score === MAX_SCORE, `スコア = ${MAX_SCORE}`);
    near(p.accuracy, 100, 1e-9, 'Accuracy = 100%');
    ok(p.maxCombo === st.totalJudgements, `MAX COMBO = ${st.totalJudgements}`);

    const m = simulate(chart, []);
    ok(m.counts.miss === st.totalJudgements && m.score === 0 && m.accuracy === 0, '放置 → オール Miss / 0点');

    const g = simulate(chart, playEvents(chart, 50));
    ok(g.counts.great === st.totalJudgements, '一律 +50ms → 全て GREAT');
    ok(g.score === Math.round(MAX_SCORE * 0.75), 'スコア = 750,000');

    // LN を「確実に窓の外」で離す（長さ 130ms 以上の LN が対象）
    const longLns = chart.notes.filter((n) => n.isLN && n.endTime - n.time > 130).length;
    const d = simulate(chart, playEvents(chart, 0, (n) => (n.isLN ? n.time + 1 : n.time)));
    ok(d.counts.miss >= longLns, `LN 即時離し → テイル Miss ${longLns} 本以上 (got ${d.counts.miss})`);
    ok(d.score < MAX_SCORE, 'LN 即時離しでスコアが減る');
  }
}

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
