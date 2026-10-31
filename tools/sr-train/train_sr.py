"""
空中写真の超解像（0.5 m/px → 0.25 m/px、2 倍）を、0.2 m の写真のオープンデータから学習する。

    .venv/bin/python train_sr.py --hr ../../.cache/hr --val-places 下田港,八王子駅      # 学習と評価
    .venv/bin/python train_sr.py --hr ../../.cache/hr --all --export                   # 全地点で学習し ONNX に書き出す

学習データは東京都（デジタルツイン実現プロジェクト、多摩地域のオルソ画像）と静岡県（VIRTUAL SHIZUOKA）の
0.2 m の写真（どちらも CC BY 4.0）。取得は tools/sr-train/fetch_hr.py。

しくみ：
- 0.2 m の写真を 0.25 m に縮めたものを正解、0.5 m に縮めて少しぼかし JPEG で圧縮したものを入力にする
  （国土地理院の z18 の写真は約 0.49 m/px の JPEG なので、それに近づける）。
- ネットワークは bicubic で 2 倍にした画像に「差分」を足す形の小さな残差ネットワーク。損失は L1 だけにして、
  見た目のための GAN の損失は使わない（存在しない細部を作りにくくするため）。
- 評価は、学習に使わない地点で bicubic と比べた PSNR・SSIM。
"""
import argparse
import json
import os
import random
import time

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.path.join(ROOT, 'models', 'sr_x2.onnx')
HR_MPP, LR_MPP, OUT_MPP = 0.2, 0.5, 0.25
LR_PATCH = 96       # 学習の切り抜き（入力の画素）。出力は 192


class ResBlock(nn.Module):
    def __init__(self, ch):
        super().__init__()
        self.c1 = nn.Conv2d(ch, ch, 3, padding=1)
        self.c2 = nn.Conv2d(ch, ch, 3, padding=1)

    def forward(self, x):
        return x + 0.1 * self.c2(F.relu(self.c1(x)))


class SRx2(nn.Module):
    """入力 [N,3,H,W]（0〜1）→ 出力 [N,3,2H,2W]（0〜1）。bicubic の 2 倍拡大に差分を足す"""

    def __init__(self, ch=64, blocks=16):
        super().__init__()
        self.head = nn.Conv2d(3, ch, 3, padding=1)
        self.body = nn.Sequential(*[ResBlock(ch) for _ in range(blocks)], nn.Conv2d(ch, ch, 3, padding=1))
        self.up = nn.Sequential(nn.Conv2d(ch, ch * 4, 3, padding=1), nn.PixelShuffle(2), nn.Conv2d(ch, 3, 3, padding=1))

    def forward(self, x):
        base = F.interpolate(x, scale_factor=2, mode='bicubic', align_corners=False)
        f = self.head(x)
        return base + self.up(f + self.body(f))


def load_hr(hr_dir, places):
    """0.2 m の写真を読み、0.25 m に縮めた正解の画像にする。places は地点名の集合（None ならすべて）"""
    index = json.load(open(os.path.join(hr_dir, 'index.json'), encoding='utf-8'))
    out = []
    for it in index:
        if it.get('missing') or (places is not None and it['place'] not in places):
            continue
        img = cv2.imread(os.path.join(hr_dir, f"{it['mesh']}.tif"), cv2.IMREAD_COLOR)
        if img is None:
            continue
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        # 写真の無い部分（黒や白で埋めた余白）が多い区画は使わない
        if (rgb.max(2) < 8).mean() > 0.3 or (rgb.min(2) > 250).mean() > 0.3:
            continue
        k = HR_MPP / OUT_MPP
        out.append({'place': it['place'], 'kind': it['kind'],
                    'hr': cv2.resize(rgb, None, fx=k, fy=k, interpolation=cv2.INTER_AREA)})
    return out


