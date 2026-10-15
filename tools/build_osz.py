#!/usr/bin/env python3
"""Build `shitsurengo.osz` / `shitsurengo_2x.osz` (osu! beatmapset archives).

An .osz is just a zip. Archives are built flat (no enclosing folder) so that
osu! stable / osu!lazer can import them by double-click or drag & drop:

    櫻優 - 失恋後 (Rikudo-ren) [Easy].osu
    櫻優 - 失恋後 (Rikudo-ren) [Normal].osu
    櫻優 - 失恋後 (Rikudo-ren) [Hard].osu
    失恋後.mp3            <- referenced by AudioFilename: in every .osu
    サムネイル.png        <- referenced by the background event in every .osu

The 2x archive additionally contains sped-up versions of everything:

    櫻優 - 失恋後 (Rikudo-ren) [Easy (2x)].osu   (all times halved)
    ... / [Normal (2x)] / [Hard (2x)]
    失恋後 (2x).mp3       <- audio decimated to 2x (speed + pitch, = Web版 2.0x)
    サムネイル.png

The .osu files in `songs/失恋後/` are packaged verbatim (they are shared with
the web game); the 2x charts are derived from them by halving every time
value (notes, LN ends, timing points, preview time, bookmarks). The 2x audio
is derived by keeping every 2nd PCM frame — exactly what the web game's
`playbackRate = 2` sounds like.
Re-run this script after editing a chart, then commit the new .osz files.

Usage:  python3 tools/build_osz.py [--output path/to/file.osz]
                                   [--output-2x path/to/file_2x.osz]
                                   [--keep-audio]

The 2x audio needs `pip install soundfile numpy lameenc` when (re)generating.
If that is not installed, the script reuses the committed
`songs/失恋後/失恋後 (2x).mp3` when present (pass --keep-audio to force this).
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
SONG_DIR = ROOT / "songs" / "失恋後"

# (source file, difficulty name) — order is also the order inside the .osz
DIFFS = [
    ("easy.osu", "Easy"),
    ("normal.osu", "Normal"),
    ("hard.osu", "Hard"),
]
AUDIO = "失恋後.mp3"            # must match AudioFilename: in the .osu files
BACKGROUND = "サムネイル.png"   # must match the [Events] background event

AUDIO_2X = "失恋後 (2x).mp3"    # AudioFilename inside the 2x .osz (and cache name)
SUFFIX_2X = "(2x)"              # appended to each difficulty Version:

# valid MPEG-1 Layer III bitrates (kbps) — snap the detected source rate to one of these
MP3_BITRATES = (32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320)


def h2(t: int) -> int:
    """Halve a beatmap time in ms (round to nearest, ±0.5ms is inaudible)."""
    return round(t / 2)


def parse_osu(text: str) -> dict:
    """Minimal .osu reader used only to validate what we package."""
    meta: dict[str, str] = {}
    general: dict[str, str] = {}
    events: list[str] = []
    times: list[int] = []
    ln_ends: list[int] = []
    notes = ln = 0
    last_ms = 0
    sec = ""
    for raw in text.splitlines():
        line = raw.strip()
        if line.startswith("[") and line.endswith("]"):
            sec = line
            continue
        if not line or line.startswith("//"):
            continue
        if sec in ("[Metadata]", "[General]") and ":" in line:
            key, val = line.split(":", 1)
            (meta if sec == "[Metadata]" else general)[key.strip()] = val.strip()
        elif sec == "[Events]":
            events.append(line)
        elif sec == "[HitObjects]":
            parts = line.split(",")
            t = int(parts[2])
            notes += 1
            last_ms = max(last_ms, t)
            times.append(t)
            if int(parts[3]) & 128:
                ln += 1
                end = int(parts[5].split(":")[0])
                ln_ends.append(end)
                last_ms = max(last_ms, end)
    return {"meta": meta, "general": general, "events": events,
            "notes": notes, "ln": ln, "last_ms": last_ms,
            "times": times, "ln_ends": ln_ends}


def to_2x_osu(text: str, version: str) -> str:
    """Return a copy of `text` where every beatmap time is halved.

    - [General]   AudioFilename -> AUDIO_2X, PreviewTime / AudioLeadIn halved
    - [Editor]    Bookmarks halved
    - [Metadata]  Version -> `version`, Tags += "2x"
    - [TimingPoints] time (1st field) halved
    - [HitObjects]   time halved; LN / spinner end time halved
    Notes' x/y (lane / row), BPM (beat length) and hitsounds stay untouched,
    so the chart is the original one sped up 2x.
    """
    out: list[str] = []
    sec = ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("[") and stripped.endswith("]"):
            sec = stripped
            out.append(line)
            continue

        if sec == "[General]":
            m = re.match(r"(AudioFilename)\s*:\s*(.*?)\s*$", line)
            if m:
                out.append(f"AudioFilename: {AUDIO_2X}")
                continue
            m = re.match(r"(PreviewTime|AudioLeadIn)\s*:\s*(-?\d+)\s*$", line)
            if m:
                out.append(f"{m.group(1)}: {h2(int(m.group(2)))}")
                continue

        elif sec == "[Editor]":
            m = re.match(r"(Bookmarks)\s*:\s*(.*)$", line)
            if m:
                marks = ",".join(str(h2(int(b)))
                                 for b in m.group(2).split(",") if b.strip())
                out.append(f"Bookmarks:{marks}")
                continue

        elif sec == "[Metadata]":
            m = re.match(r"(Version)\s*:\s*(.*?)\s*$", line)
            if m:
                out.append(f"Version:{version}")
                continue
            m = re.match(r"(Tags)\s*:\s*(.*?)\s*$", line)
            if m:
                tags = m.group(2).split()
                if "2x" not in tags:
                    tags.append("2x")
                out.append("Tags:" + " ".join(tags))
                continue

        elif sec == "[TimingPoints]":
            parts = line.split(",")
            if len(parts) >= 2:
                parts[0] = str(h2(float(parts[0])))
                out.append(",".join(parts))
                continue

        elif sec == "[HitObjects]":
            parts = line.split(",")
            if len(parts) >= 5:
                parts[2] = str(h2(int(parts[2])))
                obj_type = int(parts[3])
                # hold note (128): endTime sits before ':' in the last field
                # spinner (8): last field is the bare end time
                if obj_type & 128 or obj_type & 8:
                    if ":" in parts[5]:
                        end, rest = parts[5].split(":", 1)
                        parts[5] = f"{h2(int(end))}:{rest}"
                    else:
                        parts[5] = str(h2(int(parts[5])))
                out.append(",".join(parts))
                continue

        out.append(line)
    return "\n".join(out) + "\n"


def make_2x_audio(src: pathlib.Path, dst: pathlib.Path) -> None:
    """Create a 2x-speed mp3: keep every 2nd PCM frame, re-encode.

    Keeping every 2nd sample at the same sample rate doubles the playback
    speed and raises the pitch one octave — identical to the web game's
    `playbackRate = 2`. Needs soundfile + numpy + lameenc.
    """
    try:
        import lameenc
        import numpy
        import soundfile
    except ImportError as e:
        raise SystemExit(
            "2倍速音源の生成には次のパッケージが必要です:\n"
            "  pip install soundfile numpy lameenc\n"
            f"({e})\n"
            "無印の音源を再生成せず、既存の "
            f"{dst.name} を使う場合は --keep-audio を付けてください。"
        ) from e

    data, sr = soundfile.read(str(src), dtype="int16")
    if data.ndim == 1:
        data = data.reshape(-1, 1)
    dur = data.shape[0] / sr

    fast = numpy.ascontiguousarray(data[::2])
    kbps = min(MP3_BITRATES, key=lambda b: abs(b - src.stat().st_size * 8 / dur / 1000))
    enc = lameenc.Encoder()
    enc.set_bit_rate(kbps)
    enc.set_in_sample_rate(sr)
    enc.set_channels(data.shape[1])
    enc.set_quality(2)  # 2 = high
    mp3 = enc.encode(fast.tobytes()) + enc.flush()
    dst.write_bytes(mp3)

    # 書き出した mp3 を読み直して、長さが半分になっているか確認する
    check, sr2 = soundfile.read(io.BytesIO(mp3), dtype="int16")
    got = check.shape[0] / sr2
    if abs(got - dur / 2) > 0.5:
        raise SystemExit(f"2倍速音源の長さが不正です: {got:.2f}s (期待値 {dur / 2:.2f}s)")
    print(f"  2x audio: {src.name} ({dur:.1f}s, {kbps}kbps) → "
          f"{dst.name} ({got:.1f}s)")


def write_zip(out_path: pathlib.Path, entries: list[tuple[str, bytes]]) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arcname, data in entries:
            info = zipfile.ZipInfo(arcname, date_time=time.localtime()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)


def reread_validate(out_path: pathlib.Path, entries: list[tuple[str, bytes]],
                    expected_versions: set[str], audio: str) -> set[str]:
    """Read the archive back, re-check every chart, return the file names."""
    with zipfile.ZipFile(out_path) as zf:
        bad = zf.testzip()
        assert bad is None, f"zip が壊れています: {bad}"
        names = zf.namelist()
        assert len(names) == len(entries) == len(DIFFS) + 2, names
        versions = set()
        for name in names:
            if name.endswith(".osu"):
                info = parse_osu(zf.read(name).decode("utf-8"))
                versions.add(info["meta"]["Version"])
                check(info, info["meta"]["Version"], set(names), audio)
        assert versions == expected_versions, versions
    return names


def check(info: dict, version: str, names_in_zip: set[str], audio: str) -> None:
    meta, general = info["meta"], info["general"]
    errors = []
    if general.get("Mode") != "3":
        errors.append(f"Mode は 3 (osu!mania) でなければなりません: {general.get('Mode')!r}")
    if general.get("AudioFilename") != audio:
        errors.append(f"AudioFilename は {audio} のはずです: {general.get('AudioFilename')!r}")
    if general.get("AudioFilename") not in names_in_zip:
        errors.append(f"AudioFilename が .osz 内にありません: {general.get('AudioFilename')!r}")
    bg = next((e for e in info["events"] if e.startswith("0,0,")), None)
    if bg is None or BACKGROUND not in bg:
        errors.append(f"[Events] に背景 {BACKGROUND} の指定がありません")
    if meta.get("Version") != version:
        errors.append(f"Version は {version} のはずです: {meta.get('Version')!r}")
    for key in ("Title", "TitleUnicode", "Artist", "ArtistUnicode", "Creator"):
        if not meta.get(key) or meta[key].startswith("Unknown"):
            errors.append(f"[Metadata] {key} が未設定です: {meta.get(key)!r}")
    if info["notes"] == 0:
        errors.append("HitObjects が 0 件です")
    if errors:
        raise SystemExit(f"[{version}] 検証エラー:\n  - " + "\n  - ".join(errors))


def chart_arcname(meta: dict, version: str) -> str:
    artist = meta["ArtistUnicode"] or meta["Artist"]
    title = meta["TitleUnicode"] or meta["Title"]
    # osu! のファイル名規約: Artist - Title (Creator) [Version].osu
    return f"{artist} - {title} ({meta['Creator']}) [{version}].osu"


def summary_line(version: str, info: dict, arcname: str) -> str:
    mm, ss = divmod(info["last_ms"] // 1000, 60)
    return (f"  [{version:9}] {info['notes']:5} notes (LN {info['ln']:3})  "
            f"~{mm}:{ss:02d}  {arcname}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=pathlib.Path,
                    default=ROOT / "shitsurengo.osz",
                    help="出力先 .osz (既定: リポジトリ直下の shitsurengo.osz)")
    ap.add_argument("--output-2x", type=pathlib.Path, default=None,
                    help="2倍速版の出力先 (既定: <output> の隣の *_2x.osz)")
    ap.add_argument("--keep-audio", action="store_true",
                    help="2倍速音源を再生成せず既存のものを使う")
    args = ap.parse_args()
    out2x_path = args.output_2x or args.output.with_name(args.output.stem + "_2x.osz")

    for name in (AUDIO, BACKGROUND, *(src for src, _ in DIFFS)):
        if not (SONG_DIR / name).is_file():
            raise SystemExit(f"必要なファイルがありません: {SONG_DIR / name}")

    # ---- 元譜面を読んで検証しつつ、通常版と 2x 版の両方のエントリを作る ----
    entries: list[tuple[str, bytes]] = []
    entries_2x: list[tuple[str, bytes]] = []
    originals: list[dict] = []      # parsed originals, same order as DIFFS
    summaries: list[str] = []
    summaries_2x: list[str] = []
    artist = title = None

    for src, version in DIFFS:
        text = (SONG_DIR / src).read_text(encoding="utf-8")
        info = parse_osu(text)
        check(info, version, {AUDIO, BACKGROUND}, AUDIO)
        meta = info["meta"]
        artist = meta["ArtistUnicode"] or meta["Artist"]
        title = meta["TitleUnicode"] or meta["Title"]
        originals.append(info)

        arcname = chart_arcname(meta, version)
        entries.append((arcname, text.encode("utf-8")))
        summaries.append(summary_line(version, info, arcname))

        # 2x 版: 全時間を半分にした譜面
        version_2x = f"{version} {SUFFIX_2X}"
        text_2x = to_2x_osu(text, version_2x)
        info_2x = parse_osu(text_2x)
        check(info_2x, version_2x, {AUDIO_2X, BACKGROUND}, AUDIO_2X)
        # ノーツ数・LN数・時間の対応を検証（全部半分になっていること）
        if (info_2x["notes"], info_2x["ln"]) != (info["notes"], info["ln"]):
            raise SystemExit(f"[{version_2x}] ノーツ数が一致しません: "
                             f"{info_2x['notes']}/{info_2x['ln']} vs "
                             f"{info['notes']}/{info['ln']}")
        if (info_2x["times"] != [h2(t) for t in info["times"]]
                or info_2x["ln_ends"] != [h2(t) for t in info["ln_ends"]]):
            raise SystemExit(f"[{version_2x}] ノーツ時間が元の半分になっていません")
        arcname_2x = chart_arcname(meta, version_2x)
        entries_2x.append((arcname_2x, text_2x.encode("utf-8")))
        summaries_2x.append(summary_line(version_2x, info_2x, arcname_2x))

    entries.append((AUDIO, (SONG_DIR / AUDIO).read_bytes()))
    entries.append((BACKGROUND, (SONG_DIR / BACKGROUND).read_bytes()))

    # ---- 2x 音源（キャッシュがあれば再生成を省略できる）----
    audio_2x_path = SONG_DIR / AUDIO_2X
    if args.keep_audio or not _audio_needs_build(audio_2x_path):
        if not audio_2x_path.is_file():
            raise SystemExit(
                f"2倍速音源がありません: {audio_2x_path}\n"
                "  pip install soundfile numpy lameenc のうえ、--keep-audio を外して再実行してください。"
            )
        print(f"  2x audio: 既存の {AUDIO_2X} を使用")
    else:
        make_2x_audio(SONG_DIR / AUDIO, audio_2x_path)
    entries_2x.append((AUDIO_2X, audio_2x_path.read_bytes()))
    entries_2x.append((BACKGROUND, (SONG_DIR / BACKGROUND).read_bytes()))

    # ---- 書き出し + 読み戻し検証 ----
    write_zip(args.output, entries)
    reread_validate(args.output, entries,
                    {v for _, v in DIFFS}, AUDIO)

    write_zip(out2x_path, entries_2x)
    reread_validate(out2x_path, entries_2x,
                    {f"{v} {SUFFIX_2X}" for _, v in DIFFS}, AUDIO_2X)

    size_mb = args.output.stat().st_size / 1_000_000
    size_2x_mb = out2x_path.stat().st_size / 1_000_000
    print(f"{title} / {artist} — {len(DIFFS)}譜面入りの .osz を2種類作成しました")
    print("— 通常版: " + str(args.output.name))
    print("\n".join(summaries))
    print(f"  + audio: {AUDIO} / background: {BACKGROUND}")
    print(f"-> {args.output} ({size_mb:.2f} MB, {len(entries)} files)")
    print("— 2倍速版: " + str(out2x_path.name))
    print("\n".join(summaries_2x))
    print(f"  + audio: {AUDIO_2X} / background: {BACKGROUND}")
    print(f"-> {out2x_path} ({size_2x_mb:.2f} MB, {len(entries_2x)} files)")
    print("osu! / osu!lazer にドロップするか、ダブルクリックでインポートできます。")
    return 0


def _audio_needs_build(audio_2x_path: pathlib.Path) -> bool:
    """音源の再生成が必要かどうか。--keep-audio 相当の既定挙動:

    - 2x 音源がまだ無い → 生成が必要（依存が無ければ明確なエラー）
    - 2x 音源より元 mp3 が新しい → 元曲が更新されているので再生成が必要
    - それ以外（依存が無い環境・変更無し） → 既存のものを使う
    """
    if not audio_2x_path.is_file():
        return True
    src = SONG_DIR / AUDIO
    # 60秒のマージン: git checkout 直後は全ファイルの mtime がほぼ同じになるため、
    # 順序の揺れで不用意に再生成が走らないようにする
    return src.stat().st_mtime > audio_2x_path.stat().st_mtime + 60


if __name__ == "__main__":
    sys.exit(main())
