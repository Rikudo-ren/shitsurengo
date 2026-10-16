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
import json
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


def first_bpm(info: dict) -> float:
    """最初の BPM 行（beatLength > 0）から BPM を求める。"""
    red = [bl for _, bl in info['timing'] if bl > 0]
    assert red, 'BPM 行がありません'
    return 60000 / red[0]


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

    def test_timing_point_bpm_doubled_with_sv_line(self):
        """BPM 表示は実際の速さ（2倍）にし、SV 1.0 で Fixed スクロールを 1倍速と同じにする。
        以前は SV 0.5 で BPM×SV を揃えていたが、Fixed では 1/2 になる不具合があったため修正。"""
        self.assertIn("548,178.57142857142858,4,2,-1,100,1,0", self.out)  # 336 BPM
        self.assertIn("548,-100,4,2,-1,100,0,0", self.out)                # SV 1.0
        self.assertNotIn("0,-100,4,2,-1,100,0,0", self.out)  # 赤線前の緑線は stable で危険
        self.assertNotIn("0,-200,4,2,-1,100,0,0", self.out)
        # 赤線（BPM）には必ず緑線（SV）が同じ時刻に付く
        for line in self.out.split("[TimingPoints]")[1].split("\n\n")[0].strip().splitlines():
            fields = line.split(',')
            if float(fields[1]) > 0:
                self.assertIn(f'{fields[0]},-100,4,2,-1,100,0,0', self.out)

    def test_first_control_point_is_a_bpm_change(self):
        # The old generator passed all timing/SV tests but began with a green line.
        # Regression for osu!stable-issues #1315/#1316 (mania infinite load).
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            for src, version in cfg['diffs']:
                with self.subTest(song=key, version=version):
                    text = (ROOT / 'songs' / cfg['dir'] / src).read_text(encoding='utf-8')
                    out = build_osz.to_2x_osu(text, version + cfg['suffix_2x'], cfg['audio_2x'])
                    first = out.split('[TimingPoints]')[1].strip().splitlines()[0].split(',')
                    self.assertGreater(float(first[1]), 0)
                    self.assertEqual(first[6], '1')

    def test_scroll_speed_matches_1x(self):
        """Fixed スクロールは SV のみに依存するため、2倍速でも SV=1.0 で 1倍速と同じ速度になる。
        以前は BPM×SV を揃えていたが Fixed では 1/2 になる不具合があったため、SV=1.0 に修正。"""
        orig = build_osz.parse_osu(SAMPLE)
        # Fixed スクロールは SV=1.0 で同じ
        self.assertAlmostEqual(build_osz.SV_2X, 1.0)
        # BPM は2倍で表示は実際の速さ
        self.assertAlmostEqual(first_bpm(self.info), first_bpm(orig) * 2)

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


