#!/usr/bin/env python3
"""Build osu! beatmapset archives for all songs in the project.

1曲につき *1つ* の .osz を作る（1倍速3譜面 + 2倍速3譜面 + 音源2つ）:
    <song_key>.osz      1倍速 Easy/Normal/Hard + 2倍速 Easy_x2/Normal_x2/Hard_x2

難易度ごとに参照する音源は .osu の [General] `AudioFilename` で指定する
（1倍速 → <song>.mp3 / 2倍速 → <song>_x2.mp3）。これで1セットに両方入る。

ただし osu! は「セットの曲情報（長さ・プレビュー・BPM 表示など）」に
セット内のどれか1つの音源を使う。どれが選ばれるかは **ファイル名の並び順** に
左右され、`失恋後 (2x).mp3` は `失恋後.mp3` より前に並ぶため（全角・半角を問わず
' ' や '(' は '.' より小さい）、2倍速の音源＝半分の長さがセットの曲として
扱われ「1倍速の譜面が 2:51 ではなく 1:25 になる」不具合が出ていた。
そこで **1倍速側が必ず先に並ぶ名前** にしてある:

    1倍速: <song>.mp3        Version "Easy"      ← 先に並ぶ
    2倍速: <song>_x2.mp3     Version "Easy_x2"   ← 後に並ぶ

`Easy_x2` / `_x2` は、'.' や '_' を無視する比較（カルチャ依存の並べ替え）でも
`Easy` / `<song>.mp3` より後になる（'x' > 'm' > '2'）。ビルド時に
「1倍速の音源・譜面ファイル名が 2倍速より前に並ぶ」ことを検証している。

Usage:
    python3 tools/build_osz.py                      # 全曲
    python3 tools/build_osz.py --song shitsurengo
    python3 tools/build_osz.py --keep-audio         # 2倍速音源を作り直さない
    python3 tools/build_osz.py --song shitsurengo --force-audio
    python3 tools/build_osz.py --song shitsurengo --output /tmp/a.osz

ビルド時に検証すること（不備を .osz に混入させないための門番）:
    * 1倍速/2倍速それぞれの音源が揃い、各譜面の AudioFilename が自分の速度を指すか
    * 1倍速のファイル名が 2倍速より前に並ぶか ← 上記「セットの曲」誤選択を防ぐ
    * メタデータ / モード / 背景 / 参照音源が正しいか
    * .osu に不可視文字・制御文字が混ざっていないか
    * 4K として不正なノーツ（同時刻重複 / レーン中央でない座標 / LN の長さ / 0件）が無いか
    * 打鍵音 (hitSound / hitSample) が全ノーツで統一されているか
    * ノーツ・プレビュー位置が音源の長さに収まっているか
    * 2倍速譜面が 1倍速譜面の時間を正しく半分にしたものか
    * 2倍速音源が 1倍速音源をちょうど2倍速にしたものか（符号化遅延まで補正・実測）
ノーツの打鍵音がバラついている等の「汚れ」は tools/normalize_osu.py で落とせる。

Re-run after editing a chart, then commit the new .osz files.
"""

from __future__ import annotations

import argparse
import io
import pathlib
import re
import sys
import time
import unicodedata
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent

# Per-song configuration
SONGS = {
    'shitsurengo': {
        'dir': '失恋後',
        'keys': 4,
        'diffs': [('easy.osu', 'Easy'), ('normal.osu', 'Normal'), ('hard.osu', 'Hard')],
        'audio': '失恋後.mp3',
        'bg': 'サムネイル.png',
        'audio_2x': '失恋後_x2.mp3',
        'suffix_2x': '（x2）',
    },
    'shitsurirongo': {
        'dir': '失理論後',
        'keys': 4,
        'diffs': [('easy.osu', 'Easy'), ('normal.osu', 'Normal'), ('hard.osu', 'Hard')],
        'audio': '失理論後.mp3',
        'bg': 'サムネイル.png',
        'audio_2x': '失理論後_x2.mp3',
        'suffix_2x': '（x2）',
    },
}

