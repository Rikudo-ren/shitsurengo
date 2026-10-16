#!/usr/bin/env python3
"""AI 生成の .osu を「osu! が正しく読める形」に整える（イデンポート・べき等）。

Mapperatorinator などの自動生成譜面には、osu! 的には *不備* とみなされる
要素が混ざる。ここでは譜面データ（ノーツの位置・時刻）には一切触れず、
次のようなメタ的な汚れだけを落とす:

  * 不可視文字（U+034F COMBINING GRAPHEME JOINER など）
      → これがあると `[Colours] Combo3:` のキー名が壊れ、osu! が色を
        読み飛ばす（色が一部だけデフォルトに戻る）
  * `[HitObjects]` のヒットサウンドがバラバラ（clap/whistle/finish が
    ランダムに付き、音量も 20〜80 と不揃い）
      → 打鍵音が鳴ったり鳴らなかったりして非常に不快。全ノーツを
        `hitSound=0` / `hitSample=2:2:0:50:`（soft・音量50）に統一する
  * `[Editor] Bookmarks:-330001` のような生成器任せのゴミ
  * `Tags:` に残った生成ツール名（`mapperatorinator`）
  * 行末の余分な空白 / CRLF の混在

使い方:
    python3 tools/normalize_osu.py                 # 対象を表示（dry-run）
    python3 tools/normalize_osu.py --write         # 実際に書き換える
    python3 tools/normalize_osu.py --check         # 差分があれば終了コード1
    python3 tools/normalize_osu.py songs/失恋後/easy.osu --write
"""

from __future__ import annotations

import argparse
import pathlib
import re
import sys
import unicodedata

ROOT = pathlib.Path(__file__).resolve().parent.parent

# osu! が「見えない文字」として混入させられると壊れる文字
INVISIBLE = re.compile(
    '['
    '\u00ad'          # soft hyphen
    '\u034f'          # COMBINING GRAPHEME JOINER ← 実際に混入していた
    '\u115f\u1160'    # Hangul fillers
    '\u17b4\u17b5'
    '\u180b-\u180e\u200b-\u200f\u2028\u2029\u2060-\u2064\u2066-\u206f'
    '\u3164\ufeff\uffa0'
    ']')

# 打鍵音（ヒットサウンド）の統一先: soft / 音量 50
SAMPLE = '2:2:0:50:'

TAG_STRIP = ('mapperatorinator', 'mapperator', 'ai生成')
TAG_EXTRA = ('mania', '4k')


def strip_invisible(text: str) -> str:
    return INVISIBLE.sub('', text)


def normalize_tags(value: str, song_key: str, title: str, artist: str,
                   creator: str) -> str:
    tags = [t for t in strip_invisible(value).split() if t]
    tags = [t for t in tags if t.lower() not in TAG_STRIP]
    for t in (song_key, title, artist, creator, *TAG_EXTRA):
        if t and t not in tags:
            tags.append(t)
    return ' '.join(tags)


def normalize_hitobject(line: str) -> str:
    """x,y,time,type,hitSound,endTime:hitSample,… → 打鍵音だけ統一する。"""
    parts = line.split(',')
    if len(parts) < 5:
        return line
    try:
        obj_type = int(parts[3])
    except ValueError:
        return line
    parts[4] = '0'                       # hitSound ビット（clap/whistle/finish）を落とす
    if obj_type & 128 or obj_type & 8:   # ロングノーツ / マニアのホールド
        if ':' in parts[5]:
            end, _ = parts[5].split(':', 1)
        else:
            end = parts[5]
        parts[5] = f'{end}:{SAMPLE}'
    else:
        parts[5] = SAMPLE
    return ','.join(parts)


def normalize_text(text: str, song_key: str) -> str:
    meta: dict[str, str] = {}
    sec = ''
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith('[') and line.endswith(']'):
            sec = line
            continue
        if sec == '[Metadata]' and ':' in line:
            k, v = line.split(':', 1)
            meta[k.strip()] = v.strip()

    out: list[str] = []
    sec = ''
    for raw in text.replace('\r\n', '\n').replace('\r', '\n').split('\n'):
        line = strip_invisible(raw.rstrip())
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            sec = stripped
            out.append(line)
            continue

        if sec == '[Editor]' and stripped.startswith('Bookmarks:'):
            # 生成器が入れた意味不明なブックマーク（例 -330001）は落とす
            continue

        if sec == '[Metadata]' and stripped.startswith('Tags:'):
            value = stripped[len('Tags:'):]
            out.append('Tags:' + normalize_tags(
                value, song_key, meta.get('TitleUnicode') or meta.get('Title', ''),
                meta.get('ArtistUnicode') or meta.get('Artist', ''),
                meta.get('Creator', '')))
            continue

        if sec == '[HitObjects]':
            out.append(normalize_hitobject(line) if stripped else line)
            continue

        out.append(line)

    # 末尾の余分な空行は1つに
    while out and not out[-1].strip():
        out.pop()
    return '\n'.join(out) + '\n'


def note_signature(text: str):
    """ノーツの位置・時刻だけを抜き出す（書き換えで変化してはいけない部分）。"""
    sec = ''
    sig = []
    for raw in text.splitlines():
        line = strip_invisible(raw.strip())
        if line.startswith('[') and line.endswith(']'):
            sec = line
            continue
        if sec == '[HitObjects]' and line:
            p = line.split(',')
            sig.append((p[0], p[1], p[2], p[3], p[5].split(':')[0] if len(p) > 5 else ''))
    return sig


def song_id_by_dir() -> dict[str, str]:
    """songs.json の id をフォルダ名から引けるようにする（Tags 用）。"""
    import json
    try:
        data = json.loads((ROOT / 'songs' / 'songs.json').read_text(encoding='utf-8'))
    except Exception:
        return {}
    out = {}
    for song in data.get('songs', []):
        audio = song.get('audio', '')
        parts = audio.split('/')
        if len(parts) >= 3:
            out[parts[1]] = song.get('id', '')
    return out


def targets(paths: list[str]) -> list[pathlib.Path]:
    if paths:
        return [pathlib.Path(p) for p in paths]
    return sorted((ROOT / 'songs').glob('*/*.osu'))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('paths', nargs='*', help='対象 .osu（省略時は songs/*/*.osu 全部）')
    ap.add_argument('--write', action='store_true', help='実際に書き換える')
    ap.add_argument('--check', action='store_true',
                    help='正規化が必要なファイルがあれば終了コード 1')
    args = ap.parse_args()

    ids = song_id_by_dir()
    changed = 0
    for path in targets(args.paths):
        text = path.read_text(encoding='utf-8')
        song_key = ids.get(path.parent.name, path.parent.name)
        new = normalize_text(text, song_key)
        if note_signature(text) != note_signature(new):
            print(f'!! {path}: ノーツデータが変化してしまうため中止', file=sys.stderr)
            return 2
        if new == text:
            continue
        changed += 1
        rel = path.relative_to(ROOT) if path.is_relative_to(ROOT) else path
        print(f'{"変更" if args.write else "要修正"}: {rel}')
        if args.write:
            path.write_text(new, encoding='utf-8')

    if changed and not args.write:
        print(f'\n{changed} ファイルが正規化されていません。--write で適用してください。')
    elif changed:
        print(f'\n{changed} ファイルを正規化しました。')
    else:
        print('すべての .osu は正規化済みです。')
    return 1 if (changed and args.check) else 0


if __name__ == '__main__':
    sys.exit(main())