class SingleOszBothSpeedsTest(unittest.TestCase):
    """1曲 = 1つの .osz。1倍速3譜面 + 2倍速3譜面 + 音源2つ（難易度ごとに AudioFilename）。"""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.archive = {}   # song_key -> dict(path=, names=, charts=, texts=)
        for key in SONG_KEYS:
            out = pathlib.Path(cls.tmp.name) / build_osz.archive_name(key)
            build_osz.build_song(key, keep_audio=True, output=out)
            charts, texts = {}, {}
            with zipfile.ZipFile(out) as zf:
                names = zf.namelist()
                for name in names:
                    if name.endswith('.osu'):
                        text = zf.read(name).decode('utf-8')
                        info = build_osz.parse_osu(text)
                        charts[info['meta']['Version']] = info
                        texts[info['meta']['Version']] = text
            cls.archive[key] = dict(path=out, names=names, charts=charts, texts=texts)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def test_archive_name(self):
        self.assertEqual(build_osz.archive_name('shitsurengo'), 'shitsurengo.osz')

    def test_shitsurirongo_upload_safe_names_and_references(self):
        """再生成物と配布物の両方で、素材名・Version に全角文字を戻さない。"""
        arc = self.archive['shitsurirongo']
        versions = {'Easy', 'Normal', 'Hard', 'Easy_x2', 'Normal_x2', 'Hard_x2'}
        resources = {'audio.mp3', 'audio_x2.mp3', 'bg.png'}
        for path in (arc['path'], ROOT / 'shitsurirongo.osz'):
            with self.subTest(archive=str(path)), zipfile.ZipFile(path) as zf:
                self.assertIsNone(zf.testzip())
                self.assertEqual(len(zf.namelist()), 9)
                self.assertEqual({n for n in zf.namelist() if not n.endswith('.osu')},
                                 resources)
                charts = [build_osz.parse_osu(zf.read(n).decode('utf-8'))
                          for n in zf.namelist() if n.endswith('.osu')]
                self.assertEqual({c['meta']['Version'] for c in charts}, versions)
                for info in charts:
                    version = info['meta']['Version']
                    self.assertTrue(version.isascii())
                    self.assertEqual(info['general']['AudioFilename'],
                                     'audio_x2.mp3' if version.endswith('_x2') else 'audio.mp3')
                    self.assertIn('0,0,"bg.png",0,0', info['events'])
                    self.assertEqual(info['meta']['TitleUnicode'], '失理論後')
                for name in resources:
                    self.assertRegex(name, r'^[A-Za-z0-9_]+[.][a-z0-9]+$')
                    self.assertEqual(zf.read(name),
                                     (ROOT / 'songs' / '失理論後' / name).read_bytes())

    def test_shitsurirongo_web_paths_exist(self):
        """素材のリネーム後もWeb版の音源・サムネイル参照を維持する。"""
        manifest = json.loads((ROOT / 'songs' / 'songs.json').read_text(encoding='utf-8'))
        song = next(s for s in manifest['songs'] if s['title'] == '失理論後')
        self.assertEqual(song['audio'], 'songs/失理論後/audio.mp3')
        self.assertEqual(song['thumb'], 'songs/失理論後/bg.png')
        for field in ('audio', 'thumb'):
            self.assertTrue((ROOT / song[field]).is_file())

    def test_both_speeds_are_in_one_archive(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            want = {v for _, v in cfg['diffs']} | {f'{v}{cfg["suffix_2x"]}'
                                                  for _, v in cfg['diffs']}
            with self.subTest(song=key):
                self.assertEqual(set(self.archive[key]['charts']), want)

    def test_archive_has_one_audio_per_speed(self):
        """音源は1倍速/2倍速の2つだけ（それ以外の音源を混ぜない）。"""
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            arc = self.archive[key]
            audios = sorted(n for n in arc['names']
                            if n.lower().endswith(('.mp3', '.ogg', '.wav')))
            with self.subTest(song=key):
                self.assertEqual(audios, sorted([cfg['audio'], cfg['audio_2x']]))

    def test_1x_audio_sorts_before_2x_audio(self):
        """osu! はセットの曲情報（長さ・プレビュー）に「先に並ぶ音源」を使うため、
        1倍速の音源が先に並んでいないと 1倍速の譜面が半分の長さになる。"""
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            arc = self.archive[key]
            audios = sorted(n for n in arc['names'] if n.endswith('.mp3'))
            with self.subTest(song=key):
                self.assertLess(audios[0], audios[1], '1倍速の音源が先に並ぶこと')
                self.assertEqual(audios[0], cfg['audio'])
                # '(' や ' ' は '.' より小さいので "失恋後 (2x).mp3" は前に並んでしまう
                self.assertNotIn('(', audios[0])
                self.assertNotIn('(', audios[1])

    def test_1x_charts_sort_before_their_2x_twins(self):
        """同難易度なら 1倍速の譜面ファイルが先に並ぶこと（osu! がセットの
        曲情報を最初の譜面から取ったとき、2倍速の音源を選ばないように）。"""
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            names = [n for n in self.archive[key]['names'] if n.endswith('.osu')]
            with self.subTest(song=key):
                for _, version in cfg['diffs']:
                    one = [n for n in names if n.endswith(f'[{version}].osu')][0]
                    two = [n for n in names
                           if n.endswith(f'[{version}{cfg["suffix_2x"]}].osu')][0]
                    self.assertLess(one, two)
                # 最初に並ぶ譜面は 1倍速（Easy）であること
                self.assertEqual(min(names),
                                 [n for n in names if n.endswith('[Easy].osu')][0])

    def test_archive_is_flat_with_background(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            arc = self.archive[key]
            with self.subTest(song=key):
                with zipfile.ZipFile(arc['path']) as zf:
                    self.assertIsNone(zf.testzip())
                self.assertEqual(
                    set(arc['names']),
                    {build_osz.chart_arcname(c['meta'], v) for v, c in arc['charts'].items()}
                    | {cfg['bg'], cfg['audio'], cfg['audio_2x']})
                for name in arc['names']:
                    self.assertNotIn('/', name)   # フォルダを作らない

    def test_2x_charts_keep_the_1x_scroll_speed(self):
        """2倍速は BPM 2倍 + SV 1.0 = Fixed では見た目の速度が 1倍速と同じ。
        以前は SV 0.5 で BPM×SV を揃えていたが Fixed では 1/2 になるため修正。"""
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            arc = self.archive[key]
            with self.subTest(song=key):
                for _, version in cfg['diffs']:
                    text = arc['texts'][f'{version}{cfg["suffix_2x"]}']
                    section = text.split('[TimingPoints]')[1].split('\n\n')[0]
                    bpm = [l for l in section.strip().splitlines() if float(l.split(',')[1]) > 0]
                    sv = [l for l in section.strip().splitlines() if float(l.split(',')[1]) < 0]
                    self.assertTrue(bpm and sv, 'BPM行とSV行の両方があること')
                    self.assertEqual(set(sv),
                                     {f'{l.split(",")[0]},-100,4,2,-1,100,0,0' for l in bpm})
                    # Fixed スクロールは SV=1.0 で同じ、BPM は2倍で表示は実際の速さ
                    one = arc['charts'][version]
                    two = arc['charts'][f'{version}{cfg["suffix_2x"]}']
                    self.assertAlmostEqual(first_bpm(one) * 2,
                                           first_bpm(two))
                    self.assertAlmostEqual(build_osz.SV_2X, 1.0)

    def test_1x_charts_sort_before_2x_even_with_loose_comparison(self):
        """'.' や '（）' を無視する比較（カルチャ依存の並べ替え）でも 1倍速が先。"""
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            arc = self.archive[key]
            with self.subTest(song=key):
                key1 = build_osz.loose_key(cfg['audio'])
                key2 = build_osz.loose_key(cfg['audio_2x'])
                self.assertLess(key1, key2)
                names = [n for n in arc['names'] if n.endswith('.osu')]
                for _, version in cfg['diffs']:
                    one = [n for n in names if n.endswith(f'[{version}].osu')][0]
                    two = [n for n in names
                           if n.endswith(f'[{version}{cfg["suffix_2x"]}].osu')][0]
                    self.assertLess(build_osz.loose_key(one), build_osz.loose_key(two))

    def test_every_chart_points_at_its_own_speed_audio(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            arc = self.archive[key]
            with self.subTest(song=key):
                self.assertIn(cfg['bg'], arc['names'])   # 背景は全譜面で共有
                for version, info in arc['charts'].items():
                    audio = info['general']['AudioFilename']
                    self.assertIn(audio, arc['names'])    # 参照先が同梱されている
                    self.assertEqual(
                        audio,
                        cfg['audio_2x'] if version.endswith(cfg['suffix_2x'])
                        else cfg['audio'])
                    self.assertIn(cfg['bg'], info['events'][0])

    def test_charts_are_mapped_by_mamekina(self):
        for key in SONG_KEYS:
            for version, info in self.archive[key]['charts'].items():
                with self.subTest(song=key, version=version):
                    self.assertEqual(info['meta']['Creator'], 'mamekina')
                    self.assertEqual(info['meta']['Version'], version)

    def test_2x_charts_are_the_1x_charts_halved(self):
        for key in SONG_KEYS:
            cfg = build_osz.SONGS[key]
            charts = self.archive[key]['charts']
            with self.subTest(song=key):
                for _, version in cfg['diffs']:
                    info = charts[version]
                    info_2x = charts[f'{version}{cfg["suffix_2x"]}']
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
            version = cfg['diffs'][0][1]
            version_2x = f'{version}{cfg["suffix_2x"]}'
            arc = self.archive[key]
            with self.subTest(song=key):
                self.assertIn(f'AudioFilename: {cfg["audio_2x"]}', arc['texts'][version_2x])
                self.assertIn(f'Version:{version_2x}', arc['texts'][version_2x])
                self.assertIn('2x', arc['charts'][version_2x]['meta']['Tags'].split())
                self.assertIn(f'AudioFilename: {cfg["audio"]}', arc['texts'][version])

    def test_no_invisible_chars_in_any_chart(self):
        for key in SONG_KEYS:
            for version, info in self.archive[key]['charts'].items():
                with self.subTest(song=key, version=version):
                    self.assertEqual(info['invisible'], [])

    def test_hit_sounds_are_uniform_in_any_chart(self):
        for key in SONG_KEYS:
            for version, info in self.archive[key]['charts'].items():
                for o in info['objects']:
                    with self.subTest(song=key, version=version):
                        self.assertEqual(o['hit_sound'], 0, f'@{o["t"]}ms')
                        self.assertEqual(o['sample'], normalize_osu.SAMPLE, f'@{o["t"]}ms')

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
