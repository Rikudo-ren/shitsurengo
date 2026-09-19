/**
 * osu.js — 依存ゼロの超軽量 .osu (osu!mania / Mode 3) パーサ。
 * DOM API を一切使わないので Node からもそのまま import してテストできます。
 */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** [HitObjects] の type ビット */
export const OBJ = { CIRCLE: 1, SLIDER: 2, SPINNER: 8, HOLD: 128 };

/**
 * .osu テキストを解析して譜面オブジェクトを返す。
 * @param {string} text
 * @returns {Chart}
 */
export function parseOsu(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // BOM
  const lines = text.split(/\r?\n/);

  const general = { AudioLeadIn: 0, PreviewTime: -1, Mode: 3, AudioFilename: '' };
  const metadata = {
    Title: '', TitleUnicode: '', Artist: '', ArtistUnicode: '',
    Creator: '', Version: '', Source: '', Tags: '',
  };
  const difficulty = { HPDrainRate: 5, CircleSize: 4, OverallDifficulty: 5, ApproachRate: 5 };
  const timingPoints = [];
  const hitObjects = [];
  const breaks = [];
  let background = null;
  let formatVersion = 0;

  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line[0] === ' ' && !line.trim()) continue;
    const trimmed = line.trim();
    if (!trimmed) continue;

    const m = /^\[(.+?)\]$/.exec(trimmed);
    if (m) { section = m[1]; continue; }

    const fv = /^osu file format v(\d+)/.exec(trimmed);
    if (fv) { formatVersion = +fv[1]; continue; }
    if (trimmed.startsWith('//') || trimmed.startsWith('_')) continue;

    switch (section) {
      case 'General': {
        const ci = trimmed.indexOf(':');
        if (ci > 0) {
          const key = trimmed.slice(0, ci).trim();
          const val = trimmed.slice(ci + 1).trim();
          if (key === 'AudioFilename') general.AudioFilename = val;
          else if (key === 'AudioLeadIn') general.AudioLeadIn = +val || 0;
          else if (key === 'PreviewTime') general.PreviewTime = +val || -1;
          else if (key === 'Mode') general.Mode = +val || 0;
        }
        break;
      }
      case 'Metadata': {
        const ci = trimmed.indexOf(':');
        if (ci > 0) {
          const key = trimmed.slice(0, ci).trim();
          const val = trimmed.slice(ci + 1).trim();
          if (key in metadata) metadata[key] = val;
        }
        break;
      }
      case 'Difficulty': {
        const ci = trimmed.indexOf(':');
        if (ci > 0) {
          const key = trimmed.slice(0, ci).trim();
          const val = parseFloat(trimmed.slice(ci + 1));
          if (key in difficulty && Number.isFinite(val)) difficulty[key] = val;
        }
        break;
      }
      case 'TimingPoints': {
        const p = trimmed.split(',');
        if (p.length < 2) break;
        const time = parseFloat(p[0]);
        const beatLength = parseFloat(p[1]);
        if (!Number.isFinite(time) || !Number.isFinite(beatLength) || beatLength === 0) break;
        timingPoints.push({
          time,
          beatLength,
          meter: +(p[2] || 4),
          volume: +(p[5] != null && p[5] !== '' ? p[5] : 100),
          uninherited: (p[6] === undefined ? beatLength > 0 : p[6].trim() === '1'),
        });
        break;
      }
      case 'Events': {
        const p = trimmed.split(',');
        if (p[0] === '0' && p.length >= 3 && !background) {
          background = p[2].replace(/^"|"$/g, '');
        } else if (p[0] === '2' && p.length >= 3) {
          breaks.push({ start: +p[1], end: +p[2] });
        }
        break;
      }
      case 'HitObjects': {
        hitObjects.push(trimmed);
        break;
      }
      default: break;
    }
  }

  const keys = clamp(Math.round(difficulty.CircleSize) || 4, 1, 10);

  /* ---- スクロール速度 (SV) タイムライン ---- */
  timingPoints.sort((a, b) => a.time - b.time);
  const firstObjTime = hitObjects.length ? Infinity : 0;
  let minTime = firstObjTime;
  for (const tp of timingPoints) if (tp.time < minTime) minTime = tp.time;
  if (!Number.isFinite(minTime)) minTime = 0;

  const segs = [{ time: Math.min(minTime, timingPoints[0] ? timingPoints[0].time : 0) - 1000, mult: 1 }];
  for (const tp of timingPoints) {
    if (tp.uninherited || tp.beatLength >= 0) continue;
    const mult = clamp(-100 / tp.beatLength, 0.1, 10);
    const last = segs[segs.length - 1];
    if (last.time === tp.time) last.mult = mult;
    else segs.push({ time: tp.time, mult });
  }
  // 累積仮想時間 S(t) = ∫ sv dt
  for (let i = 1; i < segs.length; i++) {
    segs[i].acc = (segs[i - 1].acc || 0) + (segs[i].time - segs[i - 1].time) * segs[i - 1].mult;
  }
  segs[0].acc = 0;
  const hasSV = segs.length > 1;

  /** 実時間(ms) → SV込み仮想時間(ms) */
  function svTime(t) {
    if (!hasSV) return t;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (segs[mid].time <= t) lo = mid; else hi = mid - 1; }
    const s = segs[lo];
    return s.acc + (t - s.time) * s.mult;
  }

  /* ---- ヒットオブジェクト ---- */
  const notes = [];
  for (const raw of hitObjects) {
    const p = raw.split(',');
    if (p.length < 4) continue;
    const x = parseFloat(p[0]);
    const time = Math.round(parseFloat(p[2]));
    const type = parseInt(p[3], 10) || 0;
    if (!Number.isFinite(time)) continue;
    const isLN = (type & OBJ.HOLD) !== 0;
    let endTime = time;
    if (isLN && p.length > 5) {
      const end = parseFloat(p[5].split(':')[0]);
      if (Number.isFinite(end)) endTime = Math.round(end);
    }
    if (endTime < time) endTime = time;
    const col = clamp(Math.floor((x * keys) / 512), 0, keys - 1);
    notes.push({
      time, endTime, col, isLN,
      sv: hasSV ? svTime(time) : time,
      svEnd: hasSV ? svTime(endTime) : endTime,
      // 判定状態（Judge が埋める）
      state: 'idle', headJudge: null, tailJudge: null, headErr: 0, tailErr: 0,
    });
  }
  notes.sort((a, b) => a.time - b.time || a.col - b.col);

  let lastTime = 0;
  for (const n of notes) if (n.endTime > lastTime) lastTime = n.endTime;
  for (const tp of timingPoints) if (tp.time > lastTime) lastTime = tp.time;

  const baseTp = timingPoints.find((t) => t.uninherited) || timingPoints[0];
  const bpm = baseTp ? 60000 / Math.abs(baseTp.beatLength) : 0;
  const durationMs = lastTime;
  const spanSec = notes.length ? Math.max(1, (notes[notes.length - 1].time - notes[0].time) / 1000) : 1;

  const cols = new Array(keys).fill(0);
  let lnCount = 0;
  for (const n of notes) { cols[n.col]++; if (n.isLN) lnCount++; }

  /** @type {Chart} */
  return {
    formatVersion,
    general, metadata, difficulty,
    keys, notes, timingPoints, breaks, background,
    svTime, hasSV,
    bpm, durationMs,
    stats: {
      objects: notes.length,
      ln: lnCount,
      totalJudgements: notes.length + lnCount, // ヘッド + テイル
      nps: notes.length / spanSec,
      perColumn: cols,
    },
  };
}

/**
 * @typedef {Object} Chart
 * @property {number} keys
 * @property {Array<{time:number,endTime:number,col:number,isLN:boolean,sv:number,svEnd:number}>} notes
 * @property {(t:number)=>number} svTime
 * @property {{objects:number,ln:number,totalJudgements:number,nps:number,perColumn:number[]}} stats
 */
