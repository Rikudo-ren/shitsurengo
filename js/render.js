/**
 * render.js — Canvas 2D レンダラ（依存ゼロ・描画は可視ノーツのみ）。
 * グラデーションやグローは offscreen に焼き込んで drawImage するだけなので、
 * モバイルでも 60fps を維持しやすい超軽量実装です。
 */

const BASE = ['#22d3ee', '#f472b6', '#a78bfa', '#fbbf24', '#34d399', '#60a5fa'];
const MISS_COLOR = '#5b6478';

export function palette(keys) {
  const out = [];
  const half = Math.ceil(keys / 2);
  for (let i = 0; i < keys; i++) {
    const j = i < half ? i : keys - 1 - i;
    out.push(BASE[j % BASE.length]);
  }
  return out;
}

function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}
const rgba = (hex, a) => { const [r, g, b] = hexToRgb(hex); return `rgba(${r},${g},${b},${a})`; };
const mix = (hex, target, t) => {
  const [r, g, b] = hexToRgb(hex);
  const [r2, g2, b2] = hexToRgb(target);
  const c = (x, y) => Math.round(x + (y - x) * t);
  return `rgb(${c(r, r2)},${c(g, g2)},${c(b, b2)})`;
};

function roundRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.quality = 'high';
    this.w = 0; this.h = 0; this.dpr = 1;
    this.keys = 4;
    this.colors = palette(4);
    this.sprites = {};
    this.bg = null;
    this.layout = { colW: 80, pfX: 0, pfW: 320, hitY: 400, noteH: 18 };
    this._cssW = 0; this._cssH = 0;
  }

  setQuality(q) {
    this.quality = q === 'low' ? 'low' : 'high';
    if (this._cssW) this.resize(this._cssW, this._cssH, this.keys);
  }

  resize(cssW, cssH, keys) {
    if (keys && keys !== this.keys) { this.keys = keys; this.colors = palette(keys); }
    if (!cssW || !cssH) return;
    this._cssW = cssW; this._cssH = cssH;
    this.w = cssW; this.h = cssH;
    const cap = this.quality === 'low' ? 1 : 2;
    this.dpr = Math.min(window.devicePixelRatio || 1, cap);
    const cw = Math.max(1, Math.round(cssW * this.dpr));
    const ch = Math.max(1, Math.round(cssH * this.dpr));
    if (this.canvas.width !== cw || this.canvas.height !== ch) { this.canvas.width = cw; this.canvas.height = ch; }
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';

    const k = this.keys;
    const colW = Math.min(128, Math.max(46, Math.floor((cssW - 10) / k)));
    const pfW = colW * k;
    const pfX = Math.round((cssW - pfW) / 2);
    const hitY = Math.round(cssH - Math.max(78, Math.min(170, cssH * 0.16)));
    const noteH = Math.max(11, Math.min(26, Math.round(colW * 0.2)));
    this.layout = { colW, pfX, pfW, hitY, noteH };

    this._buildBackground(cssW, cssH, pfX, pfW);
    this._buildSprites(colW, noteH);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  /** ノーツが画面最上部→判定線に届くまでの時間(ms) */
  approachMs(scrollSpeed) { return 9000 / Math.max(0.5, scrollSpeed); }
  pxPerMs(scrollSpeed) { return this.layout.hitY / this.approachMs(scrollSpeed); }

  _buildBackground(w, h, pfX, pfW) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * this.dpr));
    c.height = Math.max(1, Math.round(h * this.dpr));
    const g = c.getContext('2d');
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    const bg = g.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, '#070912');
    bg.addColorStop(0.55, '#0a0d1c');
    bg.addColorStop(1, '#05060d');
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);

    if (this.quality === 'high') {
      const r1 = Math.max(w, h) * 0.75;
      const gl1 = g.createRadialGradient(w * 0.16, h * 0.08, 0, w * 0.16, h * 0.08, r1);
      gl1.addColorStop(0, 'rgba(34,211,238,0.13)');
      gl1.addColorStop(1, 'rgba(34,211,238,0)');
      g.fillStyle = gl1; g.fillRect(0, 0, w, h);
      const gl2 = g.createRadialGradient(w * 0.86, h * 0.92, 0, w * 0.86, h * 0.92, r1 * 0.85);
      gl2.addColorStop(0, 'rgba(244,114,182,0.11)');
      gl2.addColorStop(1, 'rgba(244,114,182,0)');
      g.fillStyle = gl2; g.fillRect(0, 0, w, h);
    }

    g.fillStyle = 'rgba(255,255,255,0.022)';
    g.fillRect(pfX, 0, pfW, h);

    const vig = g.createLinearGradient(0, h * 0.5, 0, h);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = vig;
    g.fillRect(0, h * 0.5, w, h * 0.5);
    this.bg = c;
  }

  _buildSprites(colW, noteH) {
    const s = {};
    const gsize = this.quality === 'high' ? 128 : 64;
    s.glow = this.colors.map((col) => {
      const c = document.createElement('canvas');
      c.width = c.height = gsize;
      const g = c.getContext('2d');
      const rg = g.createRadialGradient(gsize / 2, gsize / 2, 0, gsize / 2, gsize / 2, gsize / 2);
      rg.addColorStop(0, rgba(col, 0.9));
      rg.addColorStop(0.35, rgba(col, 0.3));
      rg.addColorStop(1, rgba(col, 0));
      g.fillStyle = rg;
      g.fillRect(0, 0, gsize, gsize);
      return c;
    });
    const gm = document.createElement('canvas');
    gm.width = gm.height = 64;
    const gg = gm.getContext('2d');
    const rgm = gg.createRadialGradient(32, 32, 0, 32, 32, 32);
    rgm.addColorStop(0, rgba(MISS_COLOR, 0.65));
    rgm.addColorStop(1, rgba(MISS_COLOR, 0));
    gg.fillStyle = rgm; gg.fillRect(0, 0, 64, 64);
    s.glowMiss = gm;

    const ctx = this.ctx;
    const mkNote = (col) => {
      const gr = ctx.createLinearGradient(0, 0, 0, noteH);
      gr.addColorStop(0, mix(col, '#ffffff', 0.55));
      gr.addColorStop(0.5, col);
      gr.addColorStop(1, mix(col, '#05060d', 0.35));
      return gr;
    };
    s.note = this.colors.map(mkNote);
    s.noteMiss = mkNote(MISS_COLOR);

    const mkBody = (col, a1, a2) => {
      const gr = ctx.createLinearGradient(0, 0, colW, 0);
      gr.addColorStop(0, rgba(col, a1));
      gr.addColorStop(0.5, rgba(col, a2));
      gr.addColorStop(1, rgba(col, a1));
      return gr;
    };
    s.lnBody = this.colors.map((c) => mkBody(c, 0.45, 0.16));
    s.lnBodyHeld = this.colors.map((c) => mkBody(c, 0.75, 0.34));
    s.lnBodyMiss = mkBody(MISS_COLOR, 0.35, 0.12);

    s.beam = this.colors.map((col) => {
      const gr = ctx.createLinearGradient(0, 0, 0, -noteH * 9);
      gr.addColorStop(0, rgba(col, 0.3));
      gr.addColorStop(1, rgba(col, 0));
      return gr;
    });
    this.sprites = s;
  }

  /** @param {object} f Game が使い回すフレーム状態 */
  draw(f) {
    const ctx = this.ctx;
    const { colW, pfX, pfW, hitY, noteH } = this.layout;
    const w = this.w, h = this.h, keys = this.keys;

    if (this.bg) ctx.drawImage(this.bg, 0, 0, w, h);
    else { ctx.fillStyle = '#05060d'; ctx.fillRect(0, 0, w, h); }

    // レーン区切り
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.beginPath();
    for (let i = 1; i < keys; i++) {
      const x = Math.round(pfX + i * colW) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, h);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.11)';
    ctx.beginPath();
    ctx.moveTo(Math.round(pfX) + 0.5, 0); ctx.lineTo(Math.round(pfX) + 0.5, h);
    ctx.moveTo(Math.round(pfX + pfW) - 0.5, 0); ctx.lineTo(Math.round(pfX + pfW) - 0.5, h);
    ctx.stroke();

    const yOf = (sv) => hitY - (sv - f.curSv) * f.pxPerMs;
    const topCull = -noteH * 4;
    const botCull = h + noteH * 2;

    // 画面外に出た解決済みノーツをスキップ
    for (let c = 0; c < keys; c++) {
      const list = f.cols[c];
      let i = f.renderPtr[c];
      while (i < list.length && list[i].state === 'done' && yOf(list[i].sv) > botCull) i++;
      f.renderPtr[c] = i;
    }

    // ロングノーツ本体
    for (let c = 0; c < keys; c++) {
      const x = pfX + c * colW;
      const list = f.cols[c];
      for (let i = f.renderPtr[c]; i < list.length; i++) {
        const n = list[i];
        if (!n.isLN) continue;
        const yTail = yOf(n.svEnd);
        if (yTail < topCull) break;
        const yHead = n.state === 'holding' ? hitY : yOf(n.sv);
        if (yHead > botCull) continue;
        const missed = n.headJudge === 'miss' || n.dropped;
        if (n.state === 'done' && !missed) continue;
        const top = Math.max(-30, yTail);
        const bh = yHead - top;
        if (bh <= 0.6) continue;
        ctx.save();
        ctx.translate(x, 0);
        ctx.fillStyle = missed ? this.sprites.lnBodyMiss : (n.state === 'holding' ? this.sprites.lnBodyHeld[c] : this.sprites.lnBody[c]);
        ctx.fillRect(3, top, colW - 6, bh);
        if (this.quality === 'high') {
          ctx.fillStyle = missed ? rgba(MISS_COLOR, 0.3) : rgba(this.colors[c], n.state === 'holding' ? 0.6 : 0.3);
          ctx.fillRect(3, top, 2, bh);
          ctx.fillRect(colW - 5, top, 2, bh);
        }
        ctx.restore();
        // テイルキャップ
        if (yTail > topCull && yTail < botCull) {
          ctx.save();
          ctx.translate(x + 3, yTail - noteH * 0.5);
          ctx.globalAlpha = missed ? 0.4 : 1;
          ctx.fillStyle = missed ? this.sprites.noteMiss : this.sprites.note[c];
          roundRectPath(ctx, 0, 0, colW - 6, noteH * 0.6, 4);
          ctx.fill();
          ctx.globalAlpha = 1;
          ctx.restore();
        }
      }
    }

    // 通常ノーツ / LNヘッド
    for (let c = 0; c < keys; c++) {
      const x = pfX + c * colW;
      const list = f.cols[c];
      for (let i = f.renderPtr[c]; i < list.length; i++) {
        const n = list[i];
        const y = n.state === 'holding' ? hitY : yOf(n.sv);
        if (y < topCull) break;
        if (y > botCull) continue;
        const missed = n.headJudge === 'miss';
        if (n.state === 'done' && !missed) continue;
        ctx.save();
        ctx.translate(x + 3, y - noteH * 0.5);
        ctx.globalAlpha = missed ? 0.32 : 1;
        ctx.fillStyle = missed ? this.sprites.noteMiss : this.sprites.note[c];
        roundRectPath(ctx, 0, 0, colW - 6, noteH, 5);
        ctx.fill();
        if (!missed && this.quality === 'high') {
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.fillRect(4, 1.4, colW - 14, 1.6);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // 押下中のビーム
    if (this.quality === 'high') {
      for (let c = 0; c < keys; c++) {
        if (!f.down[c]) continue;
        ctx.save();
        ctx.translate(pfX + c * colW, hitY);
        ctx.fillStyle = this.sprites.beam[c];
        ctx.fillRect(1, -noteH * 9, colW - 2, noteH * 9);
        ctx.restore();
      }
    }

    // リセプター
    for (let c = 0; c < keys; c++) {
      const x = pfX + c * colW;
      const pressed = !!f.down[c];
      ctx.save();
      ctx.translate(x + 3, hitY - noteH * 0.5);
      roundRectPath(ctx, 0, 0, colW - 6, noteH, 5);
      ctx.fillStyle = pressed ? rgba(this.colors[c], 0.3) : 'rgba(255,255,255,0.045)';
      ctx.fill();
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = pressed ? rgba(this.colors[c], 0.95) : 'rgba(255,255,255,0.2)';
      roundRectPath(ctx, 0, 0, colW - 6, noteH, 5);
      ctx.stroke();
      ctx.restore();
      if (pressed && this.quality === 'high') {
        const size = colW * 1.8;
        ctx.globalAlpha = 0.45;
        ctx.drawImage(this.sprites.glow[c], x + colW / 2 - size / 2, hitY - size / 2, size, size);
        ctx.globalAlpha = 1;
      }
    }

    // 判定線
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(pfX, hitY - 1, pfW, 1.5);

    // ヒットエフェクト
    const now = f.time;
    const S = this.sprites;
    for (let i = f.effects.length - 1; i >= 0; i--) {
      const e = f.effects[i];
      const dur = e.dur || (e.judge === 'miss' ? 300 : 250);
      const age = now - e.t;
      if (age > dur) { f.effects.splice(i, 1); continue; }
      const p = age / dur;
      const x = pfX + e.col * colW;
      ctx.globalAlpha = (1 - p) * (e.judge === 'miss' ? 0.5 : e.part === 'tail' ? 0.55 : 0.85);
      if (e.judge === 'miss' || this.quality === 'low') {
        const g = e.judge === 'miss' ? S.glowMiss : S.glow[e.col];
        const size = colW * (e.judge === 'miss' ? 1.3 + p * 0.5 : 1.4 + p * 1.4);
        ctx.drawImage(g, x + colW / 2 - size / 2, hitY - size / 2, size, size);
      } else {
        const size = colW * (1.5 + p * 1.7);
        ctx.drawImage(S.glow[e.col], x + colW / 2 - size / 2, hitY - size / 2, size, size);
      }
      ctx.globalAlpha = 1;
    }

    if (this.quality === 'high') {
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth = 1;
      ctx.strokeRect(pfX + 0.5, 0.5, pfW - 1, h - 1);
    }
  }
}
