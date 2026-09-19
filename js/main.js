/**
 * main.js — エントリポイント。
 */
import { App } from './ui.js';

const app = new App();
window.SRG = app; // デバッグ用

app.boot().catch((e) => {
  console.error(e);
  const el = document.getElementById('title-meta');
  if (el) el.textContent = '初期化に失敗しました: ' + (e && e.message ? e.message : e);
});
