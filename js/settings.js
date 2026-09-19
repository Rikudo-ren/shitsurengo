/**
 * settings.js — localStorage に保存する軽量な設定ストア。
 */

const KEY = 'srg.settings.v1';
const SCORE_KEY = 'srg.scores.v1';

/** キー数ごとの既定バインド (e.code) */
export const DEFAULT_BINDS = {
  1: ['Space'],
  2: ['KeyF', 'KeyJ'],
  3: ['KeyF', 'Space', 'KeyJ'],
  4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
  5: ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
  6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
  7: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
};

export const RATE_MIN = 0.5;
export const RATE_MAX = 3.0;
export const RATE_STEP = 0.1;

export const DEFAULT_SETTINGS = {
  scrollSpeed: 10,     // 1〜30（0.5刻み）
  offsetMs: 0,         // 判定オフセット -200〜200ms
  rate: 1.0,           // 演奏速度 0.5〜3.0（0.1刻み）
  masterVolume: 0.85,
  musicVolume: 1.0,
  sfxEnabled: true,
  sfxType: 'click',    // 'click' | 'pop'
  sfxVolume: 0.6,
  quality: 'high',     // 'high' | 'low'（低スペック/モバイル向け）
  mirror: false,
  showJudgeText: true,
  showFps: false,
  binds: { ...DEFAULT_BINDS },
};

function sanitize(s) {
  const out = { ...DEFAULT_SETTINGS, ...(s || {}) };
  out.scrollSpeed = clampNum(out.scrollSpeed, 1, 30, DEFAULT_SETTINGS.scrollSpeed);
  out.offsetMs = clampNum(out.offsetMs, -300, 300, 0);
  out.rate = round1(clampNum(out.rate, RATE_MIN, RATE_MAX, 1));
  out.masterVolume = clampNum(out.masterVolume, 0, 1, 0.85);
  out.musicVolume = clampNum(out.musicVolume, 0, 1, 1);
  out.sfxVolume = clampNum(out.sfxVolume, 0, 1, 0.6);
  out.sfxEnabled = !!out.sfxEnabled;
  out.mirror = !!out.mirror;
  out.showJudgeText = out.showJudgeText !== false;
  out.showFps = !!out.showFps;
  if (out.sfxType !== 'pop') out.sfxType = 'click';
  if (out.quality !== 'low') out.quality = 'high';
  const binds = {};
  for (const k of Object.keys(DEFAULT_BINDS)) {
    const src = out.binds && Array.isArray(out.binds[k]) && out.binds[k].length === +k
      ? out.binds[k] : DEFAULT_BINDS[k];
    binds[k] = src.slice();
  }
  out.binds = binds;
  return out;
}

function clampNum(v, a, b, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  if (!Number.isFinite(n)) return d;
  return n < a ? a : n > b ? b : n;
}

export function round1(v) { return Math.round(v * 10) / 10; }

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    return sanitize(raw ? JSON.parse(raw) : null);
  } catch {
    return sanitize(null);
  }
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(sanitize(s))); } catch { /* プライベートモード等 */ }
}

/* ---------- 自己ベスト ---------- */

export function loadScores() {
  try { return JSON.parse(localStorage.getItem(SCORE_KEY) || '{}') || {}; } catch { return {}; }
}

export function saveScore(id, data) {
  const all = loadScores();
  const prev = all[id];
  const isNew = !prev || data.score > prev.score;
  if (isNew) all[id] = data;
  try { localStorage.setItem(SCORE_KEY, JSON.stringify(all)); } catch { /* ignore */ }
  return { isNew, prev };
}

export function getScore(id) { return loadScores()[id] || null; }
