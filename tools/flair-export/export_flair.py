"""
IGN の公式の重み（FLAIR-INC RGB 15 クラス、ResNet34-UNet）から、アプリが使う ONNX を作る。

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python export_flair.py            # → ../../models/flair_rgb15.onnx

重みのライセンスは Etalab 2.0（提供者名と最終更新日を示せば、改変・再配布してよい）。
https://huggingface.co/IGNF/FLAIR-INC_rgb_15cl_resnet34-unet

変換で気をつける点（重みの中身を調べて分かったこと）:
- 出力ヘッドは 15 ではなく 19 チャンネル。FLAIR の 19 クラス体系のうち、使わない 4 クラス
  （14 皆伐地・15 混交・16 木質・18 その他）を除いた 15 チャンネルを取り出して出力する。
- state_dict のキーには "model.seg_model." が付き、学習時の "criterion.weight" も入っている。
"""
import hashlib
import os

import numpy as np
import onnxruntime as ort
import segmentation_models_pytorch as smp
import torch
from huggingface_hub import hf_hub_download

REPO = 'IGNF/FLAIR-INC_rgb_15cl_resnet34-unet'
REVISION = 'd8a81bc5bc46357677ba0569e83c4c68d3f78b89'   # 2024-08-09 の版
FILE = 'FLAIR-INC_rgb_15cl_resnet34-unet_weights.pth'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'models', 'flair_rgb15.onnx')
ACTIVE = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17]


class Flair15(torch.nn.Module):
    """19 チャンネルの出力から、使う 15 クラスだけを（クラス番号の順に）取り出す"""

    def __init__(self):
        super().__init__()
        self.seg = smp.Unet('resnet34', encoder_weights=None, in_channels=3, classes=19)
        self.register_buffer('idx', torch.tensor(ACTIVE), persistent=False)

    def forward(self, x):
        return self.seg(x).index_select(1, self.idx)


def main():
    path = hf_hub_download(REPO, FILE, revision=REVISION)
    sd = torch.load(path, map_location='cpu', weights_only=True)
    prefix = 'model.seg_model.'
    sd = {k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}
    model = Flair15()
    model.seg.load_state_dict(sd, strict=True)
    model.eval()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    dummy = torch.randn(1, 3, 512, 512)
    torch.onnx.export(model, dummy, OUT, opset_version=17, input_names=['input'], output_names=['logits'],
                      dynamic_axes={'input': {0: 'N'}, 'logits': {0: 'N'}}, dynamo=False)

    # 変換前後で出力が一致するかを確かめる
    x = np.random.default_rng(0).normal(size=(1, 3, 512, 512)).astype(np.float32)
    with torch.no_grad():
        want = model(torch.from_numpy(x)).numpy()
    got = ort.InferenceSession(OUT, providers=['CPUExecutionProvider']).run(None, {'input': x})[0]
    print(f'最大誤差 {np.abs(want - got).max():.2e} / argmax 一致率 {(want.argmax(1) == got.argmax(1)).mean():.6f}')
    sha = hashlib.sha256(open(OUT, 'rb').read()).hexdigest()
    print(f'書き出しました: {os.path.normpath(OUT)}（{os.path.getsize(OUT) / 1e6:.1f} MB, sha256 {sha}）')


if __name__ == '__main__':
    main()