MP3_BITRATES = (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)

# 打鍵音の統一先（tools/normalize_osu.py と揃える）: soft / 音量 50
SAMPLE = '2:2:0:50:'

# 2倍速譜面のスクロール速度。
# 以前は BPM 2倍 + SV 0.5 で「BPM×SV」を 1倍速と同じにしていたが、
# osu!mania の Fixed スクロールは BPM に依らず SV のみに依存するため、
# Fixed 使用時にスクロールが 1/2 になってしまう。
# 2倍速は「BPM 表示は実際の速さ(2倍)」「スクロールは 1倍速と同じ(Fixed)」
# を優先し、SV=1.0 に修正する（BPM scale 使用時は 2倍速になる）。
SV_2X = 1.0


def _sv_line_value() -> str:
    """継承行（緑線）の beatLength。SV_2X のとき -200 になる。"""
    return str(int(-100 / SV_2X))

# osu! が読み飛ばしてしまう不可視文字・制御文字
INVISIBLE = re.compile(
    '[' 
    '\u0000-\u0008\u000b-\u001f\u007f'            # 制御文字（\t 以外）
    '\u00ad\u034f\u115f\u1160\u17b4\u17b5'
    '\u180b-\u180e\u200b-\u200f\u2028\u2029\u2060-\u2064\u2066-\u206f'
    '\u3164\ufeff\uffa0'
    ']')

COLOUR_KEYS = {f'Combo{i}' for i in range(9)} | {'SliderTrackOverride', 'SliderBorder'}


def h2(t: int) -> int:
    return round(t / 2)


def parse_osu(text: str) -> dict:
    meta: dict[str, str] = {}
    general: dict[str, str] = {}
    events: list[str] = []
    timing: list[tuple[float, float]] = []
    colours: dict[str, str] = {}
    objects: list[dict] = []
    times: list[int] = []
    ln_ends: list[int] = []
    invisible: list[tuple[int, str]] = []
    unparsable: list[str] = []
    notes = ln = 0
    last_ms = 0
    sec = ''
    for raw in text.splitlines():
        for ch in INVISIBLE.findall(raw):
            invisible.append((len(objects), f'U+{ord(ch):04X} {unicodedata.name(ch, "?")}'))
        line = raw.strip()
        if line.startswith('[') and line.endswith(']'):
            sec = line
            continue
        if not line or line.startswith('//'):
            continue
        if sec == '[General]' and ':' in line:
            key, val = line.split(':', 1)
            general[key.strip()] = val.strip()
        elif sec == '[Metadata]' and ':' in line:
            key, val = line.split(':', 1)
            meta[key.strip()] = val.strip()
        elif sec == '[Events]':
            events.append(line)
        elif sec == '[Colours]' and ':' in line:
            key, val = line.split(':', 1)
            colours[key.strip()] = val.strip()
        elif sec == '[TimingPoints]':
            parts = line.split(',')
            if len(parts) >= 2:
                try:
                    timing.append((float(parts[0]), float(parts[1])))
                except ValueError:
                    unparsable.append(line)
            else:
                unparsable.append(line)
        elif sec == '[HitObjects]':
            parts = line.split(',')
            try:
                x, y, t, obj_type = int(parts[0]), int(parts[1]), int(parts[2]), int(parts[3])
                hit_sound = int(parts[4])
            except (ValueError, IndexError):
                unparsable.append(line)
                continue
            end = None
            sample = ''
            if (obj_type & 128 or obj_type & 8) and len(parts) > 5:
                end_str, _, sample = parts[5].partition(':')
                try:
                    end = int(end_str)
                except ValueError:
                    unparsable.append(line)
                    continue
            elif len(parts) > 5:
                sample = parts[5]
            objects.append({'x': x, 'y': y, 't': t, 'type': obj_type,
                            'hit_sound': hit_sound, 'end': end, 'sample': sample})
            notes += 1
            last_ms = max(last_ms, t)
            times.append(t)
            if obj_type & 128:
                ln += 1
                if end is not None:
                    ln_ends.append(end)
                    last_ms = max(last_ms, end)
    tags = meta.get('Tags', '').split()
    return {'meta': meta, 'general': general, 'events': events, 'colours': colours,
            'timing': timing, 'objects': objects, 'invisible': invisible,
            'unparsable': unparsable, 'tags': tags,
            'notes': notes, 'ln': ln, 'last_ms': last_ms,
            'times': times, 'ln_ends': ln_ends}


