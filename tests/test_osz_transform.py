#!/usr/bin/env python3
"""tools/build_osz.py / tools/normalize_osu.py の回帰テスト。

- to_2x_osu: 2倍速譜面への変換（全時間を半分にする・打鍵音は触らない）
- build: 1つの .osz に 1倍速 / 2倍速の全譜面が入っていること
- check: osu! で壊れる不備（不可視文字 / 打鍵音のバラつき / 4K として不正なノーツ /
         音源より後ろのノーツ…）を弾けること
- normalize_osu: ノーツデータを変えずに汚れだけ落とすこと（べき等）
- make_2x_audio: 2倍速音源が 1倍速音源の間引き波形とサンプル単位で一致すること
  （soundfile / numpy / lameenc が無い環境では skip）

実行:  python3 -m unittest tests/test_osz_transform.py
"""

import importlib.util
import pathlib
import tempfile
import unittest
import zipfile

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _load(name, rel):
    spec = importlib.util.spec_from_file_location(name, ROOT / rel)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


build_osz = _load("build_osz", "tools/build_osz.py")
normalize_osu = _load("normalize_osu", "tools/normalize_osu.py")

try:
    import lameenc  # noqa: F401
    import numpy  # noqa: F401
    import soundfile  # noqa: F401
    HAS_AUDIO_DEPS = True
except ImportError:
    HAS_AUDIO_DEPS = False

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
TitleUnicode:失恋後
Artist:櫻優
ArtistUnicode:櫻優
Creator:mamekina
Version:Easy
Tags:foo bar mapperatorinator

[Events]
//Background and Video events
0,0,"サムネイル.png",0,0

[TimingPoints]
1095,357.14285714285717,4,2,-1,100,1,0

[Colours]
Combo1 : 255,192,0
\u034fCombo3 : 242,24,57

