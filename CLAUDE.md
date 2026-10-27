@AGENTS.md

# sat_ai_vision（Claude Code 用のプロジェクト規約）

地図で範囲を選ぶと、その範囲の空中写真を手元のサーバーで解析し、AI が日本語で説明する Web アプリ。
個人の検証・ポートフォリオ用の**公開リポジトリ**。

## 決めごと

- **説明・UI 文言・コード内コメント・コミット件名は日本語。** 周囲のコメント密度・命名に合わせる。
- **他のプロジェクトのコードを流用しない。** このリポジトリの中で一から書く。
- **公開リポジトリなので、秘密情報を入れない。** API キーは `.env.local`（Git 管理外）。見本は `.env.example`。
- **コミットのメールは `habe1111@users.noreply.github.com`**（リポジトリ単位で設定済み）。
- **GitHub は個人アカウント habe1111 で push する**（`gh auth switch -u habe1111`。リモートは `habe1111/sat-ai-vision`）。
- 画面はスマホ・タブレット・PC のどれでも、**ボタンやパネルを重ねない**。変えたら E2E のスクショで確かめる。
## よく使うコマンド

```bash
npm run dev                 # http://localhost:3000
npm run setup               # 土地被覆モデルの取得と Ollama の確認
npm run lint && npm run typecheck
BASE_URL=http://localhost:3000 npm run e2e                  # PC
BASE_URL=http://localhost:3000 VIEWPORT=mobile npm run e2e  # スマホ（指でなぞる）。横向きは VIEWPORT=landscape
REQUIRE_AI=1 BASE_URL=http://localhost:3000 npm run e2e      # AI の所見まで必須にする
BASE_URL=http://localhost:3000 npm run demo                  # README の説明動画を撮り直す（docs/media/）
ollama serve                # AI の判読（Ollama）に必要
```

## 設計の要点（理由は README の「しくみ」）

- 画像は**国土地理院「全国最新写真（シームレス）」だけ**。Google・Esri・Mapbox・MapTiler は規約で
  「サーバーでの取得・結合」と「AI での画像解析」を禁じている（2026-10 に一次資料で確認）。
  ズーム帯ごとに出典が違うので、地図のソースを 3 つに分けている（`lib/imagery.ts`）。
- 検索は Nominatim を**サーバー経由**で、毎秒 1 件・確定時のみ・24 時間キャッシュ（利用ポリシー）。
- 解析は `POST /api/analyze` が NDJSON で段ごとに返す：写真の取得 → 土地被覆（FLAIR）→ AI の判読。
- 土地被覆は FLAIR-INC を ONNX で推論。**約 0.33 m/px（z18 の 1.5 倍）**で推論し 7 区分にまとめる
  （6 地点の実測で決めた。等倍は住宅・水面を取りこぼし、2 倍は都心に斑点が出る）。
  モデルは Git に入れない（`models/`、`npm run setup` で取得）。無ければ色の簡易推定に切り替わる。
- AI は `AI_PROVIDER`（auto / ollama / anthropic / none）。数値は CV を正とし、VLM には言語化を任せる。

## はまりどころ（実際に踏んだもの）

- **Tailwind v4 のユーティリティはカスケードレイヤーの中**にあり、レイヤー外の MapLibre の CSS に負ける。
  地図の入れ物の位置は `style` で直接与える（`.maplibregl-map { position: relative }` で高さ 0 になった）。
- **MapLibre v6 の worker** はバンドル後に見つからない → `app/maplibre/[file]/route.ts` から配信し `setWorkerUrl`。
- `next.config.ts` は create-next-app が入れた設定（`cacheComponents`・Tailwind のローダー）を消さない。
  `searchParams` を読む部分は `<Suspense>` で囲む。
- E2E のスクショは、画像の読み込みと地図の移動が終わってから撮る（途中だと枠と重ね絵がずれて写る）。
- **MapLibre の `m.remove()` は URL の `#map=` を消す。** 開発中は React が地図を作り直すので、片付けで hash を戻している（消えると共有リンクが初期位置になる）。
- MapLibre のズームは 512 px タイル基準。ズーム 16 で約 1 m/px（地理院タイルの z17 相当）。