def mp3_duration(path: pathlib.Path) -> float | None:
    """MP3 の再生時間（秒）。依存なしでフレームを走査する。読めなければ None。"""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    start = 0
    if data[:3] == b'ID3' and len(data) > 10:
        size = ((data[6] & 0x7F) << 21 | (data[7] & 0x7F) << 14
                | (data[8] & 0x7F) << 7 | (data[9] & 0x7F))
        start = min(10 + size, len(data))
    end = len(data) - 128 if data[-128:-125] == b'TAG' else len(data)
    rate_tab = {3: (44100, 48000, 32000), 2: (22050, 24000, 16000),
                0: (11025, 12000, 8000)}
    rate_idx_tab = {3: (0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0),
                    2: (0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0)}
    total = 0.0
    i = start
    while i + 4 <= end:
        if data[i] != 0xFF or (data[i + 1] & 0xE0) != 0xE0:
            i += 1
            continue
        ver = (data[i + 1] >> 3) & 0x3
        layer = (data[i + 1] >> 1) & 0x3
        if ver == 1 or layer != 1 or ver not in rate_tab:
            i += 1
            continue
        br_idx = (data[i + 2] >> 4) & 0xF
        sr_idx = (data[i + 2] >> 2) & 0x3
        padding = (data[i + 2] >> 1) & 0x1
        if br_idx in (0, 15) or sr_idx == 3:
            i += 1
            continue
        kbps = rate_idx_tab[3 if ver == 3 else 2][br_idx]
        sr = rate_tab[ver][sr_idx]
        samples = 1152 if ver == 3 else 576
        frame_len = int(samples / 8 * kbps * 1000 / sr) + padding
        if frame_len <= 4 or i + frame_len > end:
            i += 1
            continue
        total += samples / sr
        i += frame_len
    return total if total > 0 else None


def to_2x_osu(text: str, version: str, audio_2x: str) -> str:
    out: list[str] = []
    sec = ''
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('[') and stripped.endswith(']'):
            sec = stripped
            out.append(line)
            continue

        # BPM（赤線）より前に緑線を挿入しない。
        # stable の mania には「最初の制御点が timing change でない」と
        # プレイ開始時に無限ループする既知の不具合がある（stable-issues #1315/#1316）。
        # SV は各赤線の直後だけに置く。音源・ノーツ時刻は変えない。

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
                if float(parts[1]) > 0:
                    # BPM 行。時間だけでなく beatLength も半分にして BPM 表示を
                    # 実際の速さ（2倍）に合わせる。
                    # 以前は直後に SV 0.5 の緑線を置いて BPM×SV を 1倍速と同じに
                    # していたが、Fixed スクロールでは SV のみが効くため 1/2 になる
                    # 不具合があった。現在は SV=1.0 でスクロールを 1倍速と同じに
                    # する（BPM scale では 2倍速になる）。
                    parts[1] = repr(float(parts[1]) / 2)
                    out.append(','.join(parts))
                    # 継承（緑）行: SV_2X (=1.0) を置く。1.0 の場合は -100 だが、
                    # 明示的に置いておくことで意図を明確にする。
                    green = list(parts)
                    green[1] = _sv_line_value()
                    while len(green) < 7:
                        green.append('0')
                    green[6] = '0'      # inherited
                    out.append(','.join(green))
                    continue
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


