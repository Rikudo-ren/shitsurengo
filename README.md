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
- 長押しノーツ(LN): 終端までホールド。途中で離すと Miss

## 仕様

| 項目 | 内容 |
|---|---|
| 判定 | Perfect ±34ms / Great ±67ms / Good ±97ms / Meh ±122ms / Miss |
| ACC | osu!mania 準拠 `(P×300 + Gr×200 + Go×100 + Meh×50) ÷ (300×総判定数)` |
| SCORE | 最大 100万 `⌊1000000 × 重み合計 ÷ (300×総判定数)⌋` |
| GRADE | SS=100% / S>95 / A>90 / B>80 / C>70 / D |
| 速度 | 0.5x–3.0x（0.1刻み、音源も一緒に変速）。スクロール速度は不変で、ノーツの**密度**だけが変わる |
| 画面 | 上部はノーツ用に完全開放（HUD/進行バーは画面下に配置） |
| LN | 始端+終端の2判定。終端まで保持で Perfect扱い |

## 曲の追加方法（後々増やす用）

1. `songs/曲名/` フォルダを作り、`.mp3` / サムネイル / `.osu` を入れる
2. `.osu` の `AudioFilename:` を同梱 mp3 名に合わせる
3. `songs/songs.json` に追記するだけ（2曲目以降は選曲タブが自動表示）

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
BGM音量 / レーン幅 / ノーツの大きさ / 判定ライン高さ / キー配置 — すべて localStorage に自動保存。