[HitObjects]
192,192,1095,128,2,1630:2:2:-1:50:
448,192,815,1,8,2:2:-1:65:
"""

# 全曲を対象にする（songs.json に載っている曲 = SONGS）
SONG_KEYS = sorted(build_osz.SONGS)


class Helpers(unittest.TestCase):
    def test_h2_rounding(self):
        self.assertEqual(build_osz.h2(1095), 548)
        self.assertEqual(build_osz.h2(1630), 815)
        self.assertEqual(build_osz.h2(1000), 500)
        self.assertEqual(build_osz.h2(1), 0)  # 0.5ms の端数は丸め（可聴差なし）

    def test_mp3_duration_reads_the_real_files(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            path = ROOT / 'songs' / cfg['dir'] / cfg['audio']
            dur = build_osz.mp3_duration(path)
            self.assertIsNotNone(dur, f'{path} の長さが読めません')
            self.assertGreater(dur, 60, f'{path} が短すぎます: {dur}')
            dur_2x = build_osz.mp3_duration(path.parent / cfg['audio_2x'])
            self.assertAlmostEqual(dur_2x, dur / 2, delta=0.5)
            # 最後のノーツが音源の長さに収まっている
            for src, _ in cfg['diffs']:
                info = build_osz.parse_osu((path.parent / src).read_text(encoding='utf-8'))
                self.assertLessEqual(info['last_ms'], dur * 1000 + 50,
                                     f'{src}: 音源より後ろにノーツがあります')


class To2xOsuTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = build_osz.to_2x_osu(SAMPLE, "Easy (2x)", "失恋後 (2x).mp3")
        cls.info = build_osz.parse_osu(cls.out)

    def test_audio_and_meta(self):
        self.assertIn("AudioFilename: 失恋後 (2x).mp3", self.out)
        self.assertIn("Version:Easy (2x)", self.out)
        self.assertIn("Tags:foo bar mapperatorinator 2x", self.out)
        self.assertIn("Title:Shitsurengo", self.out)  # 曲名は変えない

    def test_general_and_editor_times_halved(self):
        self.assertIn("PreviewTime: 34298", self.out)
        self.assertIn("AudioLeadIn: 0", self.out)
        self.assertIn("Bookmarks:-165000,500", self.out)

    def test_timing_point_halved_beat_length_kept(self):
        self.assertIn("548,357.14285714285717,4,2,-1,100,1,0", self.out)

    def test_notes_halved_with_ln_end(self):
        lines = self.out.split("[HitObjects]")[1].strip().splitlines()
        self.assertEqual(lines[0], "192,192,548,128,2,815:2:2:-1:50:")
        self.assertEqual(lines[1], "448,192,408,1,8,2:2:-1:65:")
        self.assertEqual(self.info["times"], [548, 408])
        self.assertEqual(self.info["ln_ends"], [815])
        # 打鍵音は元のまま（正規化は normalize_osu の仕事）
        self.assertEqual([o['hit_sound'] for o in self.info['objects']], [2, 8])

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


class NormalizeOsuTest(unittest.TestCase):
    def setUp(self):
        self.out = normalize_osu.normalize_text(SAMPLE, 'shitsurengo')

    def test_invisible_char_is_removed(self):
        self.assertNotIn('\u034f', self.out)
        self.assertIn('\nCombo3 : 242,24,57', self.out)
        info = build_osz.parse_osu(self.out)
        self.assertEqual(info['invisible'], [])
        self.assertIn('Combo3', info['colours'])   # osu! が色として読める

    def test_hit_sounds_are_unified(self):
        info = build_osz.parse_osu(self.out)
        for o in info['objects']:
            self.assertEqual(o['hit_sound'], 0)
            self.assertEqual(o['sample'], normalize_osu.SAMPLE)

    def test_bookmark_and_tags_cleaned(self):
        self.assertNotIn('Bookmarks', self.out)
        tags = build_osz.parse_osu(self.out)['tags']
        self.assertNotIn('mapperatorinator', tags)
        for want in ('shitsurengo', '失恋後', '櫻優', 'mamekina'):
            self.assertIn(want, tags)

    def test_note_data_is_untouched_and_idempotent(self):
        self.assertEqual(normalize_osu.note_signature(SAMPLE),
                         normalize_osu.note_signature(self.out))
        self.assertEqual(self.out, normalize_osu.normalize_text(self.out, 'shitsurengo'))


class CheckTest(unittest.TestCase):
    """check() が「osu! で壊れる」不備を弾けること。"""

    def _check(self, text, **kw):
        info = build_osz.parse_osu(text)
        build_osz.check(info, 'Easy', {'失恋後.mp3', 'サムネイル.png'}, '失恋後.mp3',
                        'サムネイル.png', **kw)

    def test_good_chart_passes(self):
        text = normalize_osu.normalize_text(SAMPLE, 'shitsurengo')
        self._check(text)

    def test_invisible_char_is_rejected(self):
        text = normalize_osu.normalize_text(SAMPLE, 'shitsurengo').replace(
            '\nCombo3', '\n\u034fCombo3')
        with self.assertRaises(SystemExit):
            self._check(text)

    def test_unified_hit_sound_is_required(self):
        with self.assertRaises(SystemExit):
            self._check(SAMPLE)   # normalize 前（clap/whistle/音量バラバラ）は弾く

    def test_duplicate_note_in_same_lane_is_rejected(self):
        text = normalize_osu.normalize_text(SAMPLE, 'shitsurengo').replace(
            '448,192,815,1,0,2:2:0:50:', '192,192,1095,1,0,2:2:0:50:')
        with self.assertRaises(SystemExit):
            self._check(text)

    def test_off_lane_coordinates_are_rejected(self):
        text = normalize_osu.normalize_text(SAMPLE, 'shitsurengo').replace(
            '448,192,815,1,0,2:2:0:50:', '450,192,815,1,0,2:2:0:50:')
        with self.assertRaises(SystemExit):
            self._check(text)

    def test_notes_after_audio_end_are_rejected(self):
        with self.assertRaises(SystemExit):
            self._check(normalize_osu.normalize_text(SAMPLE, 'shitsurengo'),
                        audio_ms=1000)

    def test_creator_is_validated(self):
        text = normalize_osu.normalize_text(
            SAMPLE.replace('Creator:mamekina\n', 'Creator:\n'), 'shitsurengo')
        with self.assertRaises(SystemExit):
            self._check(text)

    def test_bad_colour_key_is_rejected(self):
        text = normalize_osu.normalize_text(SAMPLE, 'shitsurengo').replace(
            'Combo3 : 242,24,57', 'Combo31 : 242,24,57')
        with self.assertRaises(SystemExit):
            self._check(text)


class PerSpeedOszTest(unittest.TestCase):
    """1曲につき速度ごとに1つの .osz。1つの .osz = 1つの音源（osu! の前提）。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.archive = {}   # (song_key, speed) -> dict(path=, names=, charts=, texts=)
        for key in SONG_KEYS:
            for speed in (1, 2):
                out = pathlib.Path(cls.tmp.name) / build_osz.archive_name(key, speed)
                build_osz.build_song(key, speed=speed, keep_audio=True, output=out)
                charts, texts = {}, {}
                with zipfile.ZipFile(out) as zf:
                    names = zf.namelist()
                    for name in names:
                        if name.endswith('.osu'):
                            text = zf.read(name).decode('utf-8')
                            info = build_osz.parse_osu(text)
                            charts[info['meta']['Version']] = info
                            texts[info['meta']['Version']] = text
                cls.archive[(key, speed)] = dict(path=out, names=names, charts=charts,
                                                 texts=texts)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_archive_name(self):
        self.assertEqual(build_osz.archive_name('shitsurengo', 1), 'shitsurengo.osz')
        self.assertEqual(build_osz.archive_name('shitsurengo', 2), 'shitsurengo_2x.osz')

    def test_versions_are_only_that_speed(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            for speed in (1, 2):
                want = {v if speed == 1 else f'{v} {cfg["suffix_2x"]}'
                        for _, v in cfg['diffs']}
                with self.subTest(song=key, speed=speed):
                    self.assertEqual(set(self.archive[(key, speed)]['charts']), want)

    def test_archive_has_exactly_one_audio_file(self):
        """1 set 1 音源。複数の音源を入れると osu! が難易度に別の音源を割り当ててしまう。"""
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            for speed in (1, 2):
                arc = self.archive[(key, speed)]
                audios = sorted(n for n in arc['names']
                                if n.lower().endswith(('.mp3', '.ogg', '.wav')))
                want = cfg['audio'] if speed == 1 else cfg['audio_2x']
                with self.subTest(song=key, speed=speed):
                    self.assertEqual(audios, [want])

    def test_archive_is_flat_with_background(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            for speed in (1, 2):
                arc = self.archive[(key, speed)]
                with self.subTest(song=key, speed=speed):
                    with zipfile.ZipFile(arc['path']) as zf:
                        self.assertIsNone(zf.testzip())
                    self.assertEqual(
                        set(arc['names']),
                        {build_osz.chart_arcname(c['meta'], v)
                         for v, c in arc['charts'].items()}
                        | {cfg['bg']}
                        | {cfg['audio'] if speed == 1 else cfg['audio_2x']})
                    for name in arc['names']:
                        self.assertNotIn('/', name)   # フォルダを作らない

    def test_every_chart_points_at_the_archive_audio(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            for speed in (1, 2):
                arc = self.archive[(key, speed)]
                with self.subTest(song=key, speed=speed):
                    self.assertIn(cfg['bg'], arc['names'])   # 背景は全譜面で共有
                    for version, info in arc['charts'].items():
                        audio = info['general']['AudioFilename']
                        self.assertIn(audio, arc['names'])    # 参照先が同梱されている
                        self.assertEqual(
                            audio, cfg['audio_2x'] if '2x' in version else cfg['audio'])
                        self.assertIn(cfg['bg'], info['events'][0])

    def test_charts_are_mapped_by_mamekina(self):
        for key in SONG_KEYS:
            for speed in (1, 2):
                for version, info in self.archive[(key, speed)]['charts'].items():
                    with self.subTest(song=key, speed=speed, version=version):
                        self.assertEqual(info['meta']['Creator'], 'mamekina')
                        self.assertEqual(info['meta']['Version'], version)

    def test_2x_charts_are_the_1x_charts_halved(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            base = self.archive[(key, 1)]['charts']
            fast = self.archive[(key, 2)]['charts']
            with self.subTest(song=key):
                for _, version in cfg['diffs']:
                    info = base[version]
                    info_2x = fast[f'{version} {cfg["suffix_2x"]}']
                    self.assertEqual(info_2x['notes'], info['notes'])
                    self.assertEqual(info_2x['ln'], info['ln'])
                    self.assertEqual(info_2x['times'],
                                     [build_osz.h2(t) for t in info['times']])
                    self.assertEqual(info_2x['ln_ends'],
                                     [build_osz.h2(t) for t in info['ln_ends']])
                    self.assertLess(info_2x['last_ms'], info['last_ms'])

    def test_2x_chart_text_swaps_audio_and_tags(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            _, version = cfg['diffs'][0]
            version_2x = f'{version} {cfg["suffix_2x"]}'
            text = self.archive[(key, 2)]['texts'][version_2x]
            info = self.archive[(key, 2)]['charts'][version_2x]
            with self.subTest(song=key):
                self.assertIn(f'AudioFilename: {cfg["audio_2x"]}', text)
                self.assertIn(f'Version:{version_2x}', text)
                self.assertIn('2x', info['meta']['Tags'].split())

    def test_no_invisible_chars_in_any_chart(self):
        for key in SONG_KEYS:
            for speed in (1, 2):
                for version, info in self.archive[(key, speed)]['charts'].items():
                    with self.subTest(song=key, speed=speed, version=version):
                        self.assertEqual(info['invisible'], [])

    def test_hit_sounds_are_uniform_in_any_chart(self):
        for key in SONG_KEYS:
            for speed in (1, 2):
                for version, info in self.archive[(key, speed)]['charts'].items():
                    for o in info['objects']:
                        with self.subTest(song=key, speed=speed, version=version):
                            self.assertEqual(o['hit_sound'], 0, f'@{o["t"]}ms')
                            self.assertEqual(o['sample'], normalize_osu.SAMPLE,
                                             f'@{o["t"]}ms')

    def test_source_charts_need_no_normalization(self):
        """コミットされている .osu は正規化済み（tools/normalize_osu.py --check 相当）。"""
        for path in sorted((ROOT / 'songs').glob('*/*.osu')):
            with self.subTest(chart=str(path.relative_to(ROOT))):
                text = path.read_text(encoding='utf-8')
                self.assertEqual(
                    normalize_osu.normalize_text(text, path.parent.name), text)


@unittest.skipUnless(HAS_AUDIO_DEPS, 'soundfile / numpy / lameenc が必要')
class TwoTimesAudioTest(unittest.TestCase):
    """2倍速音源が 1倍速音源の間引き波形と一致していること（ズレて出荷しない）。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.pairs = {}
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            src = ROOT / 'songs' / cfg['dir'] / cfg['audio']
            dst = pathlib.Path(cls.tmp.name) / cfg['audio_2x']
            build_osz.make_2x_audio(src, dst)
            cls.pairs[key] = (src, dst, cfg)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_2x_audio_matches_decimated_1x(self):
        import numpy
        import soundfile
        for key, (src, dst, cfg) in self.pairs.items():
            with self.subTest(song=key):
                x1, sr = soundfile.read(str(src), dtype='int16')
                x2, sr2 = soundfile.read(str(dst), dtype='int16')
                self.assertEqual(sr, sr2)
                self.assertAlmostEqual(len(x2) / sr2, len(x1) / sr / 2, delta=0.5)
                dec = numpy.asarray(x1, dtype='int16').mean(axis=1)[::2]
                got = numpy.asarray(x2, dtype='int16').mean(axis=1)
                span = sr * 3
                for frac in (0.2, 0.6, 0.9):
                    off = min(int(len(dec) * frac), len(dec) - span)
                    lag = build_osz._chunk_start(dec[off:off + span], got) - off
                    self.assertLessEqual(abs(lag), 2,
                                         f'{cfg["dir"]}: {frac:.0%} 地点で {lag} サンプルずれ')

    def test_committed_2x_audio_is_up_to_date(self):
        """リポジトリ内の 2x mp3 が 1x から作り直したものとサンプル単位で一致すること。"""
        import numpy
        import soundfile
        for key, (src, dst, cfg) in self.pairs.items():
            committed = src.parent / cfg['audio_2x']
            with self.subTest(song=key):
                a, sr = soundfile.read(str(dst), dtype='int16')
                b, _ = soundfile.read(str(committed), dtype='int16')
                self.assertEqual(sr, 48000)
                n = min(len(a), len(b))
                self.assertEqual(
                    build_osz._chunk_start(
                        numpy.asarray(b[:n], dtype='int16').mean(axis=1)[sr * 2: sr * 5],
                        numpy.asarray(a[:n], dtype='int16').mean(axis=1)),
                    sr * 2,
                    f'{committed} が古い（tools/build_osz.py --force-audio で作り直してください）')


if __name__ == '__main__':
    unittest.main()
