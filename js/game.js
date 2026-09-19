/**
 * game.js — プレイ画面の中核（ループ / 入力 / 判定 / HUD）。
 */
import { Judge, JUDGE_LABEL, rankFor } from './judge.js';
import { Renderer } from './render.js';

export const LEAD_IN_MS = 2000; // 開始前のカウント（楽曲時間 -2000ms からスタート）

const JUDGE_COLOR = {
  perfect: '#ffe27a',
  great: '#5ef08a',
  good: '#4cc9ff',
  meh: '#c39bff',
  miss: '#ff6b7a',
  empty: '#93a0b8',
};

export class Game {
  /**
   * @param {object} o
   * @param {HTMLCanvasElement} o.canvas
   * @param {object} o.hud DOM 参照
   * @param {object} o.chart parseOsu の結果
   * @param {AudioEngine} o.audio
   * @param {object} o.settings
   * @param {number} o.rate
   * @param {Function} o.onFinish
   * @param {Function} o.onPauseRequest
   */
  constructor(o) {
    this.canvas = o.canvas;
    this.hud = o.hud;
    this.chart = o.chart;
    this.audio = o.audio;
    this.settings = o.settings;
    this.rate = o.rate;
    this.onFinish = o.onFinish;
    this.onPauseRequest = o.onPauseRequest;
    this.onResumeRequest = o.onResumeRequest;
    this.diffLabel = o.diffLabel || '';

    this.renderer = new Renderer(o.canvas);
    this.renderer.setQuality(this.settings.quality);

    // ミラー適用（元譜面は書き換えない）
    const keys = this.chart.keys;
    const mirror = !!this.settings.mirror;
    this.mirror = mirror;
    this.notes = this.chart.notes.map((n) => (mirror ? { ...n, col: keys - 1 - n.col } : n));
    this.field = { columns: keys, notes: this.notes };
    this.judge = new Judge(this.field);

    this.cols = this.judge.cols;
    this.down = new Array(keys).fill(false);
    this.pointerCols = new Map();   // pointerId -> col
    this.pointerCount = new Array(keys).fill(0);
    this.keyToCol = new Map();
    this.applyBinds();

    this.effects = [];
    this.renderPtr = new Array(keys).fill(0);
    this.f = {
      time: -LEAD_IN_MS, curSv: -LEAD_IN_MS, pxPerMs: 0.6,
      cols: this.cols, renderPtr: this.renderPtr, down: this.down, effects: this.effects,
      heldNote: new Array(keys).fill(null),
    };

    this.paused = false;
    this.finished = false;
    this.running = false;
    this._lastHud = { score: -1, acc: -1, combo: -1, judge: '' };
    this._frames = 0; this._fpsT = 0; this._fps = 60;
    this._resizeRaf = 0;

    this.endTime = Math.max(this.chart.durationMs, this.chart.notes.length ? this.chart.notes[this.chart.notes.length - 1].endTime : 0) + 900;

    this._onKeyDown = this._onKeyDown.bind(this);
    this._onKeyUp = this._onKeyUp.bind(this);
    this._onPointerDown = this._onPointerDown.bind(this);
    this._onPointerUp = this._onPointerUp.bind(this);
    this._onResize = this._onResize.bind(this);
    this._onVisibility = this._onVisibility.bind(this);
    this._loop = this._loop.bind(this);
  }

  applyBinds() {
    const binds = this.settings.binds[String(this.chart.keys)] || this.settings.binds['4'];
    this.keyToCol.clear();
    (binds || []).forEach((code, i) => { if (code) this.keyToCol.set(code, i); });
  }

  mount() {
    window.addEventListener('keydown', this._onKeyDown, { passive: false });
    window.addEventListener('keyup', this._onKeyUp);
    this.canvas.addEventListener('pointerdown', this._onPointerDown);
    window.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('pointercancel', this._onPointerUp);
    window.addEventListener('resize', this._onResize);
    window.addEventListener('orientationchange', this._onResize);
    document.addEventListener('visibilitychange', this._onVisibility);
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.resize();
  }

