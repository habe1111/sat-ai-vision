# FLAIR の ONNX を作る

アプリの土地被覆判定に使う `models/flair_rgb15.onnx` を、IGN が公開している重みから作り直す手順です。
通常は `npm run setup:model` でダウンロードすれば十分で、この手順は不要です。

```bash
cd tools/flair-export
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python export_flair.py
```

- 元の重み：[IGNF/FLAIR-INC_rgb_15cl_resnet34-unet](https://huggingface.co/IGNF/FLAIR-INC_rgb_15cl_resnet34-unet)（2024-08-09 更新、Etalab 2.0）
- 出力：`models/flair_rgb15.onnx`（約 98 MB、入力 `N×3×512×512`、出力 `N×15×512×512`）
- 変換の注意点は `export_flair.py` の冒頭に書いてあります（出力ヘッドが 19 チャンネルあることなど）。

同じ版の重み・ライブラリなら、`npm run setup:model` が配る ONNX と同じものになります
（torch のバージョンが違うとバイト列は変わりますが、出力は一致します）。
