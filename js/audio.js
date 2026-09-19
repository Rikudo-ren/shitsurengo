/**
 * audio.js — 音源クロック + 倍速再生 + タップ音（WebAudio 合成・素材ゼロ）。
 *
 * タイミングは AudioContext.currentTime を基準にした高精度クロックで、
 * <audio>.currentTime と突き合わせて自動補正します（音ズレ防止）。
 * 音源が存在しない/壊れている場合は無音クロックにフォールバックするので、
 * 譜面だけあればそのまま遊べます。
 */

export class AudioEngine {
  constructor(settings) {
    this.s = settings;
    this.ctx = null;
    this.el = null;
    this.mode = 'silent';       // 'audio' | 'silent'
    this.rate = 1;
    this.durationMs = 0;
    this.useAudioClock = false;
    this._t0Song = 0;           // 基準点の楽曲時間(秒)
    this._t0Clock = 0;          // 基準点のクロック(秒)
    this._pausedAt = null;
    this._noiseBuf = null;
    this.lastLoadError = '';
  }

  /** ユーザー操作の中から呼ぶ（iOS の autoplay 制限対策） */
  init() {
    if (this.ctx) return this.ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.musicGain = this.ctx.createGain();
      this.musicGain.connect(this.master);
      this.sfxGain = this.ctx.createGain();
      this.sfxGain.connect(this.master);

      this.el = document.createElement('audio');
      this.el.preload = 'auto';
      this.el.setAttribute('playsinline', '');
      this._srcNode = this.ctx.createMediaElementSource(this.el);
      this._srcNode.connect(this.musicGain);

      const len = Math.floor(this.ctx.sampleRate * 0.05);
      this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this._noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 1.6;

      this.applyVolumes();
    } catch (e) {
      console.warn('[audio] init failed', e);
      this.ctx = null;
    }
    return this.ctx;
  }

  unlock() {
    this.init();
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
  }

  applyVolumes() {
    if (!this.ctx) return;
    const s = this.s;
    this.master.gain.value = s.masterVolume;
    this.musicGain.gain.value = s.musicVolume;
    this.sfxGain.gain.value = s.sfxEnabled ? s.sfxVolume : 0;
  }

  /**
   * 音源を読み込む。失敗しても例外を投げず silent モードで続行可能。
   * @returns {Promise<{ok:boolean, reason?:string, duration?:number}>}
   */
  load(url) {
    this.init();
    this.stop();
    this.mode = 'silent';
    this.durationMs = 0;
    this.lastLoadError = '';
    if (!this.ctx || !this.el) { this.lastLoadError = 'Web Audio 非対応'; return Promise.resolve({ ok: false, reason: 'no-webaudio' }); }
    if (!url) { this.lastLoadError = '音源未設定'; return Promise.resolve({ ok: false, reason: 'no-url' }); }

    const el = this.el;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        el.removeEventListener('error', onErr);
        el.removeEventListener('loadedmetadata', onMeta);
        el.removeEventListener('canplay', onMeta);
        if (!r.ok) {
          this.mode = 'silent';
          this.lastLoadError = r.reason === 'timeout' ? '音源の読み込みが遅延' : '音源を再生できません';
          try { el.pause(); el.removeAttribute('src'); el.load(); } catch { /* ignore */ }
        }
        resolve(r);
      };
      const onErr = () => finish({ ok: false, reason: 'error' });
      const onMeta = () => {
        const d = el.duration;
        if (Number.isFinite(d) && d > 0.5) {
          this.mode = 'audio';
          this.durationMs = d * 1000;
          finish({ ok: true, duration: d });
        } else finish({ ok: false, reason: 'bad-duration' });
      };
      const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), 7000);
      el.addEventListener('error', onErr);
      el.addEventListener('loadedmetadata', onMeta);
      el.addEventListener('canplay', onMeta);
      el.src = url;
      el.load();
    });
  }

  _clock() {
    return this.useAudioClock && this.ctx ? this.ctx.currentTime : performance.now() / 1000;
  }

  /** 演奏開始（楽曲時間 -leadInMs からカウント開始） */
  start(leadInMs, rate, fallbackDurationMs) {
    this.init();
    this.rate = rate || 1;
    this._pausedAt = null;
    this.useAudioClock = false;
    this._t0Song = -leadInMs / 1000;
    this._t0Clock = this._clock();
    this.fallbackDurationMs = fallbackDurationMs || 0;
    if (this.mode === 'audio' && this.el) {
      const el = this.el;
      el.playbackRate = this.rate;
      try { el.preservesPitch = true; } catch { /* ignore */ }
      try { el.mozPreservesPitch = true; } catch { /* ignore */ }
      try { el.webkitPreservesPitch = true; } catch { /* ignore */ }
      el.currentTime = 0;
      el.pause();
      el.addEventListener('playing', this._onPlaying = () => {
        this._t0Song = el.currentTime;
        this._t0Clock = this.ctx.currentTime;
        this.useAudioClock = true;
      }, { once: true });
    } else {
      this.mode = 'silent';
    }
  }

  /** 毎フレーム呼ぶ。リードイン終了時に実際の再生を始める */
  tick() {
    if (this.mode !== 'audio' || this.useAudioClock) return;
    const t = this.songTimeMs();
    if (t >= 0) {
      const el = this.el;
      el.playbackRate = this.rate;
      const p = el.play();
      if (p && p.catch) p.catch(() => { this.mode = 'silent'; this.lastLoadError = '再生開始に失敗'; });
      // 'playing' が来るまでは概算クロックで進める
      this.useAudioClock = false;
      this._t0Song = 0;
      this._t0Clock = this.ctx.currentTime;
      this._pendingAudio = true;
    }
  }

  /** 現在の楽曲時間(ms)。倍速を考慮した実時間進行。 */
  songTimeMs() {
    const r = this.rate;
    let est = this._t0Song + (this._clock() - this._t0Clock) * r;
    if (this.useAudioClock && this.el && !this._pausedAt) {
      const actual = this.el.currentTime;
      const err = actual - est;
      if (Math.abs(err) > 0.04) { this._t0Song = actual; this._t0Clock = this.ctx.currentTime; est = actual; }
      else if (Math.abs(err) > 0.003) { this._t0Song += err * 0.1; est = this._t0Song + (this._clock() - this._t0Clock) * r; }
    }
    return est * 1000;
  }

  pause() {
    if (this._pausedAt !== null) return;
    this._pausedAt = this.songTimeMs();
    if (this.mode === 'audio' && this.el) { try { this.el.pause(); } catch { /* ignore */ } }
  }

  resume() {
    if (this._pausedAt === null) return;
    const at = this._pausedAt;
    this._pausedAt = null;
    if (this.mode === 'audio' && this.el && at >= 0) {
      try { this.el.currentTime = Math.max(0, at / 1000); } catch { /* ignore */ }
      this._t0Song = at / 1000;
      this._t0Clock = this.ctx.currentTime;
      this.useAudioClock = true;
      const p = this.el.play();
      if (p && p.catch) p.catch(() => {});
    } else {
      this.useAudioClock = false;
      this._t0Song = at / 1000;
      this._t0Clock = this._clock();
    }
  }

  stop() {
    this._pausedAt = null;
    this.useAudioClock = false;
    if (this.el) {
      try { this.el.pause(); } catch { /* ignore */ }
      if (this._onPlaying) { this.el.removeEventListener('playing', this._onPlaying); this._onPlaying = null; }
    }
  }

  /** タップ効果音（素材不要の WebAudio 合成） */
  tap(col = 0, kind) {
    if (!this.ctx || !this.s.sfxEnabled) return;
    if (this.ctx.state === 'suspended') return;
    const now = this.ctx.currentTime;
    const type = kind || this.s.sfxType || 'click';
    const strength = col % 2 === 0 ? 1 : 0.92;
    if (type === 'pop') {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      const f = 480 + ((col * 90) % 420);
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(f * 1.7, now);
      osc.frequency.exponentialRampToValueAtTime(f * 0.75, now + 0.07);
      g.gain.setValueAtTime(0.0001, now);
      g.gain.exponentialRampToValueAtTime(0.55 * strength, now + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
      osc.connect(g); g.connect(this.sfxGain);
      osc.start(now); osc.stop(now + 0.11);
      return;
    }
    // click: ノイズバースト + 高域クリック
    if (this._noiseBuf) {
      const s = this.ctx.createBufferSource();
      s.buffer = this._noiseBuf;
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1500 + col * 200;
      bp.Q.value = 0.9;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.5 * strength, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.045);
      s.connect(bp); bp.connect(g); g.connect(this.sfxGain);
      s.start(now); s.stop(now + 0.05);
    }
    const osc = this.ctx.createOscillator();
    const g2 = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(2100 + col * 70, now);
    g2.gain.setValueAtTime(0.12 * strength, now);
    g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.02);
    osc.connect(g2); g2.connect(this.sfxGain);
    osc.start(now); osc.stop(now + 0.03);
  }

  /** UI 操作音 */
  ui(kind = 'tap') {
    if (!this.ctx || !this.s.sfxEnabled) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(kind === 'start' ? 880 : 620, now);
    if (kind === 'start') osc.frequency.exponentialRampToValueAtTime(1320, now + 0.09);
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(0.18, now + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
    osc.connect(g); g.connect(this.sfxGain);
    osc.start(now); osc.stop(now + 0.13);
  }
}