# ---------------------------------------------------------------- 2x audio

def _chunk_start(chunk, full) -> int:
    """`chunk` が `full` のどの位置から始まるか（サンプル数）を相互相関で求める。

    添字 k は「chunk[0] が full[k] に対応する」という意味。負のラグ（chunk が
    full より前に始まる）は想定していない。
    """
    import numpy
    a = numpy.asarray(full, dtype='float64')
    v = numpy.asarray(chunk, dtype='float64')
    a = a - a.mean()
    v = v - v.mean()
    n = 1 << (len(a) + len(v) - 1).bit_length()
    c = numpy.fft.irfft(numpy.fft.rfft(a, n) * numpy.conj(numpy.fft.rfft(v, n)), n)
    return int(numpy.argmax(c[: max(1, len(a) - len(v) + 1)]))


def _encode_mp3(numpy, lameenc, data, sr: int, channels: int, kbps: int) -> bytes:
    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(sr)
    enc.set_channels(channels)
    enc.set_quality(2)
    return enc.encode(data.tobytes()) + enc.flush()


def make_2x_audio(src: pathlib.Path, dst: pathlib.Path, log=print) -> None:
    """<song>.mp3 を 2倍速（全時間が半分）にした <song> (2x).mp3 を作る。

    1x 音源は「デコードした波形」を基準に、1サンプルおきに間引いたものを
    2x 音源とする（= 再生速度 2.0x と同じ音）。このとき MP3 符号化器は
    先頭に約1100サンプル（48kHz で 23ms）の遅延を挿入するため、その分を
    先に削ってから符号化する。遅延量は固定値ではなくプローブ符号化で実測し、
    最後にデコードし直して一致を検証する（ズレたまま出荷しない）。
    """
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
    channels = data.shape[1]

    fast = numpy.ascontiguousarray(data[::2])
    kbps = min(MP3_BITRATES, key=lambda b: abs(b - src.stat().st_size * 8 / dur / 1000))

    # 1) 符号化器の遅延を実測（無音でない1秒区間を使う）
    win = int(sr)
    probe_at = min(int(sr * 2), max(0, len(fast) - win))
    probe = numpy.ascontiguousarray(fast[probe_at:probe_at + win])
    probe_mono = probe.mean(axis=1)
    back, back_sr = soundfile.read(
        io.BytesIO(_encode_mp3(numpy, lameenc, probe, sr, channels, kbps)), dtype='int16')
    back_mono = numpy.asarray(back, dtype='int16').mean(axis=1)
    delay = max(0, _chunk_start(probe_mono, back_mono))

    # 2) 遅延ぶん先頭を削って本符号化（デコーダ出力が間引き波形と一致する）
    mp3 = _encode_mp3(numpy, lameenc, numpy.ascontiguousarray(fast[delay:]), sr,
                      channels, kbps)
    dst.write_bytes(mp3)

    # 3) 検証: デコードし直して「1倍速音源を2サンプルずつ間引いた波形」と
    #    同じ時刻に来ているか（±2サンプル）。曲の途中の独立した3区間で確かめる。
    check, sr2 = soundfile.read(io.BytesIO(mp3), dtype='int16')
    got = numpy.asarray(check, dtype='int16').mean(axis=1)
    want = numpy.asarray(fast, dtype='int16').mean(axis=1)
    span = int(sr * 3)
    lags = []
    for frac in (0.08, 0.5, 0.85):
        off = min(int(len(want) * frac), max(0, len(want) - span))
        lags.append(_chunk_start(want[off:off + span], got) - off)
    lag = max(lags, key=abs)
    got_dur = len(got) / sr2
    if abs(got_dur - dur / 2) > 0.5:
        raise SystemExit(f'2倍速音源の長さが不正です: {got_dur:.2f}s (期待値 {dur / 2:.2f}s)')
    if abs(lag) > 2:
        raise SystemExit(
            f'2倍速音源が 1倍速音源とずれています: {lags} サンプル '
            f'({lag / sr * 1000:+.1f}ms)'
        )
    log(f'  2x audio: {src.name} ({dur:.1f}s, {kbps}kbps) → {dst.name} '
        f'({got_dur:.1f}s, 符号化遅延 {delay} サンプル補正, ズレ {lag} サンプル)')


