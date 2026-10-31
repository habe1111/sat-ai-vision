"""
学習した超解像で、注釈のチップの写真（.cache/annotate/<id>.jpg、0.5 m/px）を 2 倍にする。
船の検出を「bicubic の 2 倍」と同じ条件で比べるために使う（tools/ship-train/train.py --image-dir）。

    .venv/bin/python apply_sr.py --weights sr.pt --out ../../.cache/annotate-sr
"""
import argparse
import glob
import os

import cv2
import torch

from train_sr import SRx2, run_sr

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    model = SRx2()
    model.load_state_dict(torch.load(args.weights, map_location='cpu', weights_only=True))
    model.to(device).eval()
    os.makedirs(args.out, exist_ok=True)
    files = sorted(glob.glob(os.path.join(ROOT, '.cache', 'annotate', '18-*.jpg')))
    for f in files:
        rgb = cv2.cvtColor(cv2.imread(f), cv2.COLOR_BGR2RGB)
        sr = run_sr(model, rgb, device)
        cv2.imwrite(os.path.join(args.out, os.path.basename(f)[:-4] + '.png'), cv2.cvtColor(sr, cv2.COLOR_RGB2BGR))
    print(f'{len(files)} 枚を 2 倍にしました → {args.out}')


if __name__ == '__main__':
    main()
