# 失恋後 VSRG — 超軽量スタイリッシュ音ゲー

依存ゼロ（HTML + CSS + vanilla JS のみ、gzip で約 16KB）の 4K VSRG。
モバイルでも 60fps を狙った Canvas 描画 + WebAudio 判定エンジン。

## 遊び方

`index.html` を静的ホスティングするだけ（`file://` 直開きは fetch 制限で不可）。
ローカル確認例:

```sh
python3 -m http.server 8901
# → http://localhost:8901
```

- PC: `D F J K`（設定で変更可）/ モバイル: レーンを直接タップ（マルチタッチ対応）
- 長押しノーツ(LN): 終端までホールド。±151ms を超えて早く離すと Miss

## 仕様

| 項目 | 内容 |
|---|---|
| 判定 | Perfect+ ±34ms / Perfect ±67ms（FAST/SLOW表示） / Great ±97ms / Good ±122ms / Meh(50) ±151ms / Miss |
| ACC | osu!mania stable (ScoreV1) 準拠 — `(300×(P+ + P) + 200×Gr + 100×Go + 50×Meh) ÷ (300×総判定数)`。P+ は MAX (rainbow 300) として 300 扱い → ACC は下がらない |
| SCORE | osu!mania stable (ScoreV1) 準拠 — Base + Bonus の2本立て（上限 100万）。all-P+ で 1,000,000、all-P（ACC 100%）で 968,750。詳細は下記 |
| GRADE | SS=100% / S>95 / A>90 / B>80 / C>70 / D（osu!mania stable と同じく ACC 基準） |
| 速度 | 0.5x–3.0x（0.1刻み、音源も一緒に変速）。スクロール速度は不変で、ノーツの**密度**だけが変わる |
| 画面 | 上部はノーツ用に完全開放（HUD/進行バーは画面下に配置） |
| LN | 始端+終端の2判定。終端まで保持で Perfect+扱い |

### ACC / SCORE の計算式（osu!mania stable・ScoreV1 準拠）

判定は osu!mania stable の判定に対応させる:
**Perfect+ = MAX (rainbow 300) / Perfect = 300 / Great = 200 / Good = 100 / Meh = 50 / Miss = Miss**

- **ACC**: `(300×(MAX + 300) + 200×200 + 100×100 + 50×50) ÷ (300 × 総判定数)`
  MAX も 300 扱いなので、Perfect+ でも ACC は下がらない。
- **SCORE**: Base + Bonus の2本立て（各上限 500,000、合計 1,000,000）。1判定あたり
  `Base = (500000 ÷ 総判定数) × (HitValue ÷ 320)`
  `Bonus = (500000 ÷ 総判定数) × (HitBonusValue × √Bonus ÷ 320)`
  を加算する。

  | 判定 | HitValue | HitBonusValue | HitBonus | HitPunishment |
  |---|---|---|---|---|
  | P+ (MAX) | 320 | 32 | +2 | 0 |
  | P (300) | 300 | 32 | +1 | 0 |
  | Gr (200) | 200 | 16 | 0 | 8 |
  | Go (100) | 100 | 8 | 0 | 24 |
  | Meh (50) | 50 | 4 | 0 | 44 |
  | Miss | 0 | 0 | 0 | ∞（Bonus ごと 0） |

  Bonus は [0,100] の浮動値（開始値 100）。ヒットごとに `Bonus += HitBonus − HitPunishment` で更新し（クランプ [0,100]）、そのヒットの BonusScore は**更新前の Bonus** で評価する。Meh 窓は ±122〜151ms（外端 151ms は stable の 50 窓の基準値 = OD0 と同じ）。

  これにより SCORE は ACC とは別物になる: all-P+（all-MAX）で 1,000,000、all-P（gold 300 のみ）で ACC 100% のまま 968,750。旧実装は `SCORE = ACC × 10000` だった。

  なお LN は本作の仕様どおり始端+終端の2判定（osu!mania stable は LN=1判定）で、上記の式は判定ごとに適用する。

## osu! で遊ぶ (.osz)

選曲画面の「⬇ 通常版 / ⬇ 2倍速版」から、またはリポジトリ直下の
[`shitsurengo.osz`](shitsurengo.osz) などを直接ダウンロードできます。
osu! / osu!lazer にドロップ（またはダブルクリック）するとインポートされます。

