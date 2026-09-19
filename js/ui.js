/**
 * ui.js — 画面遷移 / 曲選択 / 設定 / 結果表示。
 */
import { parseOsu } from './osu.js';
import { Game } from './game.js';
import { AudioEngine } from './audio.js';
import { WINDOWS, JUDGE_ORDER, JUDGE_LABEL } from './judge.js';
import {
  loadSettings, saveSettings, DEFAULT_SETTINGS, DEFAULT_BINDS,
  RATE_MIN, RATE_MAX, RATE_STEP, round1, saveScore, getScore,
} from './settings.js';

const $ = (id) => document.getElementById(id);
const enc = (s) => String(s).split('/').map(encodeURIComponent).join('/');
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const num = (n) => Math.round(n).toLocaleString('en-US');

function fmtLen(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function keyLabel(code) {
  if (!code) return '—';
  if (code === 'Space') return 'SPACE';
  let m = /^Key([A-Z])$/.exec(code); if (m) return m[1];
  m = /^Digit(\d)$/.exec(code); if (m) return m[1];
  m = /^Arrow(.+)$/.exec(code);
  if (m) return ({ Left: '←', Right: '→', Up: '↑', Down: '↓' })[m[1]] || code;
  return code.replace(/^Numpad/, 'NUM');
}

export class App {
  constructor() {
    this.settings = loadSettings();
    this.audio = new AudioEngine(this.settings);
    this.songs = [];
    this.songIndex = 0;
    this.diffIndex = 0;
    this.chartCache = new Map();
    this.game = null;
    this.current = '';
    this.lastResult = null;
    this.playing = null;      // { song, diff }
    this.settingsReturn = null;
    this._toastTimer = 0;
    this._rebind = null;
  }

  async boot() {
    this.cacheDom();
    this.applyQuality();
    this.bindGlobalEvents();
    this.buildSettingsUI();
    this.syncSettingsUI();
    this.show('title');
    try {
      const res = await fetch('songs/songs.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      this.songs = Array.isArray(data.songs) ? data.songs : [];
    } catch (e) {
      console.error(e);
      this.toast('songs/songs.json を読み込めません（npm run songs で生成）');
    }
    if (!this.songs.length) {
      $('title-meta').textContent = '楽曲が見つかりません。songs/ に譜面を入れて npm run songs を実行してください。';
    } else {
      const total = this.songs.reduce((s, x) => s + x.difficulties.length, 0);
      $('title-meta').textContent = `${this.songs.length} 曲 / ${total} 難易度 · osu!mania 譜面対応 · スコア上限 1,000,000`;
      this.renderSongList();
      this.selectSong(0);
    }
    // 最初の操作で AudioContext を解放（iOS 対策）
    const unlock = () => { this.audio.unlock(); window.removeEventListener('pointerdown', unlock); window.removeEventListener('keydown', unlock); };
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });
  }

  cacheDom() {
    this.dom = {
      screens: {
        title: $('screen-title'), select: $('screen-select'),
        game: $('screen-game'), result: $('screen-result'),
      },
      hud: {
        score: $('hud-score'), acc: $('hud-acc'), combo: $('hud-combo'), comboWrap: $('hud-combo-wrap'),
        judgeText: $('hud-judge'), countdown: $('hud-countdown'), progress: $('hud-progress'),
        time: $('hud-time'), fps: $('hud-fps'), diff: $('hud-diff'), rate: $('hud-rate'),
      },
    };
  }

  /* ---------------- 画面切替 ---------------- */
  show(name) {
    this.current = name;
    for (const k of Object.keys(this.dom.screens)) {
      const el = this.dom.screens[k];
      if (!el) continue;
      const on = k === name;
      el.classList.toggle('active', on);
      if (on) { el.style.opacity = '0'; requestAnimationFrame(() => { el.style.opacity = '1'; }); }
    }
    if (name !== 'game') { $('pause-overlay').classList.add('hidden'); }
  }

  toast(msg, ms = 2600) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  applyQuality() {
    document.documentElement.classList.toggle('low', this.settings.quality === 'low');
    $('hud-fps').classList.toggle('hidden', !this.settings.showFps);
  }

  persist() { saveSettings(this.settings); }

  /* ---------------- 曲選択 ---------------- */
  currentSong() { return this.songs[this.songIndex] || null; }
  currentDiff() { const s = this.currentSong(); return s ? s.difficulties[this.diffIndex] || s.difficulties[0] : null; }
  songPath(song, file) { return `songs/${enc(song.folder)}/${enc(file)}`; }
  scoreId(song, diff) { return `${song.id || song.folder}/${diff.file}`; }

  renderSongList() {
    const box = $('song-list');
    box.textContent = '';
    const frag = document.createDocumentFragment();
    this.songs.forEach((song, i) => {
      const b = document.createElement('button');
      b.className = 'song-item' + (i === this.songIndex ? ' active' : '');
      b.type = 'button';
      const img = document.createElement('img');
      img.className = 'si-thumb';
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      if (song.thumbnailSmall) img.src = this.songPath(song, song.thumbnailSmall);
      const t = document.createElement('div');
      t.className = 'si-text';
      const title = document.createElement('div');
      title.className = 'si-title';
      title.textContent = song.titleUnicode || song.title;
      const artist = document.createElement('div');
      artist.className = 'si-artist';
      artist.textContent = song.artistUnicode || song.artist || 'Unknown Artist';
      t.append(title, artist);
      if (song.audioOk === false) {
        const badge = document.createElement('div');
        badge.className = 'si-badge';
        badge.textContent = '音源なし · 無音でプレイ可';
        t.append(badge);
      }
      b.append(img, t);
      b.addEventListener('click', () => { this.audio.ui('tap'); this.selectSong(i); });
      frag.append(b);
    });
    box.append(frag);
  }

  selectSong(i) {
    if (!this.songs.length) return;
    this.songIndex = clamp(i, 0, this.songs.length - 1);
    this.diffIndex = 0;
    const song = this.currentSong();
    [...$('song-list').children].forEach((el, idx) => el.classList.toggle('active', idx === this.songIndex));
    $('song-title').textContent = song.titleUnicode || song.title;
    $('song-artist').textContent = song.artistUnicode || song.artist || 'Unknown Artist';
    const cover = $('song-cover');
    if (song.thumbnail) { cover.src = this.songPath(song, song.thumbnail); cover.classList.remove('hidden'); }
    else cover.classList.add('hidden');
    $('song-bg').style.backgroundImage = song.background ? `url("${this.songPath(song, song.background)}")` : 'none';
    $('song-extra').innerHTML =
      `BPM ${song.difficulties.map((d) => d.bpm).filter(Boolean)[0] || '—'} · ` +
      `Mapper ${song.creator || 'Unknown'} · ${song.difficulties.length} 難易度`;
    this.renderDiffs();
    this.updateSelectNote();
  }

  renderDiffs() {
    const song = this.currentSong();
    const box = $('diff-list');
    box.textContent = '';
    if (!song) return;
    const frag = document.createDocumentFragment();
    song.difficulties.forEach((d, i) => {
      const b = document.createElement('button');
      b.className = 'diff-item' + (i === this.diffIndex ? ' active' : '');
      b.type = 'button';
      const name = document.createElement('div');
      name.className = 'di-name';
      name.textContent = d.name;
      const stars = document.createElement('div');
      const sv = Number(d.stars) || 0;
      stars.className = 'di-stars ' + (sv >= 10 ? 's5' : sv >= 7 ? 's4' : sv >= 4 ? 's3' : sv >= 2 ? 's2' : 's1');
      stars.textContent = `★ ${sv.toFixed(1)}`;
      const meta = document.createElement('div');
      meta.className = 'di-meta';
      meta.textContent = `${d.keys || 4}K · ${num(d.objects || 0)} notes` +
        (d.ln ? ` (LN ${d.ln})` : '') + ` · ${(d.nps || 0).toFixed(2)} NPS · ${fmtLen(d.lengthMs || 0)}`;
      const best = document.createElement('div');
      best.className = 'di-best';
      const sc = getScore(this.scoreId(song, d));
      best.textContent = sc ? `BEST ${num(sc.score)} · ${sc.accuracy.toFixed(2)}%` : '未プレイ';
      b.append(name, stars, meta, best);
      b.addEventListener('click', () => { this.audio.ui('tap'); this.diffIndex = i; this.renderDiffs(); this.updateSelectNote(); });
      frag.append(b);
    });
    box.append(frag);
  }

  updateSelectNote() {
    const song = this.currentSong();
    const d = this.currentDiff();
    const el = $('select-note');
    if (!song || !d) { el.textContent = ''; return; }
    const binds = this.settings.binds[String(d.keys || 4)] || DEFAULT_BINDS[4];
    const keys = binds.map(keyLabel).join(' / ');
    const parts = [`キー: <b>${keys}</b>`];
    if (song.audioOk === false) parts.push('<b>音源ファイルが空</b>のため無音モードで動作します（譜面・判定はそのまま）');
    if (this.settings.rate !== 1) parts.push(`演奏速度 <b>${this.settings.rate.toFixed(1)}x</b>`);
    if (this.settings.mirror) parts.push('ミラー ON');
    el.innerHTML = parts.join(' ｜ ');
  }

  /* ---------------- 演奏 ---------------- */
  setLoading(on, text) {
    $('loading-overlay').classList.toggle('hidden', !on);
    if (text) $('loading-text').textContent = text;
  }

  async startPlay() {
    const song = this.currentSong();
    const diff = this.currentDiff();
    if (!song || !diff) { this.toast('楽曲がありません'); return; }
    this.playing = { song, diff };
    this.show('game');
    this.setLoading(true, '譜面を読み込み中…');
    this.audio.unlock();

    let chart;
    try {
      chart = await this.loadChart(song, diff);
    } catch (e) {
      console.error(e);
      this.setLoading(false);
      this.toast('譜面の読み込みに失敗しました');
      this.show('select');
      return;
    }
    if (chart.general.Mode !== undefined && chart.general.Mode !== 3 && chart.general.Mode !== 0) {
      this.toast('この譜面は osu!mania (Mode 3) ではありません');
    }

    this.setLoading(true, '音源を読み込み中…');
    const audioUrl = song.audio ? this.songPath(song, song.audio) : '';
    const loaded = await this.audio.load(audioUrl);
    $('hud-silent').classList.toggle('hidden', loaded.ok);
    if (!loaded.ok) {
      this.toast('音源を再生できないため無音モードで開始します', 3000);
    }

    $('hud-diff').textContent = `${song.title} · ${diff.name} ★${Number(diff.stars).toFixed(1)}`;
    $('hud-rate').textContent = this.settings.rate.toFixed(1) + 'x';

    this.setLoading(false);
    if (this.game) { this.game.destroy(); this.game = null; }
    this.game = new Game({
      canvas: $('playfield'),
      hud: this.dom.hud,
      chart,
      audio: this.audio,
      settings: this.settings,
      rate: this.settings.rate,
      diffLabel: `${diff.name} ★${Number(diff.stars).toFixed(1)}`,
      onFinish: (res) => this.finishPlay(res),
      onPauseRequest: () => this.openPause(),
      onResumeRequest: () => this.resumeGame(),
    });
    this.audio.ui('start');
    requestAnimationFrame(() => this.game.resize());
    this.game.start();
  }

  async loadChart(song, diff) {
    const url = this.songPath(song, diff.file);
    if (this.chartCache.has(url)) return this.chartCache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + url);
    const chart = parseOsu(await res.text());
    if (!chart.notes.length) throw new Error('ノーツがありません');
    this.chartCache.set(url, chart);
    return chart;
  }

  openPause() {
    if (!this.game || this.game.finished) return;
    this.game.pause();
    const j = this.game.judge;
    $('pause-info').innerHTML =
      `SCORE <b>${num(j.score)}</b> ／ ACC <b>${j.accuracy.toFixed(2)}%</b> ／ COMBO <b>${j.maxCombo}</b><br>` +
      `${this.playing ? this.playing.song.title : ''} · ${this.game.diffLabel} · ${this.settings.rate.toFixed(1)}x`;
    $('pause-overlay').classList.remove('hidden');
  }

  resumeGame() {
    $('pause-overlay').classList.add('hidden');
    if (this.game) this.game.resume();
  }

  retryGame() {
    $('pause-overlay').classList.add('hidden');
    if (this.game) this.game.retry();
  }

  quitGame() {
    $('pause-overlay').classList.add('hidden');
    if (this.game) { this.game.destroy(); this.game = null; }
    this.audio.stop();
    this.show('select');
    this.renderDiffs();
  }

  finishPlay(res) {
    this.lastResult = res;
    const { song, diff } = this.playing || {};
    if (this.game) { this.game.destroy(); this.game = null; }
    if (!song || !diff) { this.show('select'); return; }

    const id = this.scoreId(song, diff);
    const { isNew } = saveScore(id, {
      score: res.score, accuracy: res.accuracy, maxCombo: res.maxCombo,
      rank: res.rank, counts: res.counts, rate: res.rate, at: Date.now(),
    });

    $('res-title').textContent = song.titleUnicode || song.title;
    $('res-sub').textContent = `${diff.name} ★${Number(diff.stars).toFixed(1)} · ${res.rate.toFixed(1)}x` +
      (res.mirror ? ' · MIRROR' : '');
    const rank = $('res-rank');
    rank.textContent = res.rank;
    rank.className = 'result-rank r-' + res.rank;
    $('res-score').textContent = String(res.score).padStart(7, '0');
    $('res-acc').textContent = res.accuracy.toFixed(2) + '%';
    $('res-combo').textContent = `MAX COMBO ${res.maxCombo}` + (res.fullCombo ? ' · FULL COMBO' : '');
    $('res-badge').classList.toggle('hidden', !isNew);

    const box = $('res-counts');
    box.textContent = '';
    const maxCount = Math.max(1, ...JUDGE_ORDER.map((k) => res.counts[k] || 0));
    for (const k of JUDGE_ORDER) {
      const c = res.counts[k] || 0;
      const row = document.createElement('div');
      row.className = 'jc-row jc-' + k;
      const pct = Math.round((c / maxCount) * 100);
      row.innerHTML =
        `<div class="jc-label">${JUDGE_LABEL[k]}</div>` +
        `<div class="jc-bar"><i style="width:${pct}%"></i></div>` +
        `<div class="jc-num">${num(c)}</div>`;
      box.append(row);
    }

    const avg = res.avgError;
    $('res-error').innerHTML =
      `平均誤差 <b>${avg >= 0 ? '+' : ''}${avg.toFixed(1)} ms</b>（早 ${res.early} / 遅 ${res.late}） · ` +
      `判定数 <b>${res.total}</b><br>` +
      `判定窓 PERFECT ±${WINDOWS.perfect}ms / GREAT ±${WINDOWS.great}ms / GOOD ±${WINDOWS.good}ms / MEH ±${WINDOWS.meh}ms`;
    this.renderDiffs();
    this.show('result');
  }

  /* ---------------- 設定 ---------------- */
  buildSettingsUI() {
    // スライダー / トグル / セグメント
    const bindRange = (id, valId, get, set, fmt) => {
      const el = $(id), out = $(valId);
      el.addEventListener('input', () => {
        const v = parseFloat(el.value);
        set(v);
        out.textContent = fmt(v);
        this.persist();
        this.onSettingChanged(id);
      });
      this._rangeSync = this._rangeSync || [];
      this._rangeSync.push(() => { el.value = String(get()); out.textContent = fmt(get()); });
    };

    bindRange('set-scroll', 'set-scroll-val', () => this.settings.scrollSpeed,
      (v) => { this.settings.scrollSpeed = v; }, (v) => v.toFixed(1));
    bindRange('set-offset', 'set-offset-val', () => this.settings.offsetMs,
      (v) => { this.settings.offsetMs = Math.round(v); }, (v) => `${Math.round(v)} ms`);
    bindRange('set-rate', 'set-rate-val', () => this.settings.rate,
      (v) => { this.settings.rate = round1(clamp(v, RATE_MIN, RATE_MAX)); }, (v) => v.toFixed(1) + 'x');
    bindRange('set-master', 'set-master-val', () => this.settings.masterVolume,
      (v) => { this.settings.masterVolume = v; this.audio.applyVolumes(); }, (v) => Math.round(v * 100) + '%');
    bindRange('set-music', 'set-music-val', () => this.settings.musicVolume,
      (v) => { this.settings.musicVolume = v; this.audio.applyVolumes(); }, (v) => Math.round(v * 100) + '%');
    bindRange('set-sfxvol', 'set-sfxvol-val', () => this.settings.sfxVolume,
      (v) => { this.settings.sfxVolume = v; this.audio.applyVolumes(); }, (v) => Math.round(v * 100) + '%');

    const bindToggle = (id, get, set) => {
      const el = $(id);
      el.addEventListener('click', () => {
        set(!get());
        el.setAttribute('aria-checked', get() ? 'true' : 'false');
        this.persist();
        this.onSettingChanged(id);
        this.audio.ui('tap');
      });
      this._toggleSync = this._toggleSync || [];
      this._toggleSync.push(() => el.setAttribute('aria-checked', get() ? 'true' : 'false'));
    };
    bindToggle('set-mirror', () => this.settings.mirror, (v) => { this.settings.mirror = v; });
    bindToggle('set-sfx', () => this.settings.sfxEnabled, (v) => { this.settings.sfxEnabled = v; this.audio.applyVolumes(); });
    bindToggle('set-judgetext', () => this.settings.showJudgeText, (v) => { this.settings.showJudgeText = v; });
    bindToggle('set-fps', () => this.settings.showFps, (v) => { this.settings.showFps = v; this.applyQuality(); });

    const bindSeg = (id, get, set) => {
      const box = $(id);
      box.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        set(btn.dataset.v);
        [...box.children].forEach((b) => b.classList.toggle('on', b === btn));
        this.persist();
        this.onSettingChanged(id);
        this.audio.ui('tap');
      });
      this._segSync = this._segSync || [];
      this._segSync.push(() => [...box.children].forEach((b) => b.classList.toggle('on', b.dataset.v === get())));
    };
    bindSeg('set-quality', () => this.settings.quality, (v) => { this.settings.quality = v; this.applyQuality(); });
    bindSeg('set-sfx-type', () => this.settings.sfxType, (v) => { this.settings.sfxType = v; });

    $('btn-sfx-test').addEventListener('click', () => { this.audio.unlock(); this.audio.tap(0); setTimeout(() => this.audio.tap(1), 110); });

    // 判定窓の表示
    const w = $('set-windows');
    w.textContent = '';
    for (const k of ['perfect', 'great', 'good', 'meh']) {
      const c = document.createElement('span');
      c.className = 'window-chip';
      c.textContent = `${JUDGE_LABEL[k]} ±${WINDOWS[k]}ms`;
      c.style.color = { perfect: 'var(--gold)', great: 'var(--green)', good: 'var(--blue)', meh: 'var(--violet)' }[k];
      w.append(c);
    }
    const missChip = document.createElement('span');
    missChip.className = 'window-chip';
    missChip.textContent = `MISS ±${WINDOWS.meh}ms 以上`;
    missChip.style.color = 'var(--red)';
    w.append(missChip);

    this.buildKeybinds();
  }

  keyCount() {
    const d = this.currentDiff();
    return (d && d.keys) || 4;
  }

  buildKeybinds() {
    const box = $('keybinds');
    const keys = this.keyCount();
    $('keybind-hint').textContent = `${keys}K`;
    box.textContent = '';
    const list = this.settings.binds[String(keys)] || DEFAULT_BINDS[String(keys)] || DEFAULT_BINDS[4];
    for (let i = 0; i < keys; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'keybind-btn';
      b.innerHTML = `<small>LANE ${i + 1}</small>${keyLabel(list[i])}`;
      b.addEventListener('click', () => this.startRebind(i, b, keys));
      box.append(b);
    }
  }

  startRebind(index, btn, keys) {
    if (this._rebind) this._rebind.cancel();
    btn.classList.add('listening');
    btn.querySelector('small').textContent = 'キーを入力';
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      if (e.code === 'Escape') { done(false); return; }
      const list = this.settings.binds[String(keys)] || (this.settings.binds[String(keys)] = DEFAULT_BINDS[String(keys)].slice());
      // 同じキーの重複を解除
      const at = list.indexOf(e.code);
      if (at >= 0 && at !== index) list[at] = '';
      list[index] = e.code;
      this.persist();
      done(true);
    };
    const done = (ok) => {
      window.removeEventListener('keydown', onKey, true);
      btn.classList.remove('listening');
      this.buildKeybinds();
      this.updateSelectNote();
      if (this.game) this.game.applyBinds();
      if (ok) this.toast('キーを設定しました');
      this._rebind = null;
    };
    window.addEventListener('keydown', onKey, true);
    this._rebind = { cancel: () => done(false) };
  }

  syncSettingsUI() {
    (this._rangeSync || []).forEach((f) => f());
    (this._toggleSync || []).forEach((f) => f());
    (this._segSync || []).forEach((f) => f());
    this.buildKeybinds();
    this.syncSelectControls();
  }

  syncSelectControls() {
    $('rate-slider').value = String(this.settings.rate);
    $('rate-value').textContent = this.settings.rate.toFixed(1) + 'x';
    $('scroll-slider').value = String(this.settings.scrollSpeed);
    $('scroll-value').textContent = Number(this.settings.scrollSpeed).toFixed(1);
  }

  onSettingChanged(id) {
    if (id === 'set-quality' && this.game) this.game.renderer.setQuality(this.settings.quality);
    if (id === 'set-mirror') this.updateSelectNote();
    if (id === 'set-rate' || id === 'set-scroll') this.syncSelectControls();
    if (id === 'set-rate') this.updateSelectNote();
  }

  openSettings() {
    this.syncSettingsUI();
    $('settings-modal').classList.remove('hidden');
  }
  closeSettings() {
    $('settings-modal').classList.add('hidden');
  }

  /* ---------------- グローバルイベント ---------------- */
  bindGlobalEvents() {
    $('btn-to-select').addEventListener('click', () => { this.audio.ui('tap'); this.show('select'); });
    $('btn-title-settings').addEventListener('click', () => { this.audio.ui('tap'); this.openSettings(); });
    $('btn-select-back').addEventListener('click', () => { this.audio.ui('tap'); this.show('title'); });
    $('btn-select-settings').addEventListener('click', () => { this.audio.ui('tap'); this.openSettings(); });
    $('btn-settings-close').addEventListener('click', () => { this.audio.ui('tap'); this.closeSettings(); });
    $('settings-modal').addEventListener('click', (e) => { if (e.target === $('settings-modal')) this.closeSettings(); });

    $('btn-start').addEventListener('click', () => this.startPlay());

    // 曲選択画面の速度 / スクロール
    const setRate = (v) => {
      this.settings.rate = round1(clamp(v, RATE_MIN, RATE_MAX));
      this.persist(); this.syncSettingsUI(); this.updateSelectNote();
    };
    $('rate-up').addEventListener('click', () => { this.audio.ui('tap'); setRate(this.settings.rate + RATE_STEP); });
    $('rate-down').addEventListener('click', () => { this.audio.ui('tap'); setRate(this.settings.rate - RATE_STEP); });
    $('rate-slider').addEventListener('input', (e) => setRate(parseFloat(e.target.value)));
    const setScroll = (v) => {
      this.settings.scrollSpeed = clamp(Math.round(v * 2) / 2, 1, 30);
      this.persist(); this.syncSettingsUI();
      if (this.game) this.game.f.pxPerMs = this.game.renderer.pxPerMs(this.settings.scrollSpeed);
    };
    $('scroll-up').addEventListener('click', () => { this.audio.ui('tap'); setScroll(this.settings.scrollSpeed + 0.5); });
    $('scroll-down').addEventListener('click', () => { this.audio.ui('tap'); setScroll(this.settings.scrollSpeed - 0.5); });
    $('scroll-slider').addEventListener('input', (e) => setScroll(parseFloat(e.target.value)));

    // プレイ画面
    $('btn-pause').addEventListener('click', () => this.openPause());
    $('btn-resume').addEventListener('click', () => { this.audio.ui('tap'); this.resumeGame(); });
    $('btn-retry').addEventListener('click', () => { this.audio.ui('tap'); this.retryGame(); });
    $('btn-pause-settings').addEventListener('click', () => { this.audio.ui('tap'); this.openSettings(); });
    $('btn-quit').addEventListener('click', () => { this.audio.ui('tap'); this.quitGame(); });

    // 結果画面
    $('btn-res-retry').addEventListener('click', () => { this.audio.ui('tap'); this.startPlay(); });
    $('btn-res-back').addEventListener('click', () => { this.audio.ui('tap'); this.show('select'); });
    $('btn-res-autooffset').addEventListener('click', () => {
      const res = this.lastResult;
      if (!res || !res.avgError) { this.toast('補正するデータがありません'); return; }
      const next = clamp(Math.round(this.settings.offsetMs + res.avgError), -300, 300);
      this.settings.offsetMs = next;
      this.persist(); this.syncSettingsUI();
      this.toast(`オフセットを ${next} ms に補正しました`);
    });

    $('btn-reset-settings').addEventListener('click', () => {
      Object.assign(this.settings, JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
      this.persist();
      this.audio.applyVolumes();
      this.applyQuality();
      this.syncSettingsUI();
      this.updateSelectNote();
      if (this.game) { this.game.settings = this.settings; this.game.applyBinds(); this.game.renderer.setQuality(this.settings.quality); }
      this.toast('設定を初期化しました');
    });

    // グローバルキー
    window.addEventListener('keydown', (e) => {
      if (this._rebind) return;
      if (!$('settings-modal').classList.contains('hidden')) {
        if (e.code === 'Escape') this.closeSettings();
        return;
      }
      if (this.current === 'title' && (e.code === 'Enter' || e.code === 'Space')) { e.preventDefault(); this.show('select'); }
      else if (this.current === 'select') {
        if (e.code === 'Enter' || e.code === 'Space') { e.preventDefault(); this.startPlay(); }
        else if (e.code === 'Escape') this.show('title');
        else if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
          e.preventDefault();
          const len = (this.currentSong()?.difficulties.length || 1) - 1;
          this.diffIndex = clamp(this.diffIndex + (e.code === 'ArrowDown' ? 1 : -1), 0, len);
          this.renderDiffs();
          this.updateSelectNote();
        }
        else if (e.code === 'ArrowLeft') { e.preventDefault(); setRate(this.settings.rate - RATE_STEP); }
        else if (e.code === 'ArrowRight') { e.preventDefault(); setRate(this.settings.rate + RATE_STEP); }
      } else if (this.current === 'result') {
        if (e.code === 'KeyR' || e.code === 'Enter') { e.preventDefault(); this.startPlay(); }
        else if (e.code === 'Escape') this.show('select');
      }
    });

    // ページ離脱時に音を止める
    window.addEventListener('pagehide', () => this.audio.stop());
  }
}
