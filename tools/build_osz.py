#!/usr/bin/env python3
"""Build osu! beatmapset archives for all songs in the project.

Each .osz is a zip archive (no enclosing folder) holding every chart:
    1x 譜面 (音源: <song>.mp3) + 2x 譜面 (全時間を半分に, 音源: <song> (2x).mp3)
    + サムネイル.png

Usage:
    python3 tools/build_osz.py                  # build all songs
    python3 tools/build_osz.py --song shitsurengo  # build one song
    python3 tools/build_osz.py --keep-audio     # skip 2x audio regeneration

Re-run after editing a chart, then commit the new .osz files.
"""

from __future__ import annotations

import argparse
import io
import pathlib
import re
import sys
import time
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Per-song configuration
SONGS = {
    'shitsurengo': {
        'dir': '失恋後',
        'diffs': [('easy.osu', 'Easy'), ('normal.osu', 'Normal'), ('hard.osu', 'Hard')],
        'audio': '失恋後.mp3',
        'bg': 'サムネイル.png',
        'audio_2x': '失恋後 (2x).mp3',
        'suffix_2x': '(2x)',
    },
    'shitsurirongo': {
        'dir': '失理論後',
        'diffs': [('easy.osu', 'Easy'), ('normal.osu', 'Normal'), ('hard.osu', 'Hard')],
        'audio': '失理論後.mp3',
        'bg': 'サムネイル.png',
        'audio_2x': '失理論後 (2x).mp3',
        'suffix_2x': '(2x)',
    },
}

MP3_BITRATES = (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)


def h2(t: int) -> int:
    return round(t / 2)


def parse_osu(text: str) -> dict:
    meta: dict[str, str] = {}
    general: dict[str, str] = {}
    events: list[str] = []
    times: list[int] = []
    ln_ends: list[int] = []
    notes = ln = 0
    last_ms = 0
    sec = ''
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith('[') and line.endswith(']'):
            sec = line
            continue
        if not line or line.startswith('//'):
            continue
        if sec in ('[Metadata]', '[General]') and ':' in line:
            key, val = line.split(':', 1)
            (meta if sec == '[Metadata]' else general)[key.strip()] = val.strip()
        elif sec == '[Events]':
            events.append(line)
        elif sec == '[HitObjects]':
            parts = line.split(',')
            t = int(parts[2])
            notes += 1
            last_ms = max(last_ms, t)
            times.append(t)
            if int(parts[3]) & 128:
                ln += 1
                end = int(parts[5].split(':')[0])
                ln_ends.append(end)
                last_ms = max(last_ms, end)
    return {'meta': meta, 'general': general, 'events': events,
            'notes': notes, 'ln': ln, 'last_ms': last_ms,
            'times': times, 'ln_ends': ln_ends}


def to_2x_osu(text: str, version: str, audio_2x: str) -> str:
    out: list[str] = []
    sec = ''
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            sec = stripped
            out.append(line)
            continue

        if sec == '[General]':
            m = re.match(r'(AudioFilename)\s*:\s*(.*?)\s*$', line)
            if m:
                out.append(f'AudioFilename: {audio_2x}')
                continue
            m = re.match(r'(PreviewTime|AudioLeadIn)\s*:\s*(-?\d+)\s*$', line)
            if m:
                out.append(f'{m.group(1)}: {h2(int(m.group(2)))}')
                continue

        elif sec == '[Editor]':
            m = re.match(r'(Bookmarks)\s*:\s*(.*)$', line)
            if m:
                marks = ','.join(str(h2(int(b)))
                                 for b in m.group(2).split(',') if b.strip())
                out.append(f'Bookmarks:{marks}')
                continue

        elif sec == '[Metadata]':
            m = re.match(r'(Version)\s*:\s*(.*?)\s*$', line)
            if m:
                out.append(f'Version:{version}')
                continue
            m = re.match(r'(Tags)\s*:\s*(.*?)\s*$', line)
            if m:
                tags = m.group(2).split()
                if '2x' not in tags:
                    tags.append('2x')
                out.append('Tags:' + ' '.join(tags))
                continue

        elif sec == '[TimingPoints]':
            parts = line.split(',')
            if len(parts) >= 2:
                parts[0] = str(h2(float(parts[0])))
                out.append(','.join(parts))
                continue

        elif sec == '[HitObjects]':
            parts = line.split(',')
            if len(parts) >= 5:
                parts[2] = str(h2(int(parts[2])))
                obj_type = int(parts[3])
                if obj_type & 128 or obj_type & 8:
                    if ':' in parts[5]:
                        end, rest = parts[5].split(':', 1)
                        parts[5] = f'{h2(int(end))}:{rest}'
                    else:
                        parts[5] = str(h2(int(parts[5])))
                out.append(','.join(parts))
                continue

        out.append(line)
    return '\n'.join(out) + '\n'