| 配布ファイル | 中身 |
|---|---|
| `shitsurengo.osz` (3.88 MB) | 失恋後 1倍速: Easy 643 / Normal 1683 / Hard 1886 notes + `失恋後.mp3` + 背景 |
| `shitsurengo_2x.osz` (2.52 MB) | 失恋後 2倍速: `Easy (2x)` / `Normal (2x)` / `Hard (2x)` + `失恋後 (2x).mp3` + 背景 |
| `shitsurirongo.osz` (6.96 MB) | 失理論後 1倍速: Easy 1091 / Normal 1204 / Hard 1759 notes + `失理論後.mp3` + 背景 |
| `shitsurirongo_2x.osz` (4.02 MB) | 失理論後 2倍速: `Easy (2x)` / `Normal (2x)` / `Hard (2x)` + `失理論後 (2x).mp3` + 背景 |

**1倍速と2倍速は別ファイル**です。osu! は 1つの beatmapset に音源を2つ入れることを
想定しておらず（Ranking Criteria: *"A beatmapset may only contain one song file used by
all difficulties. Multiple song files within a single beatmap set is unsupported and
results in unexpected behaviour with preview times, metadata, etc."*）、実際に同居させると
**1倍速の難易度に 2倍速の音源（半分の長さ）が割り当たる**などの不具合が出ます。
そのためビルド時に「.osz 内の音源が1つだけ」を検証しています。

- 中身はフラット構成（フォルダなし）で、`.osu` ×3 + 音源 ×1 + 背景 `サムネイル.png` ×1
- 2倍速版は「同じ譜面を2倍速にしたもの」で、音は Web 版の 2.0x と同じ（速度+ピッチ）
- 譜面の `Creator:` は `mamekina`（osu! の曲画面に出る "beatmap by 〜" の表記）
- 打鍵音は全ノーツとも soft・音量50（`hitSound=0` / `hitSample=2:2:0:50:`）に統一。
  自動生成譜面は clap/whistle/finish がランダムに付き、音量も 20〜80 とバラつくため、
  osu! でそのまま遊ぶと打鍵音が鳴ったり鳴らなかったりします
- 2倍速譜面の音源は「1倍速音源を2サンプルずつ間引いた波形」と**サンプル単位で一致**
  （MP3 符号化の遅延 約1100サンプル = 23ms を実測して補正。以前は 2倍速側だけ 23ms
  ノーツが先行していました）
- 譜面を編集したら `python3 tools/build_osz.py` で .osz を作り直し、一緒にコミットしてください。
  `--song <id> --speed 1|2` で片方だけ、`--force-audio` で 2倍速音源も必ず作り直せます
  （既定は 1倍速より新しければ再利用）。1倍速のビルドは soundfile 等が無くても動きます。

### ビルド時に弾かれる不備（`tools/build_osz.py`）

.osz に混入させたくないものはビルド時に検証して落とします:

- **`.osz` 内の音源が2つ以上ある**（＝ 1 set 1 音源の原則違反。上記の不具合の原因）
- メタデータ / `Mode: 3` / 背景 / 参照音源が欠けている、`.osz` 内にファイルが無い
- `.osu` に不可視文字・制御文字（`U+034F` など。混ざると `[Colours]` の色が無視される）
- 打鍵音 (`hitSound` / `hitSample`) がノーツごとにバラついている
- 4K として不正なノーツ（レーン中央でない座標 / 同じレーン・同時刻の重複 /
  同じレーンで LN が重なる / LN の終端が始端以下 / 未知の type）
- ノーツや `PreviewTime` が音源の長さを超えている
- 2倍速譜面が 1倍速譜面の時間を正しく半分にしていない、2倍速音源が間引き波形とズレている

自動生成された `.osu`（Mapperatorinator など）を追加したときは、先に
`python3 tools/normalize_osu.py --write` を通してください。打鍵音の統一・
不可視文字の除去・`Bookmarks:-330001` のようなゴミ・Tags に残った生成ツール名を、
**ノーツの位置と時刻は変えずに**落とします（`--check` で差分の有無だけ確認できます）。

## 曲の追加方法（後々増やす用）

1. `songs/曲名/` フォルダを作り、`.mp3` / サムネイル / `.osu` を入れる
2. 自動生成した `.osu` なら `python3 tools/normalize_osu.py --write`（不可視文字・
   打鍵音・Tags・Bookmarks の整理。ノーツデータは変わりません）
3. `.osu` の `AudioFilename:` を同梱 mp3 名に合わせる
4. `songs/songs.json` に追記するだけ（2曲目以降は選曲タブが自動表示）
5. `tools/build_osz.py` の `SONGS` に曲を足して `python3 tools/build_osz.py`
   （1曲につき 1倍速/2倍速の .osz が1つずつ生成されます。`index.html` にダウンロードボタンも追加）

