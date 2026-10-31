# 開発メモ：現状と次の作業（2026-10-31 時点）

このリポジトリの開発を続ける人（と AI のコーディング支援）向けのメモです。使い方は [README](../README.md)、
設計の決めごとと、実際に踏んだ落とし穴は [CLAUDE.md](../CLAUDE.md) にあります。

## できていること

| 機能 | 状態 | 主なファイル |
|---|---|---|
| 地図・検索・範囲選択・解析（写真の取得 → 土地被覆 → AI の判読） | 完成。PC・スマホ縦横の E2E を AI の所見まで通過 | `app/`、`components/`、`lib/server/analysis.ts`・`landcover/`・`ai/` |
| AI への追加の質問（区画の集計、位置の語で拡大） | 完成 | `lib/server/ask.ts` |
| 建物の棟数と形（国土地理院の最適化ベクトルタイル） | 完成 | `lib/server/buildings.ts` |
| 駐車場の形・か所数・収容台数の目安（OpenStreetMap） | 完成。Overpass は応答に 15〜30 秒 | `lib/server/parking.ts` |
| 船・車の注釈ページ（開発用） | 完成。15 地点 135 チップ、船 407 隻は人が確認済み。車は未確認 | `app/dev/annotate/`、`data/annotations/` |
| 船の検出（自前の学習） | 検証済み・**未採用**（中心 F1 0.58）。アプリ側の推論は実装済みで、モデルを置けば動く | `tools/ship-train/`、`lib/server/ships.ts` |
| 超解像（0.5 m → 0.25 m） | 検証済み・**不採用**（画質は上がるが、船の検出は良くならない） | `tools/sr-train/` |

検証の数値と考察は README の「建物・車・船の位置と数」「船の検出の学習」「AI で高画質化した写真での検証」にあります。

## 手元で再現する

### アプリ

```bash
npm install
npm run setup     # 土地被覆モデル（GitHub Releases の models-v1）の取得と Ollama の確認
npm run dev
```

### 船の検出の学習（tools/ship-train）

```bash
npm run dev &                                              # チップの画像を作るのに使う
BASE_URL=http://localhost:3000 npm run annotate:prepare     # .cache/annotate/<id>.jpg を作る（既存の注釈は消さない）
cd tools/ship-train
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python train.py --val-sites kobe,choshi --epochs 25 --scale 2 --core 0.3,0.7    # README の基準（Apple M 系の GPU で約 30〜55 分）
.venv/bin/python train.py --all --epochs 25 --scale 2 --core 0.3,0.7 --export            # 全地点で学習し models/ship_unet.onnx と .json に書き出す
```

`models/ship_unet.onnx` と `models/ship_unet.json` の両方を置くと、アプリは船を聞かれたときに検出を使います
（無ければ「この解像度では数えられない」と答えます）。精度が足りないので、今は置いていません。

### 超解像の検証（tools/sr-train）

```bash
cd tools/sr-train
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python fetch_hr.py ../../.cache/hr                                        # 0.2 m の写真 14 地点 126 区画（約 1 GB）
.venv/bin/python train_sr.py --hr ../../.cache/hr --val-places 下田港,八王子駅 --save sr.pt   # 約 3.5 時間
.venv/bin/python apply_sr.py --weights sr.pt --out ../../.cache/annotate-sr                 # 注釈の写真を 2 倍に
cd ../ship-train && .venv/bin/python train.py --val-sites kobe,choshi --epochs 25 --scale 2 --core 0.3,0.7 --image-dir ../../.cache/annotate-sr
```

学習は時間がかかるので、macOS では `caffeinate -i` を前に付けてスリープを防ぎます。
DataLoader の `num_workers` は 0 のままにします（macOS では worker を使うと遅くなった）。

## 次の作業の候補

1. **船の精度を上げる**：超解像より、注釈を増やすほうが効きそう。とくに大型船と、横付けで何隻も並んだ係留。
   注釈は `/dev/annotate` で付け、`train.py --val-sites kobe,choshi` で基準（中心 F1 0.58、乱数の種 0・1 の平均）と比べる。
   F1 は種だけで 0.06〜0.10 動くので、比べるときは種を変えて 2 回以上学習する。
2. **車**：写真（約 0.5 m/px）では人も見分けられないので、今は駐車場の地図データで答えている。
   台数を数えるなら、0.2 m 級の写真が使える地域に限って注釈から作り直す必要がある（注釈の手間が大きい）。
3. **既知の残り**：FLAIR の 1 パッチの推論中は、Node のイベントループが止まる（worker_threads への移行は見送り）。
   書きかけのまま残ったタイルを、読み込むときに検証する処理は無い（新しく書くものは一時ファイル＋rename）。

## 外部サービス

| サービス | 用途 | 注意 |
|---|---|---|
| 国土地理院タイル・最適化ベクトルタイル | 写真・建物 | 写真は地理院だけを使う（理由は CLAUDE.md） |
| Nominatim | 検索 | 毎秒 1 件・確定時のみ・24 時間キャッシュ |
| Overpass API | 駐車場 | 公開サーバーは遅く、混むと断る。7 日間キャッシュ |
| Ollama（手元） | AI の判読 | `gemma4:e4b-it-q4_K_M` |
| Anthropic API（任意） | AI の判読 | `.env.local` に `ANTHROPIC_API_KEY`。写真が送られ、利用料が掛かる |
| GitHub Releases（models-v1） | 土地被覆モデルの配布 | 作り直したら `scripts/setup.mjs` の SHA-256 も更新する |