def make_2x_audio(src: pathlib.Path, dst: pathlib.Path) -> None:
    try:
        import lameenc
        import numpy
        import soundfile
    except ImportError as e:
        raise SystemExit(
            '2倍速音源の生成には次のパッケージが必要です:\n'
            '  pip install soundfile numpy lameenc\n'
            f'({e})\n'
            '無印の音源を再生成せず、既存のものを使う場合は --keep-audio を付けてください。'
        ) from e

    data, sr = soundfile.read(str(src), dtype='int16')
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    dur = data.shape[0] / sr

    fast = numpy.ascontiguousarray(data[::2])
    kbps = min(MP3_BITRATES, key=lambda b: abs(b - src.stat().st_size * 8 / dur / 1000))
    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(sr)
    enc.set_channels(data.shape[1])
    enc.set_quality(2)
    mp3 = enc.encode(fast.tobytes()) + enc.flush()
    dst.write_bytes(mp3)

    check, sr2 = soundfile.read(io.BytesIO(mp3), dtype='int16')
    got = check.shape[0] / sr2
    if abs(got - dur / 2) > 0.5:
        raise SystemExit(f'2倍速音源の長さが不正です: {got:.2f}s (期待値 {dur / 2:.2f}s)')
    print(f'  2x audio: {src.name} ({dur:.1f}s, {kbps}kbps) → '
          f'{dst.name} ({got:.1f}s)')


def write_zip(out_path: pathlib.Path, entries: list[tuple[str, bytes]]) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arcname, data in entries:
            info = zipfile.ZipInfo(arcname, date_time=time.localtime()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)


def check(info: dict, version: str, names_in_zip: set[str], audio: str,
          bg: str) -> None:
    meta, general = info['meta'], info['general']
    errors = []
    if general.get('Mode') != '3':
        errors.append(f'Mode は 3 (osu!mania) でなければなりません: {general.get("Mode")!r}')
    if general.get('AudioFilename') != audio:
        errors.append(f'AudioFilename は {audio} のはずです: {general.get("AudioFilename")!r}')
    if general.get('AudioFilename') not in names_in_zip:
        errors.append(f'AudioFilename が .osz 内にありません: {general.get("AudioFilename")!r}')
    bg_match = next((e for e in info['events'] if e.startswith('0,0,')), None)
    if bg_match is None or bg not in bg_match:
        errors.append(f'[Events] に背景 {bg} の指定がありません')
    if meta.get('Version') != version:
        errors.append(f'Version は {version} のはずです: {meta.get("Version")!r}')
    for key in ('Title', 'TitleUnicode', 'Artist', 'ArtistUnicode', 'Creator'):
        if not meta.get(key) or meta[key].startswith('Unknown'):
            errors.append(f'[Metadata] {key} が未設定です: {meta.get(key)!r}')
    if info['notes'] == 0:
        errors.append('HitObjects が 0 件です')
    if errors:
        raise SystemExit(f'[{version}] 検証エラー:\n  - ' + '\n  - '.join(errors))


def chart_arcname(meta: dict, version: str) -> str:
    artist = meta.get('ArtistUnicode') or meta.get('Artist', '')
    title = meta.get('TitleUnicode') or meta.get('Title', '')
    return f'{artist} - {title} ({meta["Creator"]}) [{version}].osu'


