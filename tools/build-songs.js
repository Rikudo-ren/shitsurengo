/**
 * tools/build-songs.js — songs/ 配下をスキャンして songs/songs.json を生成する。
 *
 * 【曲の追加手順】
 *   1. songs/<曲名フォルダ>/ に .osu 譜面と音源・画像を入れる
 *   2. （任意）songs/<曲名フォルダ>/song.json でタイトルや星数を指定
 *   3. npm run songs  →  songs/songs.json が再生成される
 *
 * 依存パッケージなしで動きます。`npm i -D sharp` があるとサムネイル自動圧縮も実行します。
 */
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsu } from '../js/osu.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const SONGS_DIR = join(ROOT, 'songs');
const AUDIO_EXT = ['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.webm'];
const IMG_EXT = ['.webp', '.png', '.jpg', '.jpeg', '.avif'];

const args = process.argv.slice(2);
const FORCE_THUMB = args.includes('--thumbs');

function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function filesOf(dir) { try { return readdirSync(dir); } catch { return []; } }

/** 星数の既定値（譜面の密度から概算） */
function estimateStars(stats) {
  const s = 1 + stats.nps * 1.35 + (stats.ln / Math.max(1, stats.objects)) * 3;
  return Math.round(Math.max(1, Math.min(15, s)) * 10) / 10;
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

async function makeThumbnails(dir, srcImage) {
  let sharp;
  try { sharp = (await import('sharp')).default; } catch { return []; }
  const made = [];
  const jobs = [
    ['thumb.webp', 480, 78],
    ['thumb_s.webp', 256, 76],
    ['bg.webp', 1080, 74],
  ];
  for (const [name, width, quality] of jobs) {
    const out = join(dir, name);
    if (existsSync(out) && !FORCE_THUMB) { made.push(name); continue; }
    try {
      await sharp(srcImage).resize(width, null, { withoutEnlargement: true }).webp({ quality }).toFile(out);
      made.push(name);
    } catch (e) {
      console.warn(`  ! サムネイル生成失敗: ${name}`, e.message);
    }
  }
  return made;
}

async function buildSong(folder) {
  const dir = join(SONGS_DIR, folder);
  const files = filesOf(dir);
  const osuFiles = files.filter((f) => extname(f).toLowerCase() === '.osu');
  if (!osuFiles.length) return null;

  const override = readJson(join(dir, 'song.json')) || {};
  const parsed = [];
  for (const f of osuFiles) {
    const text = readFileSync(join(dir, f), 'utf8');
    const chart = parseOsu(text);
    const tagDiff = /difficulty=([\d.]+)/.exec(chart.metadata.Tags || '');
    parsed.push({
      file: f,
      chart,
      name: f.replace(/\.osu$/i, '').replace(/^./, (c) => c.toUpperCase()),
      tagDifficulty: tagDiff ? parseFloat(tagDiff[1]) : null,
    });
  }
  parsed.sort((a, b) => a.chart.stats.objects - b.chart.stats.objects);

  // 音源
  let audio = override.audio || parsed[0]?.chart.general.AudioFilename || '';
  if (!audio || !existsSync(join(dir, audio))) {
    const found = files.find((f) => AUDIO_EXT.includes(extname(f).toLowerCase()));
    audio = found || audio;
  }
  const audioPath = audio ? join(dir, audio) : null;
  const audioSize = audioPath && existsSync(audioPath) ? statSync(audioPath).size : 0;

  // 画像（thumb.webp があれば優先。なければ元画像から生成を試みる）
  let thumb = override.thumbnail || null;
  let thumbSmall = override.thumbnailSmall || null;
  let bg = override.background || null;
  const images = files.filter((f) => IMG_EXT.includes(extname(f).toLowerCase()));
  const bigSource = images.find((f) => /サムネイル|cover|bg|background|thumb/i.test(f)) || images[0] || null;
  if (bigSource && (!existsSync(join(dir, 'thumb.webp')) || FORCE_THUMB)) {
    const made = await makeThumbnails(dir, join(dir, bigSource));
    if (made.length) console.log(`  + サムネイル生成: ${made.join(', ')}`);
  }
  const pick = (cands) => cands.find((c) => c && existsSync(join(dir, c))) || null;
  thumb = thumb || pick(['thumb.webp', 'thumb.jpg', 'thumb.png', bigSource]);
  thumbSmall = thumbSmall || pick(['thumb_s.webp', thumb]);
  bg = bg || pick(['bg.webp', thumb]);

  const difficulties = (override.difficulties || []).map((d, i) => {
    const p = parsed.find((x) => x.file === d.file) || parsed[i];
    return { d, p };
  }).filter((x) => x.p).map(({ d, p }) => ({
    file: p.file,
    name: d.name || p.name,
    stars: typeof d.stars === 'number' ? d.stars : estimateStars(p.chart.stats),
    order: typeof d.order === 'number' ? d.order : null,
  }));
  const list = difficulties.length
    ? difficulties
    : parsed.map((p) => ({
        file: p.file,
        name: p.name,
        stars: p.tagDifficulty ? Math.round(p.tagDifficulty * 10) / 10 : estimateStars(p.chart.stats),
        order: null,
      }));
  list.sort((a, b) => (a.order ?? a.stars) - (b.order ?? b.stars));

  const first = parsed[0].chart;
  return {
    id: override.id || folder.toLowerCase().replace(/[^\w\u3000-\u9fff-]+/g, '-'),
    folder,
    title: override.title || first.metadata.TitleUnicode || first.metadata.Title || folder,
    titleUnicode: override.titleUnicode || first.metadata.TitleUnicode || folder,
    artist: override.artist || first.metadata.ArtistUnicode || first.metadata.Artist || 'Unknown Artist',
    artistUnicode: override.artistUnicode || first.metadata.ArtistUnicode || override.artist || 'Unknown Artist',
    creator: override.creator || first.metadata.Creator || '',
    source: override.source || first.metadata.Source || '',
    audio,
    audioOk: audioSize > 1024,
    audioSize,
    thumbnail: thumb,
    thumbnailSmall: thumbSmall || thumb,
    background: bg || thumb,
    difficulties: list.map((d) => {
      const p = parsed.find((x) => x.file === d.file);
      const c = p.chart;
      return {
        file: d.file,
        name: d.name,
        stars: d.stars,
        keys: c.keys,
        objects: c.stats.objects,
        ln: c.stats.ln,
        nps: Math.round(c.stats.nps * 100) / 100,
        bpm: Math.round(c.bpm),
        lengthMs: c.durationMs,
      };
    }),
  };
}

const folders = filesOf(SONGS_DIR).filter((f) => isDir(join(SONGS_DIR, f)) && !f.startsWith('.'));
const songs = [];
for (const folder of folders) {
  console.log(`[songs] ${folder}`);
  const song = await buildSong(folder);
  if (song) {
    songs.push(song);
    console.log(`   ${song.title} / ${song.difficulties.map((d) => `${d.name}(${d.stars}★)`).join(', ')}`);
  }
}
const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  songs,
};
writeFileSync(join(SONGS_DIR, 'songs.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`[songs] ${songs.length} 曲 → songs/songs.json`);