  destroy() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('keyup', this._onKeyUp);
    this.canvas.removeEventListener('pointerdown', this._onPointerDown);
    window.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('pointercancel', this._onPointerUp);
    window.removeEventListener('resize', this._onResize);
    window.removeEventListener('orientationchange', this._onResize);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.audio.stop();
  }

  resize() {
    const rect = this.canvas.parentElement.getBoundingClientRect();
    const w = Math.max(240, Math.round(rect.width || window.innerWidth));
    const h = Math.max(240, Math.round(rect.height || window.innerHeight));
    this.renderer.resize(w, h, this.chart.keys);
    this.f.pxPerMs = this.renderer.pxPerMs(this.settings.scrollSpeed);
    if (!this.running || this.paused) this._drawOnce();
  }

  _drawOnce() {
    const t = this.f.time;
    this.f.curSv = this.chart.hasSV ? this.chart.svTime(t) : t;
    this.f.pxPerMs = this.renderer.pxPerMs(this.settings.scrollSpeed);
    this.renderer.draw(this.f);
  }

  start() {
    this.reset();
    this.mount();
    this.audio.start(LEAD_IN_MS, this.rate, this.chart.durationMs);
    this.running = true;
    this.paused = false;
    this._fpsT = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  }

  reset() {
    this.judge.reset();
    this.effects.length = 0;
    this.renderPtr.fill(0);
    this.down.fill(false);
    this.pointerCount.fill(0);
    this.pointerCols.clear();
    this.finished = false;
    this._lastHud = { score: -1, acc: -1, combo: -1, judge: '' };
    this.f.time = -LEAD_IN_MS;
    if (this.hud.countdown) { this.hud.countdown.textContent = ''; this.hud.countdown.classList.remove('hidden'); }
    this._updateHud(-LEAD_IN_MS, true);
  }

  retry() {
    this.audio.stop();
    this.reset();
    this.applyBinds();
    this.renderer.setQuality(this.settings.quality);
    this.resize();
    this.paused = false;
    this.audio.start(LEAD_IN_MS, this.rate, this.chart.durationMs);
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    this.running = true;
    this._fpsT = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  }

  /** 停止するだけ（UI からの呼び出し用・コールバックなし） */
  pause() {
    if (this.paused || this.finished) return;
    this.paused = true;
    this.audio.pause();
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    for (let c = 0; c < this.down.length; c++) this.down[c] = false;
    this.pointerCols.clear();
    this.pointerCount.fill(0);
  }

  /** 内部要因（Esc / タブ切り替え）でポーズを要求する */
  _triggerPause() {
    if (this.finished) return;
    if (this.paused) { if (this.onResumeRequest) this.onResumeRequest(); return; }
    this.pause();
    if (this.onPauseRequest) this.onPauseRequest();
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.audio.resume();
    this._fpsT = performance.now();
    if (!this._raf) this._raf = requestAnimationFrame(this._loop);
  }

  /* ---------------- 入力 ---------------- */

  _now() { return this.audio.songTimeMs() - this.settings.offsetMs; }

  _onKeyDown(e) {
    if (e.code === 'Escape') { e.preventDefault(); this._triggerPause(); return; }
    const col = this.keyToCol.get(e.code);
    if (col === undefined) return;
    e.preventDefault();
    if (e.repeat) return;
    this._press(col);
  }

  _onKeyUp(e) {
    const col = this.keyToCol.get(e.code);
    if (col === undefined) return;
    e.preventDefault();
    this._release(col);
  }

  _colFromX(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    const { colW, pfX } = this.renderer.layout;
    const x = clientX - rect.left;
    const c = Math.floor((x - pfX) / colW);
    return Math.max(0, Math.min(this.chart.keys - 1, c));
  }

  _onPointerDown(e) {
    if (this.paused || this.finished) return;
    e.preventDefault();
    const col = this._colFromX(e.clientX);
    this.pointerCols.set(e.pointerId, col);
    this.pointerCount[col]++;
    if (this.pointerCount[col] === 1) this._press(col);
  }

  _onPointerUp(e) {
    const col = this.pointerCols.get(e.pointerId);
    if (col === undefined) return;
    this.pointerCols.delete(e.pointerId);
    this.pointerCount[col] = Math.max(0, this.pointerCount[col] - 1);
    if (this.pointerCount[col] === 0) this._release(col);
  }

  _onVisibility() { if (document.hidden && !this.finished) { this.pause(); if (this.onPauseRequest) this.onPauseRequest(); } }

  _onResize() {
    if (this._resizeRaf) cancelAnimationFrame(this._resizeRaf);
    this._resizeRaf = requestAnimationFrame(() => { this._resizeRaf = 0; this.resize(); });
  }

  _press(col) {
    if (this.paused || this.finished || col == null) return;
    if (this.down[col]) return;
    this.down[col] = true;
    const t = this._now();
    const ev = this.judge.press(col, t);
    if (this.settings.sfxEnabled) this.audio.tap(col);
    this.effects.push({ col, t, judge: ev ? ev.judge : 'empty', part: ev ? ev.part : 'tap', dur: ev ? 250 : 150 });
    if (ev) this._onJudge(ev, t);
  }

  _release(col) {
    if (col == null || !this.down[col]) return;
    this.down[col] = false;
    if (this.paused || this.finished) return;
    const t = this._now();
    const ev = this.judge.release(col, t);
    if (ev) {
      if (this.settings.sfxEnabled && ev.judge !== 'miss') this.audio.tap(col);
      this.effects.push({ col, t, judge: ev.judge, part: 'tail', dur: 220 });
      this._onJudge(ev, t);
    }
  }

  /* ---------------- ループ ---------------- */

  _loop(ts) {
    if (!this.running) return;
    this._raf = requestAnimationFrame(this._loop);
    if (this.paused || this.finished) return;

    this.audio.tick();
    const songMs = this.audio.songTimeMs();
    const t = songMs - this.settings.offsetMs;
    this.f.time = t;
    this.f.curSv = this.chart.hasSV ? this.chart.svTime(t) : t;
    this.f.pxPerMs = this.renderer.pxPerMs(this.settings.scrollSpeed);

    const evs = this.judge.update(t);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (e.judge === 'miss') {
        this.effects.push({ col: e.col, t, judge: 'miss', part: e.part, dur: 300 });
        this._onJudge(e, t);
      }
    }

    this.renderer.draw(this.f);
    this._updateHud(t);

    if (this.settings.showFps) {
      this._frames++;
      if (ts - this._fpsT >= 500) {
        this._fps = Math.round((this._frames * 1000) / (ts - this._fpsT));
        this._frames = 0; this._fpsT = ts;
        if (this.hud.fps) this.hud.fps.textContent = this._fps + ' fps';
      }
    }

    if (this.judge.isFinished && t > this.endTime - 400) {
      this.finished = true;
      this.audio.stop();
      const res = this.getResult();
      setTimeout(() => { this.running = false; if (this.onFinish) this.onFinish(res); }, 620);
    }
  }

  _onJudge(ev) {
    const j = ev.judge;
    if (j === 'miss') {
      if (this.hud.judgeText && this.settings.showJudgeText) this._showJudge('miss');
    } else if (this.hud.judgeText && this.settings.showJudgeText) {
      this._showJudge(j);
    }
  }

  _showJudge(j) {
    const el = this.hud.judgeText;
    if (!el) return;
    if (this._lastHud.judge === j && el.animate) {
      // 連打時にテキスト再設定を省く
    } else {
      el.textContent = JUDGE_LABEL[j] || '';
    }
    this._lastHud.judge = j;
    el.style.color = JUDGE_COLOR[j] || '#fff';
    el.classList.remove('hidden');
    if (el.animate) {
      el.getAnimations().forEach((a) => a.cancel());
      el.animate(
        [
          { opacity: 1, transform: 'translateY(4px) scale(1.18)' },
          { opacity: 1, transform: 'translateY(-2px) scale(1)', offset: 0.35 },
          { opacity: 0, transform: 'translateY(-16px) scale(0.96)' },
        ],
        { duration: 520, easing: 'cubic-bezier(.2,.7,.3,1)' }
      );
    }
  }

  _updateHud(t, force) {
    const j = this.judge;
    const hud = this.hud;
    const score = j.score;
    if (force || score !== this._lastHud.score) {
      this._lastHud.score = score;
      if (hud.score) hud.score.textContent = String(score).padStart(7, '0');
    }
    const acc = j.judged ? j.accuracy : 100;
    const acc2 = Math.round(acc * 100) / 100;
    if (force || acc2 !== this._lastHud.acc) {
      this._lastHud.acc = acc2;
      if (hud.acc) hud.acc.textContent = acc2.toFixed(2) + '%';
    }
    if (force || j.combo !== this._lastHud.combo) {
      const prev = this._lastHud.combo;
      this._lastHud.combo = j.combo;
      if (hud.combo) {
        hud.combo.textContent = j.combo > 0 ? j.combo : '';
        hud.comboWrap.classList.toggle('hidden', j.combo < 2);
        if (j.combo > prev && j.combo >= 2 && hud.comboWrap.animate && this.settings.quality === 'high') {
          hud.comboWrap.getAnimations().forEach((a) => a.cancel());
          hud.comboWrap.animate(
            [{ transform: 'scale(1.14)' }, { transform: 'scale(1)' }],
            { duration: 150, easing: 'ease-out' }
          );
        }
      }
    }
    if (hud.progress) {
      const dur = Math.max(1, this.audio.durationMs || this.chart.durationMs || 1);
      const p = Math.max(0, Math.min(1, t / dur));
      hud.progress.style.transform = `scaleX(${p})`;
      if (hud.time) {
        hud.time.textContent = `${fmtTime(t / 1000)} / ${fmtTime(dur / 1000)}`;
      }
      if (this.settings.showFps && hud.fps) hud.fps.textContent = this._fps + ' fps';
    }
    // カウントダウン
    if (hud.countdown) {
      if (t < 0) {
        const n = Math.ceil(-t / 1000);
        const label = String(Math.min(9, Math.max(1, n)));
        if (hud.countdown.textContent !== label) {
          hud.countdown.textContent = label;
          if (hud.countdown.animate) {
            hud.countdown.getAnimations().forEach((a) => a.cancel());
            hud.countdown.animate(
              [{ opacity: 0.15, transform: 'scale(1.5)' }, { opacity: 0.9, transform: 'scale(1)' }, { opacity: 0.25, transform: 'scale(0.94)' }],
              { duration: 1000, easing: 'ease-out' }
            );
          }
        }
        hud.countdown.classList.remove('hidden');
      } else if (!hud.countdown.classList.contains('hidden')) {
        hud.countdown.classList.add('hidden');
        hud.countdown.textContent = '';
      }
    }
  }

  getResult() {
    const j = this.judge;
    const acc = j.accuracy;
    return {
      score: j.score,
      accuracy: acc,
      maxCombo: j.maxCombo,
      counts: { ...j.counts },
      total: j.total,
      avgError: j.averageError,
      early: j.early,
      late: j.late,
      rank: rankFor(acc, j.counts),
      fullCombo: j.counts.miss === 0 && j.total > 0,
      rate: this.rate,
      mirror: this.mirror,
      diffLabel: this.diffLabel,
      fps: this._fps,
    };
  }
}

function fmtTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