def summary_line(version: str, info: dict, arcname: str) -> str:
    mm, ss = divmod(info['last_ms'] // 1000, 60)
    return (f'  [{version:9}] {info["notes"]:5} notes (LN {info["ln"]:3})  '
            f'~{mm}:{ss:02d}  {arcname}')


def _audio_needs_build(audio_2x_path: pathlib.Path, src: pathlib.Path) -> bool:
    if not audio_2x_path.is_file():
        return True
    return src.stat().st_mtime > audio_2x_path.stat().st_mtime + 60


def build_song(song_key: str, keep_audio: bool) -> dict:
    cfg = SONGS[song_key]
    song_dir = ROOT / 'songs' / cfg['dir']
    audio = cfg['audio']
    bg = cfg['bg']
    audio_2x = cfg['audio_2x']
    suffix_2x = cfg['suffix_2x']
    output = ROOT / f'{song_key}.osz'

    for name in (audio, bg, *(src for src, _ in cfg['diffs'])):
        if not (song_dir / name).is_file():
            raise SystemExit(f'必要なファイルがありません: {song_dir / name}')

    entries: list[tuple[str, bytes]] = []
    expected: dict[str, str] = {}
    summaries: list[str] = []
    chart_files: list[str] = []
    artist = title = None

    for src, version in cfg['diffs']:
        text = (song_dir / src).read_text(encoding='utf-8')
        info = parse_osu(text)
        check(info, version, {audio, bg}, audio, bg)
        meta = info['meta']
        artist = meta.get('ArtistUnicode') or meta.get('Artist', '')
        title = meta.get('TitleUnicode') or meta.get('Title', '')

        arcname = chart_arcname(meta, version)
        entries.append((arcname, text.encode('utf-8')))
        summaries.append(summary_line(version, info, arcname))
        chart_files.append(arcname)
        expected[version] = audio

        # 2x 版
        version_2x = f'{version} {suffix_2x}'
        text_2x = to_2x_osu(text, version_2x, audio_2x)
        info_2x = parse_osu(text_2x)
        check(info_2x, version_2x, {audio_2x, bg}, audio_2x, bg)
        if (info_2x['notes'], info_2x['ln']) != (info['notes'], info['ln']):
            raise SystemExit(f'[{version_2x}] ノーツ数が一致しません: '
                             f'{info_2x["notes"]}/{info_2x["ln"]} vs '
                             f'{info["notes"]}/{info["ln"]}')
        if (info_2x['times'] != [h2(t) for t in info['times']]
                or info_2x['ln_ends'] != [h2(t) for t in info['ln_ends']]):
            raise SystemExit(f'[{version_2x}] ノーツ時間が元の半分になっていません')
        arcname_2x = chart_arcname(meta, version_2x)
        entries.append((arcname_2x, text_2x.encode('utf-8')))
        summaries.append(summary_line(version_2x, info_2x, arcname_2x))
        chart_files.append(arcname_2x)
        expected[version_2x] = audio_2x

    # 音源
    audio_2x_path = song_dir / audio_2x
    if keep_audio or not _audio_needs_build(audio_2x_path, song_dir / audio):
        if not audio_2x_path.is_file():
            raise SystemExit(
                f'2倍速音源がありません: {audio_2x_path}\n'
                '  pip install soundfile numpy lameenc のうえ、--keep-audio を外して再実行してください。'
            )
        print(f'  2x audio: 既存の {audio_2x} を使用')
    else:
        make_2x_audio(song_dir / audio, audio_2x_path)
    entries.append((audio, (song_dir / audio).read_bytes()))
    entries.append((audio_2x, audio_2x_path.read_bytes()))
    entries.append((bg, (song_dir / bg).read_bytes()))

    write_zip(output, entries)

    # 読み戻し検証
    with zipfile.ZipFile(output) as zf:
        bad = zf.testzip()
        assert bad is None, f'zip が壊れています: {bad}'
        names = set(zf.namelist())
        versions = set()
        for name in zf.namelist():
            if name.endswith('.osu'):
                info2 = parse_osu(zf.read(name).decode('utf-8'))
                versions.add(info2['meta']['Version'])
        assert versions == set(expected), f'期待された難易度: {set(expected)}, 実際: {versions}'

    size_mb = output.stat().st_size / 1_000_000
    print(f'{title} / {artist} — 1倍速{len(cfg["diffs"])}譜面 + 2倍速{len(cfg["diffs"])}譜面'
          f'の .osz を作成しました')
    print('\n'.join(summaries))
    print(f'  + audio: {audio} / {audio_2x} / background: {bg}')
    print(f'-> {output} ({size_mb:.2f} MB, {len(entries)} files)')
    return {'entries': entries, 'chart_files': chart_files, 'summary': summaries,
            'versions': expected, 'size': output.stat().st_size}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--song', type=str, choices=list(SONGS.keys()),
                    help='ビルドする曲を指定 (省略時は全曲)')
    ap.add_argument('--output', type=pathlib.Path,
                    help='出力先 .osz (既定: リポジトリ直下/<song_key>.osz)')
    ap.add_argument('--keep-audio', action='store_true',
                    help='2倍速音源を再生成せず既存のものを使う')
    args = ap.parse_args()

    keys = [args.song] if args.song else list(SONGS.keys())
    for key in keys:
        build_song(key, keep_audio=args.keep_audio)
        print()

    print('全曲のビルドが完了しました。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