def degrade(hr, rng):
    """正解（0.25 m）から入力（0.5 m 相当）を作る：少しぼかし、縮め、JPEG で圧縮する"""
    sigma = rng.uniform(0.2, 0.8)
    x = cv2.GaussianBlur(hr, (0, 0), sigma) if sigma > 0.3 else hr
    x = cv2.resize(x, (hr.shape[1] // 2, hr.shape[0] // 2), interpolation=cv2.INTER_AREA)
    q = int(rng.uniform(70, 95))
    ok, enc = cv2.imencode('.jpg', cv2.cvtColor(x, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, q])
    return cv2.cvtColor(cv2.imdecode(enc, cv2.IMREAD_COLOR), cv2.COLOR_BGR2RGB)


class Pairs(torch.utils.data.Dataset):
    def __init__(self, images, n):
        self.images, self.n = images, n

    def __len__(self):
        return self.n

    def __getitem__(self, i):
        rng = random.Random()
        img = self.images[rng.randrange(len(self.images))]['hr']
        hp = LR_PATCH * 2
        y, x = rng.randrange(img.shape[0] - hp), rng.randrange(img.shape[1] - hp)
        hr = img[y:y + hp, x:x + hp]
        k = rng.randrange(4)
        hr = np.rot90(hr, k)
        if rng.random() < 0.5:
            hr = hr[:, ::-1]
        hr = np.ascontiguousarray(hr)
        lr = degrade(hr, rng)
        t = lambda a: torch.from_numpy(a.astype(np.float32).transpose(2, 0, 1) / 255)
        return t(lr), t(hr)


def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 10 * np.log10(255 ** 2 / max(mse, 1e-10))


def ssim(a, b):
    """輝度の SSIM（ガウス窓 11、σ 1.5）"""
    ga = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY).astype(np.float64)
    gb = cv2.cvtColor(b, cv2.COLOR_RGB2GRAY).astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    blur = lambda z: cv2.GaussianBlur(z, (11, 11), 1.5)
    ma, mb = blur(ga), blur(gb)
    va, vb, cov = blur(ga * ga) - ma ** 2, blur(gb * gb) - mb ** 2, blur(ga * gb) - ma * mb
    return float(np.mean(((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma ** 2 + mb ** 2 + c1) * (va + vb + c2))))


def run_sr(model, lr, device):
    """入力の画像（uint8、0.5 m 相当）を 2 倍にする"""
    x = torch.from_numpy(lr.astype(np.float32).transpose(2, 0, 1)[None] / 255).to(device)
    with torch.no_grad():
        y = model(x)
    return (y[0].clamp(0, 1).cpu().numpy().transpose(1, 2, 0) * 255).round().astype(np.uint8)


def evaluate(model, images, device, seed=0):
    """学習に使わない地点の区画で、bicubic と超解像の PSNR・SSIM を比べる（中央の 512×512 を使う）"""
    model.eval()
    rng = random.Random(seed)
    rows = []
    for it in images:
        h, w = it['hr'].shape[:2]
        hr = it['hr'][(h - 512) // 2:(h - 512) // 2 + 512, (w - 512) // 2:(w - 512) // 2 + 512]
        lr = degrade(hr, rng)
        bic = cv2.resize(lr, (512, 512), interpolation=cv2.INTER_CUBIC)
        sr = run_sr(model, lr, device)
        rows.append((psnr(bic, hr), psnr(sr, hr), ssim(bic, hr), ssim(sr, hr)))
    m = np.mean(rows, 0)
    return {'bicubic_psnr': round(m[0], 2), 'sr_psnr': round(m[1], 2), 'bicubic_ssim': round(m[2], 4), 'sr_ssim': round(m[3], 4), 'n': len(rows)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--hr', required=True, help='0.2 m の写真（fetch_hr.py の出力）のフォルダ')
    ap.add_argument('--val-places', default='')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--steps', type=int, default=20000)
    ap.add_argument('--save', default='')
    ap.add_argument('--export', action='store_true')
    args = ap.parse_args()
    torch.manual_seed(0)
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'

    val_places = set(filter(None, args.val_places.split(',')))
    every = load_hr(args.hr, None)
    train = every if args.all else [i for i in every if i['place'] not in val_places]
    val = [i for i in every if i['place'] in val_places]
    print(f'学習 {len(train)} 区画・評価 {len(val)} 区画・{device}', flush=True)

    model = SRx2().to(device)
    opt = torch.optim.Adam(model.parameters(), lr=2e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, args.steps)
    loader = torch.utils.data.DataLoader(Pairs(train, args.steps * 16), batch_size=16, num_workers=0)
    t0, total = time.time(), 0.0
    for step, (lr, hr) in enumerate(loader, 1):
        model.train()
        lr, hr = lr.to(device), hr.to(device)
        loss = F.l1_loss(model(lr), hr)
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        total += loss.item()
        if step % 1000 == 0 or step == args.steps:
            msg = f'{step:6d}/{args.steps} L1 {total / 1000:.4f}（{time.time() - t0:.0f} 秒）'
            total = 0.0
            if val and (step % 5000 == 0 or step == args.steps):
                msg += f'　評価 {evaluate(model, val, device)}'
            print(msg, flush=True)
        if step >= args.steps:
            break

    if args.save:
        torch.save(model.state_dict(), args.save)
    if args.export:
        model.eval().cpu()
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        torch.onnx.export(model, torch.rand(1, 3, 128, 128), OUT, opset_version=17, input_names=['input'], output_names=['output'],
                          dynamic_axes={'input': {0: 'N', 2: 'H', 3: 'W'}, 'output': {0: 'N', 2: 'H2', 3: 'W2'}}, dynamo=False)
        print(f'書き出しました: {OUT}（{os.path.getsize(OUT) / 1e6:.1f} MB）')


if __name__ == '__main__':
    main()
