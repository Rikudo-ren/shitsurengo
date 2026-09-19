/**
 * server.js — 依存パッケージゼロの静的サーバ（開発/配布用）。
 *   npm start  →  http://0.0.0.0:8080
 * 日本語ファイル名・Range リクエスト（音源のシーク）に対応。
 */
import { createServer } from 'node:http';
import { stat, readFile, open } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.osu': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.webm': 'video/webm',
  '.woff2': 'font/woff2',
};

const NO_CACHE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.osu']);

function mimeOf(p) { return MIME[extname(p).toLowerCase()] || 'application/octet-stream'; }

const server = createServer(async (req, res) => {
  try {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') pathname = '/index.html';
    const filePath = resolve(join(ROOT, pathname.split('/').join(sep)));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    let st;
    try {
      st = await stat(filePath);
    } catch {
      // SPA フォールバック
      if (!extname(filePath)) {
        st = await stat(join(ROOT, 'index.html'));
        return serveFile(join(ROOT, 'index.html'), st, req, res);
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    if (st.isDirectory()) {
      const idx = join(filePath, 'index.html');
      try { st = await stat(idx); return serveFile(idx, st, req, res); } catch { /* fallthrough */ }
    }
    serveFile(filePath, st, req, res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + e.message);
  }
});

async function serveFile(filePath, st, req, res) {
  const type = mimeOf(filePath);
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    'Cache-Control': NO_CACHE.has(extname(filePath).toLowerCase()) ? 'no-cache' : 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range && (range[1] || range[2])) {
    const size = st.size;
    let start = range[1] ? parseInt(range[1], 10) : size - parseInt(range[2], 10);
    let end = range[1] && range[2] ? parseInt(range[2], 10) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': end - start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    const fh = await open(filePath, 'r');
    try {
      const stream = fh.createReadStream({ start, end });
      stream.pipe(res);
      stream.on('close', () => fh.close());
    } catch { await fh.close(); res.end(); }
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  res.end(await readFile(filePath));
}

server.listen(PORT, HOST, () => {
  console.log(`失恋後 VSRG  →  http://${HOST}:${PORT}/  (Ctrl+C で終了)`);
});
