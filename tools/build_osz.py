#!/usr/bin/env python3
"""Build `shitsurengo.osz` (osu! beatmapset archive) from `songs/失恋後/`.

An .osz is just a zip. It is built flat (no enclosing folder) so that
osu! stable / osu!lazer can import it by double-click or drag & drop:

    櫻優 - 失恋後 (Rikudo-ren) [Easy].osu
    櫻優 - 失恋後 (Rikudo-ren) [Normal].osu
    櫻優 - 失恋後 (Rikudo-ren) [Hard].osu
    失恋後.mp3            <- referenced by AudioFilename: in every .osu
    サムネイル.png        <- referenced by the background event in every .osu

The .osu files in `songs/失恋後/` are packaged verbatim (they are shared
with the web game), only renamed to the osu! filename convention.
Re-run this script after editing a chart, then commit the new .osz.

Usage:  python3 tools/build_osz.py [--output path/to/file.osz]
"""

from __future__ import annotations

import argparse
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
AUDIO = "失恋後.mp3"       # must match AudioFilename: in the .osu files
BACKGROUND = "サムネイル.png"  # must match the [Events] background event


def parse_osu(text: str) -> dict:
    """Minimal .osu reader used only to validate what we package."""
    meta: dict[str, str] = {}
    general: dict[str, str] = {}
    events: list[str] = []
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
            notes += 1
            last_ms = max(last_ms, int(parts[2]))
            if int(parts[3]) & 128:
                ln += 1
    return {"meta": meta, "general": general, "events": events,
            "notes": notes, "ln": ln, "last_ms": last_ms}


def check(info: dict, version: str, names_in_zip: set[str]) -> None:
    meta, general = info["meta"], info["general"]
    errors = []
    if general.get("Mode") != "3":
        errors.append(f"Mode は 3 (osu!mania) でなければなりません: {general.get('Mode')!r}")
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


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--output", type=pathlib.Path,
                    default=ROOT / "shitsurengo.osz",
                    help="出力先 .osz (既定: リポジトリ直下の shitsurengo.osz)")
    out_path: pathlib.Path = ap.parse_args().output

    for name in (AUDIO, BACKGROUND, *(src for src, _ in DIFFS)):
        if not (SONG_DIR / name).is_file():
            raise SystemExit(f"必要なファイルがありません: {SONG_DIR / name}")

    names_in_zip = {AUDIO, BACKGROUND}
    entries: list[tuple[str, bytes]] = []  # (arcname, data)
    summaries = []
    artist = title = creator = None
    for src, version in DIFFS:
        text = (SONG_DIR / src).read_text(encoding="utf-8")
        info = parse_osu(text)
        check(info, version, names_in_zip)
        meta = info["meta"]
        artist = meta["ArtistUnicode"] or meta["Artist"]
        title = meta["TitleUnicode"] or meta["Title"]
        creator = meta["Creator"]
        # osu! のファイル名規約: Artist - Title (Creator) [Version].osu
        arcname = f"{artist} - {title} ({creator}) [{version}].osu"
        entries.append((arcname, text.encode("utf-8")))
        mm, ss = divmod(info["last_ms"] // 1000, 60)
        summaries.append(
            f"  [{version:6}] {info['notes']:5} notes (LN {info['ln']:3})  "
            f"~{mm}:{ss:02d}  {arcname}"
        )
    entries.append((AUDIO, (SONG_DIR / AUDIO).read_bytes()))
    entries.append((BACKGROUND, (SONG_DIR / BACKGROUND).read_bytes()))

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for arcname, data in entries:
            info = zipfile.ZipInfo(arcname, date_time=time.localtime()[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            zf.writestr(info, data)

    # 書き出した .osz 自体を読み直して最終確認する
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
                check(info, info["meta"]["Version"], set(names))
        assert versions == {v for _, v in DIFFS}, versions

    size_mb = out_path.stat().st_size / 1_000_000
    print(f"{title} / {artist} — {len(DIFFS)}譜面入り .osz を作成しました")
    print("\n".join(summaries))
    print(f"  + audio: {AUDIO} / background: {BACKGROUND}")
    print(f"-> {out_path} ({size_mb:.2f} MB, {len(names)} files)")
    print("osu! / osu!lazer にドロップするか、ダブルクリックでインポートできます。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