```json
{
  "songs": [
    {
      "id": "shitsurengo",
      "title": "失恋後",
      "artist": "櫻優",
      "audio": "songs/失恋後/失恋後.mp3",
      "thumb": "songs/失恋後/サムネイル.png",
      "diffs": [
        { "name": "Easy", "level": 5, "file": "songs/失恋後/easy.osu" },
        { "name": "Normal", "level": 9, "file": "songs/失恋後/normal.osu" }
      ]
    }
  ]
}
```

## 設定項目

スクロール速度 / オフセット(±200ms) / 再生速度 / タップ効果音ON・音量 /
BGM音量 / レーン幅 / ノーツの大きさ / 判定ライン高さ / 描画解像度（自動・高・低）/ キー配置 — すべて localStorage に自動保存。

## 遅延・カクつき対策（内部の仕組み）

| 症状 | 原因 | 対策 |
|---|---|---|
| 耳で合わせると全部 SLOW、音と絵がズレる | `AudioContext.currentTime` は出力遅延(outputLatency: PC 10〜40ms / Android 40〜200ms / Bluetooth 150ms+)ぶん**未来**を指す | 「今スピーカーから鳴っている位置」を `getOutputTimestamp()`（信頼できる環境のみ）または `currentTime − (outputLatency + baseLatency)` から求め、描画・判定・LN終端すべてでその時計を使う。補正量は設定画面とリザルトに表示 |
| ノーツの流れがガタつく | `currentTime` は音声コールバック単位（数ms〜20ms）の階段状にしか進まず、フレーム毎の進み量が 10ms/20ms とばらつく | `performance.now()` ベースの連続時計に音声時計を滑らかに追従させる（ジッタは平滑化、一時停止復帰などの大きなズレは即時再同期） |
| 判定が処理落ちの影響を受ける | ハンドラ実行時刻で判定していたため、描画で詰まった分だけ遅く判定される | `event.timeStamp`（OS が押下を記録した時刻）で判定。メインスレッドが遅れても判定は正確 |
| 文字表示のたびに重い | 毎フレーム `fillText` + `shadowBlur`（特にモバイルで数ms） | 判定文字・コンボ数字・ラベルを起動時にスプライト化、グラデーションもキャッシュ |
| 全体的に重い | 半透明キャンバスの合成、全画面ぼかし背景、毎フレームの DOM レイアウト | 不透明キャンバス（`alpha:false` + `desynchronized`）、プレイ中はぼかし背景を非表示、HUD 更新は 20回/秒・進行バーは transform |
| 低スペック端末でフレーム落ち | 高 DPR の全画面フィル | 描画解像度「自動」: フレーム落ちが続き、かつ描画自体に時間が掛かっている場合のみ内部解像度を段階的に下げる（手動で高/低も選択可） |
| 強制 48kHz | 端末ネイティブと違うサンプルレート指定はリサンプラを挟み遅延・CPU 増 | サンプルレート指定を撤廃し `latencyHint:'interactive'` のみ |

判定ライン下の小さなバーは直近 24 回の入力ズレ（左=FAST / 右=SLOW、白線=平均）。
白線が左寄りならオフセットを＋、右寄りなら−に動かして中央に合わせる。リザルトにもプレイ全体の平均ズレを表示。

### オフセットと倍率

オフセットは **実時間の ms**（全倍率共通）です。機器の音声・入力遅延に合わせて
一度調整すれば、倍率ごとに値を変える必要はありません。
内部では `譜面時間 = (音源開始からの実経過ms + offset) × 再生倍率` として、
描画・入力判定・LN終端に同じ補正を適用します。例えば +100ms は、
0.5x / 1x / 2x のどれでもノーツ到達を実時間で100ms早めます。
FASTが多ければ +、SLOWが多ければ − に調整してください。
既存の保存値は維持され、1xでの補正量は変更ありません（旧版で1x以外に合わせて
調整していた場合は再調整してください）。判定幅の仕様は変更していません。

回帰テスト: `node --test tests/*.cjs`（倍率×オフセット / 時計の平滑化・遅延補正・入力時刻 /
描画経路 / 配布している .osu を Web 側パーサが読めるか）·
`python3 -m unittest tests/test_osz_transform.py`
（2倍速の譜面変換 / 1つの .osz に1音源だけか / 打鍵音の統一・不可視文字なし /
音源より後ろにノーツが無い / 正規化がノーツデータを変えない / 2倍速音源のサンプル一致）。
音源の検証は `soundfile` `numpy` `lameenc` が無い環境では自動で skip されます。