# ---------------------------------------------------------------- zip

def write_zip(out_path: pathlib.Path, entries: list[tuple[str, bytes]]) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arcname, data in entries:
            info = zipfile.ZipInfo(arcname, date_time=time.localtime()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)


# ---------------------------------------------------------------- validation

def check(info: dict, version: str, names_in_zip: set[str], audio: str,
          bg: str, keys: int = 4, audio_ms: float | None = None) -> None:
    meta, general = info['meta'], info['general']
    errors: list[str] = []
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

    # --- ここから「osu! で壊れる/不快になる」不備の検出 ---
    if not info['timing'] or info['timing'][0][1] <= 0:
        errors.append('[TimingPoints] の先頭は正の beatLength の BPM 行にしてください'
                      '（先頭の緑線は osu!stable mania の無限ロードを起こし得ます）')
    if info['invisible']:
        shown = ', '.join(sorted({c for _, c in info['invisible']})[:5])
        errors.append(f'不可視文字・制御文字が混ざっています ({shown})'
                      ' → tools/normalize_osu.py で除去してください')
    if info['unparsable']:
        errors.append(f'解釈できない行があります: {info["unparsable"][:3]}')
    for key in info['colours']:
        if key not in COLOUR_KEYS:
            errors.append(f'[Colours] のキー {key!r} は osu! が無視します'
                          f'（Combo0-8 / SliderTrackOverride / SliderBorder のみ）')
    objects, seen = info['objects'], set()
    lane_x = {c: int((c + 0.5) * 512 / keys) for c in range(keys)}
    ln_span = {c: [] for c in range(keys)}
    for o in objects:
        lane = o['x'] * keys // 512
        if not 0 <= o['x'] < 512 or not 0 <= o['y'] <= 384:
            errors.append(f'座標が範囲外です: x={o["x"]} y={o["y"]} @ {o["t"]}ms')
        elif o['x'] != lane_x.get(lane) or o['y'] != 192:
            errors.append(f'x={o["x"]} y={o["y"]} は {keys}K のレーン中央ではありません @ {o["t"]}ms')
        if o['type'] not in (1, 128):
            errors.append(f'type={o["type"]} は非対応です（ノーツ=1 / LN=128）@ {o["t"]}ms')
        if o['hit_sound'] != 0 or o['sample'] != SAMPLE:
            errors.append(f'打鍵音が統一されていません (hitSound={o["hit_sound"]}, '
                          f'sample={o["sample"]!r}) @ {o["t"]}ms'
                          ' → tools/normalize_osu.py で統一してください')
        if (lane, o['t']) in seen:
            errors.append(f'同じレーン・同時刻のノーツが重複しています: lane={lane} @ {o["t"]}ms')
        seen.add((lane, o['t']))
        if o['t'] < 0:
            errors.append(f'時刻が負のノーツがあります: {o["t"]}ms')
        if o['type'] & 128:
            if o['end'] is None or o['end'] <= o['t']:
                errors.append(f'LN の終端が不正です: {o["t"]} → {o["end"]}')
            prev = ln_span[lane][-1] if ln_span[lane] else 0
            if prev > o['t']:
                errors.append(f'同じレーンで LN が重なっています: 終端 {prev} > 始端 {o["t"]}ms')
            ln_span[lane].append(o['end'] or o['t'])
    if info['notes'] == 0:
        errors.append('HitObjects が 0 件です')
    if not any(bl > 0 for _, bl in info['timing']):
        errors.append('[TimingPoints] に BPM（正の beatLength）がありません')
    for (t1, _), (t2, _) in zip(info['timing'], info['timing'][1:]):
        if t2 < t1:
            errors.append(f'[TimingPoints] の時刻が昇順ではありません: {t1} → {t2}')
    if audio_ms is not None:
        if info['last_ms'] > audio_ms + 50:
            errors.append(f'音源の長さ {audio_ms:.0f}ms を超えるノーツがあります: '
                          f'最後のノーツ/LN終端 {info["last_ms"]}ms')
        preview = general.get('PreviewTime')
        if preview:
            try:
                if not 0 <= int(preview) <= audio_ms:
                    errors.append(f'PreviewTime={preview} が音源の範囲外です')
            except ValueError:
                errors.append(f'PreviewTime={preview!r} が数値ではありません')
    if 'mapperatorinator' in {t.lower() for t in info['tags']}:
        print(f'  ! [{version}] Tags に生成ツール名 (mapperatorinator) が残っています')
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


