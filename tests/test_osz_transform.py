#!/usr/bin/env python3
"""tools/build_osz.py の回帰テスト。

- to_2x_osu: 2倍速譜面への変換（全時間を半分にする）
- build: 1つの .osz に 1倍速 / 2倍速の全譜面が入っていること

実行:  python3 -m unittest tests/test_osz_transform.py
"""
import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent
_spec = importlib.util.spec_from_file_location(
    "build_osz", ROOT / "tools" / "build_osz.py")
build_osz = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_osz)

SAMPLE = """osu file format v14

[General]
AudioFilename: 失恋後.mp3
AudioLeadIn: 0
PreviewTime: 68595
Countdown: 0
Mode: 3

[Editor]
Bookmarks:-330001,1000

[Metadata]
Title:Shitsurengo
Version:Easy
Tags:foo bar

[Events]
//Background and Video events
0,0,"サムネイル.png",0,0

[TimingPoints]
1095,357.14285714285717,4,2,-1,100,1,0

[Colours]
Combo1 : 255,192,0

[HitObjects]
192,192,1095,128,0,1630:2:2:-1:50:
448,192,815,1,0,2:2:-1:50:
"""


class To2xOsuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = build_osz.to_2x_osu(SAMPLE, "Easy (2x)")
        cls.info = build_osz.parse_osu(cls.out)

    def test_audio_and_meta(self):
        self.assertIn("AudioFilename: 失恋後 (2x).mp3", self.out)
        self.assertIn("Version:Easy (2x)", self.out)
        self.assertIn("Tags:foo bar 2x", self.out)
        self.assertIn("Title:Shitsurengo", self.out)  # 曲名は変えない

    def test_general_and_editor_times_halved(self):
        self.assertIn("PreviewTime: 34298", self.out)
        self.assertIn("AudioLeadIn: 0", self.out)
        self.assertIn("Bookmarks:-165000,500", self.out)

    def test_timing_point_halved_beat_length_kept(self):
        self.assertIn("548,357.14285714285717,4,2,-1,100,1,0", self.out)

    def test_notes_halved_with_ln_end(self):
        lines = self.out.split("[HitObjects]")[1].strip().splitlines()
        self.assertEqual(lines[0], "192,192,548,128,0,815:2:2:-1:50:")
        self.assertEqual(lines[1], "448,192,408,1,0,2:2:-1:50:")
        self.assertEqual(self.info["times"], [548, 408])
        self.assertEqual(self.info["ln_ends"], [815])

    def test_untouched_sections(self):
        self.assertIn('0,0,"サムネイル.png",0,0', self.out)  # 背景はそのまま
        self.assertIn("Mode: 3", self.out)                    # mania のまま
        self.assertIn("[Colours]", self.out)                  # その他のセクションも無傷

    def test_note_counts_match_original(self):
        orig = build_osz.parse_osu(SAMPLE)
        self.assertEqual((self.info["notes"], self.info["ln"]),
                         (orig["notes"], orig["ln"]))
        self.assertEqual(self.info["times"],
                         [build_osz.h2(t) for t in orig["times"]])
        self.assertEqual(self.info["ln_ends"],
                         [build_osz.h2(t) for t in orig["ln_ends"]])

    def test_h2_rounding(self):
        self.assertEqual(build_osz.h2(1095), 548)
        self.assertEqual(build_osz.h2(1630), 815)
        self.assertEqual(build_osz.h2(1000), 500)
        self.assertEqual(build_osz.h2(1), 0)  # 0.5ms の端数は丸め（可聴差なし）


class SingleOszTest(unittest.TestCase):
    """1つの .osz に 1倍速の全譜面 + 2倍速の全譜面が同居していること。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = pathlib.Path(cls.tmp.name) / "shitsurengo.osz"
        # 既存の 2倍速 mp3 を使い回す（soundfile / lameenc 不要）
        build_osz.build(cls.out, keep_audio=True)
        cls.names = []
        cls.charts = {}   # Version -> (Metadata, General, HitObjects 情報)
        with zipfile.ZipFile(cls.out) as zf:
            cls.names = zf.namelist()
            for name in cls.names:
                if name.endswith(".osu"):
                    text = zf.read(name).decode("utf-8")
                    info = build_osz.parse_osu(text)
                    cls.charts[info["meta"]["Version"]] = (name, info, text)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_versions_are_all_1x_and_2x(self):
        self.assertEqual(
            set(self.charts),
            {"Easy", "Normal", "Hard", "Easy (2x)", "Normal (2x)", "Hard (2x)"},
        )

    def test_archive_is_flat_with_both_audio_files(self):
        self.assertEqual(
            set(self.names),
            {name for name, _, _ in self.charts.values()}
            | {build_osz.AUDIO, build_osz.AUDIO_2X, build_osz.BACKGROUND},
        )
        for name in self.names:   # フォルダを作らない（ドラッグ&ドロップ用）
            self.assertNotIn("/", name)

    def test_each_chart_points_at_the_matching_audio(self):
        self.assertIn(build_osz.BACKGROUND, self.names)   # 背景は全譜面で共有
        for version, (name, info, _) in self.charts.items():
            audio = info["general"]["AudioFilename"]
            self.assertEqual(audio, build_osz.AUDIO_2X if "2x" in version else build_osz.AUDIO)
            self.assertIn(audio, self.names)              # 参照先が同梱されている
            self.assertIn(build_osz.BACKGROUND, name and info["events"][0])

    def test_charts_are_mapped_by_mamekina(self):
        for version, (_, info, _) in self.charts.items():
            self.assertEqual(info["meta"]["Creator"], "mamekina")
            self.assertEqual(info["meta"]["Version"], version)

    def test_2x_charts_are_the_1x_charts_halved(self):
        for version in ("Easy", "Normal", "Hard"):
            info = self.charts[version][1]
            info_2x = self.charts[f"{version} (2x)"][1]
            self.assertEqual(info_2x["notes"], info["notes"])
            self.assertEqual(info_2x["ln"], info["ln"])
            self.assertEqual(info_2x["times"], [build_osz.h2(t) for t in info["times"]])
            self.assertEqual(info_2x["ln_ends"], [build_osz.h2(t) for t in info["ln_ends"]])

    def test_2x_chart_text_halves_timing_points_only(self):
        _, info, text = self.charts["Hard (2x)"]
        self.assertIn("AudioFilename: " + build_osz.AUDIO_2X, text)
        self.assertIn(f"Version:Hard {build_osz.SUFFIX_2X}", text)
        self.assertIn("2x", info["meta"]["Tags"].split())
        # 2倍速側の譜面は 1倍速側より短い（曲の長さが半分）
        self.assertLess(info["last_ms"], self.charts["Hard"][1]["last_ms"])

    def test_creator_is_validated(self):
        """Creator が空 / Unknown のままだと検証で弾かれること（beatmap by mamekina）。"""
        text = SAMPLE.replace(
            "Title:Shitsurengo\nVersion:Easy\n",
            "Title:Shitsurengo\nTitleUnicode:失恋後\nArtist:櫻優\n"
            "ArtistUnicode:櫻優\nCreator:\nVersion:Easy\n")
        info = build_osz.parse_osu(text)
        with self.assertRaises(SystemExit):
            build_osz.check(info, "Easy", {build_osz.AUDIO}, build_osz.AUDIO)


if __name__ == "__main__":
    unittest.main()
