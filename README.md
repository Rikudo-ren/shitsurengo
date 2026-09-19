# 失恋後 — Ultra Light VSRG

依存パッケージ **ゼロ** の超軽量・スタイリッシュな VSRG（縦スクロール音ゲー）。
`osu!mania` の譜面ファイル（`.osu`）をそのまま読み込んで遊べます。
ビルド不要・フレームワーク不要、`index.html` を開くだけで動きます。

```bash
npm start          # → http://localhost:8080
npm run songs      # songs/ をスキャンして songs/songs.json を再生成
npm test           # 判定・スコア・Accuracy の検証（Node のみ / ブラウザ不要）
```

---

## 特徴

| | |
|---|---|
| 重さ | 依存ゼロ。HTML+CSS+JS+譜面で **約 120KB**（サムネイル込み） |
| 譜面 | `.osu` (osu file format v12〜v14 / Mode 3) を自前パーサで読み込み |
| スコア | 上限 **1,000,000**（オール Perfect でちょうど 100 万） |
| Accuracy | **osu!mania と同一の計算式** |
| 倍速 | **0.5x 〜 3.0x**（0.1 刻み）— 音源も一緒に加減速（ピッチ維持） |
| モバイル | タッチマルチ入力・DPR 上限・低品質モードで軽く動作 |
| 設定 | スクロール速度 / 判定オフセット / タップ効果音 / 音量 / ミラー / キー割当 / 品質 |

---

## 判定

| 判定 | 窓 | Accuracy 値 | スコア重み |
|---|---|---|---|
| **PERFECT** | ±34 ms | 300 | 1.00 |
| **GREAT** | ±67 ms | 200 | 0.75 |
| **GOOD** | ±97 ms | 100 | 0.50 |
| **MEH** | ±122 ms | 50 | 0.25 |
| **MISS** | 上記以外 | 0 | 0 |

- **Accuracy（osu!mania 準拠）**
  `(300×PERFECT + 200×GREAT + 100×GOOD + 50×MEH + 0×MISS) ÷ (300 × 総判定数) × 100`
- **Score**
  `1,000,000 × Σ(重み) ÷ 総判定数`
- ロングノーツは **ヘッド + テイルの 2 判定**（osu! と同じく各判定の満点は 300）。
  最後まで押さえきるとテイルは自動で PERFECT、途中で離すとテイルが MISS になります。
- ランク: SS=100% / S≥95% / A≥90% / B≥80% / C≥70% / D それ以外

---

## 収録曲

| 曲 | 難易度 | ★ | ノーツ |
|---|---|---|---|
| 失恋後 | Easy | 5.0 | 643 (LN 36) |
| 失恋後 | Normal | 9.0 | 1683 (LN 16) |
| 失恋後 | Hard | 11.0 | 1886 (LN 138) |

すべて 4K / BPM 168。譜面は `songs/失恋後/*.osu`（`AudioFilename` は `失恋後.mp3` に更新済み）。

> **音源について** — リポジトリの `songs/失恋後/失恋後.mp3` は中身が空（2 バイト）のプレースホルダです。
> 同じ場所に本物の `失恋後.mp3` を置けば、そのまま音付きでプレイできます。
> 音源が無い/壊れている場合は自動的に **無音モード**（内部クロックで譜面どおりに進行）で動くので、
> 判定・スコアの動作確認はいつでも可能です。

---

## 曲の追加方法（3 ステップ）

1. `songs/<曲名フォルダ>/` を作って `.osu` 譜面・音源・ジャケットを入れる
2. （任意）同じフォルダに `song.json` を置いてタイトルや星数を指定する
3. `npm run songs` を実行 → `songs/songs.json` が自動生成される

```
songs/
└── 失恋後/
    ├── song.json        ← 曲の情報（任意。無くても自動推定されます）
    ├── easy.osu         ← 譜面（何個でもOK）
    ├── normal.osu
    ├── hard.osu
    ├── 失恋後.mp3        ← 音源（.mp3/.ogg/.wav/.m4a/.flac）
    ├── サムネイル.png     ← 元画像
    ├── thumb.webp       ← 生成されるサムネイル（曲選択の大きな表紙）
    ├── thumb_s.webp     ← 生成されるサムネイル（曲リストの小さな表紙）
    └── bg.webp          ← 生成される背景（ぼかして使用）
```

