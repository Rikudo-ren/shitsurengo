#!/usr/bin/env python3
"""to_2x_osu（2倍速 .osz 用の譜面変換）の回帰テスト。

実行:  python3 -m unittest tests/test_osz_transform.py
"""
import importlib.util
import pathlib
import unittest

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


if __name__ == "__main__":
    unittest.main()