def loose_key(name: str) -> str:
    """句読点・記号・空白を無視した比較キー。

    ファイル名の並べ替えがカルチャ依存（'.' や '（）' を無視する比較）でも
    1倍速が先に並ぶことを確かめるために使う。
    """
    return ''.join(c for c in name
                   if unicodedata.category(c)[0] not in ('P', 'S', 'Z')).lower()


def archive_name(song_key: str) -> str:
    """出力ファイル名（1曲 = 1ファイル、1倍速と2倍速の全譜面入り）。"""
    return f'{song_key}.osz'


def build_song(song_key: str, keep_audio: bool = False,
               output: pathlib.Path | None = None, force_audio: bool = False) -> dict:
    """1曲ぶんの .osz（1倍速3譜面 + 2倍速3譜面 + 音源2つ）を作る。

    各譜面は [General] の AudioFilename で自分の速度の音源を指す。
    1倍速のファイル名が 2倍速より先に並ぶようにしてある（osu! がセットの曲として
    使う音源が 2倍速＝半分の長さにならないように。モジュール docstring 参照）。
    """
    cfg = SONGS[song_key]
    song_dir = ROOT / 'songs' / cfg['dir']
    keys = cfg['keys']
    audio_1x, audio_2x = cfg['audio'], cfg['audio_2x']
    bg, suffix_2x = cfg['bg'], cfg['suffix_2x']
    output = pathlib.Path(output) if output else ROOT / archive_name(song_key)

    for name in (audio_1x, audio_2x, bg, *(src for src, _ in cfg['diffs'])):
        if not (song_dir / name).is_file():
            raise SystemExit(f'必要なファイルがありません: {song_dir / name}')

    # 2倍速音源（1倍速を2サンプルずつ間引いたもの=速度+ピッチが Web の 2.0x と同じ）
    audio_2x_path = song_dir / audio_2x
    if keep_audio or (not force_audio
                      and not _audio_needs_build(audio_2x_path, song_dir / audio_1x)):
        print(f'  2x audio: 既存の {audio_2x} を使用'
              '（1x を更新した場合は --force-audio で作り直してください）')
    else:
        make_2x_audio(song_dir / audio_1x, audio_2x_path)

    durations = {name: mp3_duration(song_dir / name) for name in (audio_1x, audio_2x)}
    for name, dur in durations.items():
        if dur is None:
            print(f'  ! {name} の長さが読めませんでした（音源との突き合わせ検証を省略）')

    entries: list[tuple[str, bytes]] = []
    expected: dict[str, str] = {}      # Version -> その譜面が参照する音源
    summaries: list[str] = []
    chart_files: list[str] = []
    artist = title = None

    def add_charts(speed: int, audio: str, diffs: list[tuple[str, str]]) -> None:
        """難易度ぶんの .osu を entries に足す（speed=2 では時間を半分にしたもの）。"""
        nonlocal artist, title
        audio_ms = durations[audio] * 1000 if durations[audio] else None
        for src, version in diffs:
            text = (song_dir / src).read_text(encoding='utf-8')
            info_1x = parse_osu(text)
            if speed == 2:
                text = to_2x_osu(text, version, audio)
                info = parse_osu(text)
                if (info['notes'], info['ln']) != (info_1x['notes'], info_1x['ln']):
                    raise SystemExit(f'[{version}] ノーツ数が一致しません: '
                                     f'{info["notes"]}/{info["ln"]} vs '
                                     f'{info_1x["notes"]}/{info_1x["ln"]}')
                if (info['times'] != [h2(t) for t in info_1x['times']]
                        or info['ln_ends'] != [h2(t) for t in info_1x['ln_ends']]):
                    raise SystemExit(f'[{version}] ノーツ時間が元の半分になっていません')
                # BPM は2倍（表示を実際の速さに合わせる）+ 各 BPM 行に SV_2X の緑線
                # （Fixed では見た目のスクロール速度を 1倍速に揃える）
                red_1x = [(t, bl) for t, bl in info_1x['timing'] if bl > 0]
                red_2x = [(t, bl) for t, bl in info['timing'] if bl > 0]
                if [(h2(t), bl / 2) for t, bl in red_1x] != red_2x:
                    raise SystemExit(f'[{version}] BPM が 1倍速の2倍になっていません')
                sv_want = -100 / SV_2X
                greens = {t for t, bl in info['timing'] if bl < 0}
                need = {float(t) for t, _ in red_2x}
                if greens != need or any(bl != sv_want
                                         for _, bl in info['timing'] if bl < 0):
                    raise SystemExit(f'[{version}] SV {SV_2X} の緑線が BPM 行に'
                                     f'揃っていません: {sorted(greens)}')
            else:
                info = info_1x
            check(info, version, {audio_1x, audio_2x, bg}, audio, bg, keys, audio_ms)
            meta = info['meta']
            artist = meta.get('ArtistUnicode') or meta.get('Artist', '')
            title = meta.get('TitleUnicode') or meta.get('Title', '')
            arcname = chart_arcname(meta, version)
            entries.append((arcname, text.encode('utf-8')))
            summaries.append(summary_line(version, info, arcname))
            chart_files.append(arcname)
            expected[version] = audio

    # 「1倍速の譜面 → 1倍速の音源 → 背景 → 2倍速の譜面 → 2倍速の音源」の順に入れる
    add_charts(1, audio_1x, list(cfg['diffs']))
    entries.append((audio_1x, (song_dir / audio_1x).read_bytes()))
    entries.append((bg, (song_dir / bg).read_bytes()))
    add_charts(2, audio_2x, [(src, f'{v}{suffix_2x}') for src, v in cfg['diffs']])
    entries.append((audio_2x, (song_dir / audio_2x).read_bytes()))

    write_zip(output, entries)

    # 読み戻し検証
    with zipfile.ZipFile(output) as zf:
        bad = zf.testzip()
        assert bad is None, f'zip が壊れています: {bad}'
        names = set(zf.namelist())
        charts: dict[str, str] = {}    # .osu ファイル名 -> 参照している音源
        for name in sorted(names):
            if not name.endswith('.osu'):
                continue
            if '/' in name:
                raise SystemExit(f'.osz 内にフォルダがあります: {name}（フラット構成にしてください）')
            info3 = parse_osu(zf.read(name).decode('utf-8'))
            version3 = info3['meta']['Version']
            audio3 = info3['general']['AudioFilename']
            audio_ms = durations[audio3] * 1000 if durations.get(audio3) else None
            check(info3, version3, names, expected[version3], bg, keys, audio_ms)
            charts[name] = audio3
        assert set(expected) == {parse_osu(zf.read(n).decode('utf-8'))['meta']['Version']
                                 for n in names if n.endswith('.osu')}, \
            f'期待された難易度: {set(expected)}'

        # 音源は2つ。1倍速のものが先に並ぶこと（osu! はセットの曲情報に
        # 「先に並ぶ音源」を使うため、逆になると 1倍速が半分の長さになる）
        audios = sorted(n for n in names
                        if n.lower().endswith(('.mp3', '.ogg', '.wav', '.m4a', '.flac')))
        if audios != sorted([audio_1x, audio_2x]):
            raise SystemExit(f'.osz 内の音源が想定と違います: {audios} '
                             f'（{audio_1x} と {audio_2x} のはず）')
        if audios[0] != audio_1x:
            raise SystemExit(f'音源の並び順が逆です: {audios} '
                             f'（1倍速 {audio_1x} が先に並ぶ必要があります）')

        # 各譜面が自分の速度の音源を指しているか / 1倍速の譜面名が先に並ぶか
        x1 = sorted(n for n, a in charts.items() if a == audio_1x)
        x2 = sorted(n for n, a in charts.items() if a == audio_2x)
        if len(x1) != len(cfg['diffs']) or len(x2) != len(cfg['diffs']):
            raise SystemExit(f'譜面の音源の割り当てが不正です: 1倍速 {x1} / 2倍速 {x2}')
        # 最初に並ぶ譜面が 1倍速を参照しているか（osu! はセットの曲情報を
        # 「最初の譜面が参照する音源」から取ることがある）
        first_chart = min(charts)
        if charts[first_chart] != audio_1x:
            raise SystemExit(f'最初に並ぶ譜面が2倍速の音源を参照しています: {first_chart}')
        if not loose_key(audio_1x) < loose_key(audio_2x):
            raise SystemExit('音源の並び順が逆です（記号を無視した比較でも 1倍速が先に'
                             f'並ぶ必要があります）: {[audio_1x, audio_2x]}')
        # 「Easy」より「Easy（x2）」が後に並ぶか（同難易度の1倍速/2倍速の並び）
        for name, audio in charts.items():
            if audio != audio_2x:
                continue
            twin = name.replace(f'{suffix_2x}]', ']')
            if twin not in charts:
                continue
            if not twin < name:
                raise SystemExit(f'譜面ファイルの並び順が逆です: {name} が {twin} より前に並びます')
            if not loose_key(twin) < loose_key(name):
                raise SystemExit(f'譜面ファイルの並び順が逆です（記号を無視した比較）: '
                                 f'{name} が {twin} より前に並びます')

    size_mb = output.stat().st_size / 1_000_000
    print(f'{title} / {artist} — 1倍速 + 2倍速 {len(cfg["diffs"]) * 2}譜面の .osz を作成しました')
    print('\n'.join(summaries))
    print(f'  + audio: {audio_1x} (1倍速) / {audio_2x} (2倍速) / background: {bg}')
    print(f'-> {output} ({size_mb:.2f} MB, {len(entries)} files)')
    return {'entries': entries, 'chart_files': chart_files, 'summary': summaries,
            'versions': expected, 'size': output.stat().st_size, 'output': output,
            'audio': audio_1x, 'audio_2x': audio_2x}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--song', type=str, choices=list(SONGS.keys()),
                    help='ビルドする曲を指定 (省略時は全曲)')
    ap.add_argument('--output', type=pathlib.Path,
                    help='出力先 .osz (--song を指定したときのみ)')
    ap.add_argument('--keep-audio', action='store_true',
                    help='2倍速音源を再生成せず既存のものを使う')
    ap.add_argument('--force-audio', action='store_true',
                    help='2倍速音源を必ず作り直す（符号化設定を変えたときなど）')
    args = ap.parse_args()

    keys = [args.song] if args.song else list(SONGS.keys())
    if args.output and len(keys) > 1:
        raise SystemExit('--output は --song を指定したときのみ使えます')

    for key in keys:
        build_song(key, keep_audio=args.keep_audio,
                   output=args.output, force_audio=args.force_audio)
        print()

    print('ビルドが完了しました。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