`song.json` の例:

```json
{
  "id": "shitsurengo",
  "title": "失恋後",
  "artist": "Unknown Artist",
  "audio": "失恋後.mp3",
  "thumbnail": "thumb.webp",
  "background": "bg.webp",
  "difficulties": [
    { "file": "easy.osu",   "name": "Easy",   "stars": 5,  "order": 1 },
    { "file": "normal.osu", "name": "Normal", "stars": 9,  "order": 2 },
    { "file": "hard.osu",   "name": "Hard",   "stars": 11, "order": 3 }
  ]
}
```

- `stars` を書かない場合はノーツ密度から自動概算します。
- `npm i -D sharp` しておくと `npm run songs` がサムネイル（webp）も自動生成します。
  無い場合は元画像をそのまま参照するだけで、エラーにはなりません。

---

## 操作

| | |
|---|---|
| キーボード | 4K: `D F J K`（5K/6K/7K は設定画面に既定バインドを表示） |
| タッチ / マウス | 画面のレーンを直接タップ（マルチタッチ対応・長押しで LN） |
| `Esc` | ポーズ |
| `Enter` | 決定 / START |
| `↑ ↓` | 難易度切替（曲選択画面） |
| `← →` | 倍速変更（曲選択画面） |
| `R` | リトライ（結果画面） |

キー割当は **設定 → キー設定** でレーンごとに自由に変更できます。

---

## 設定項目

- **スクロール速度** 1〜30（0.5 刻み）… 画面端から判定線までの到達時間が `9000 / 速度` ms
- **判定オフセット** −200〜200 ms … ＋で判定を後ろに、−で前にずらす。
  結果画面の「オフセット自動補正」で平均誤差から一発で最適化できます
- **演奏速度** 0.5x〜3.0x（0.1 刻み）… `HTMLMediaElement.playbackRate` + `preservesPitch` で音程を保ったまま加減速
- **タップエフェクト音** ON/OFF・種類（Click / Pop）・音量 … WebAudio 合成なので音素材は不要
- **マスター音量 / 音源音量**
- **エフェクト品質** 高 / 低 … 低にするとグローや blur を落として DPR も 1 に固定（古い端末向け）
- **ミラー** / **判定テキスト表示** / **FPS 表示**

設定は `localStorage` に保存されます（自己ベストも同様）。

---

## 構成

```
index.html          画面の骨組み（タイトル / 曲選択 / プレイ / 結果 / 設定）
css/style.css       スタイル（Webフォント・画像ゼロ）
js/osu.js           .osu パーサ（DOM 非依存 → Node でテスト可能）
js/judge.js         判定・スコア・Accuracy（DOM 非依存）
js/audio.js         高精度クロック / 倍速再生 / タップ音合成
js/render.js        Canvas 2D レンダラ（グラデーション等は焼き込み済み）
js/game.js          ループ・入力・HUD
js/ui.js            画面遷移 / 曲選択 / 設定 / 結果
js/main.js          エントリポイント
server.js           依存ゼロの静的サーバ（Range 対応）
tools/build-songs.js  songs/ → songs.json 生成
tools/test-judge.js   判定ロジックのテスト（npm test）
```

### タイミングの作り方

`AudioContext.currentTime` を基準クロックにし、`<audio>.currentTime` と毎フレーム突き合わせて
誤差 40ms 超でハード補正・それ以下はなめらかに追従させます（音ズレ対策）。
判定は入力イベント発生時点のクロックをそのまま使うので、フレーム落ちの影響を受けにくい設計です。

---

## 対応ブラウザ

Chrome / Edge / Safari / Firefox の最新バージョン（PC・Android・iOS）。
`Web Audio API` と `Canvas 2D` 以外の特殊 API は使っていません。
