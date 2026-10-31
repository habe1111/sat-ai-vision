"""
船の検出モデルを、data/annotations の注釈から学習する（FLAIR-INC の ResNet34-UNet を微調整する）。

    python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
    .venv/bin/python train.py --val-sites kobe,choshi      # 2 地点を外して学習し、その 2 地点で精度を測る
    .venv/bin/python train.py --all --export               # 全地点で学習し、../../models/ship_unet.onnx と .json に書き出す

写真はチップの画像のキャッシュ（.cache/annotate/<id>.jpg。npm run annotate:prepare が作る）を使う。

しくみ：
- 出力は 2 チャンネル。0 は船体（回転矩形を塗ったもの）、1 は「芯」（矩形を幅 30%・長さ 70% に縮めたもの）。
  横に並べて係留された船は船体どうしが接するが、芯は離れるので、芯の塊を 1 隻として数える。
  枠は芯の塊の回転矩形を、縮めた割合で戻して作る（アプリ側の lib/server/ships.ts と同じ計算）。
- 入力の正規化は FLAIR と同じ（学習データの平均・標準偏差）。z18（約 0.5 m/px）の写真を --scale 倍に
  拡大して学習・推論する（FLAIR は 0.2 m/px で学習したモデルなので、拡大したほうが細かい形を拾える）。
- 評価は、予測と正解の回転矩形の IoU が 0.25 以上なら当たりとして、適合率・再現率・F1 を出す。
  数を答えるのに大事な「予測の中心が正解の枠に入るか」でも同じように数える（center_*）。
"""
import argparse
import glob
import json
import os
import random
import time

import cv2
import numpy as np
import segmentation_models_pytorch as smp
import torch
from huggingface_hub import hf_hub_download

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
CHIP_DIR = os.path.join(ROOT, 'data', 'annotations', 'chips')
IMAGE_DIR = os.path.join(ROOT, '.cache', 'annotate')
OUT = os.path.join(ROOT, 'models', 'ship_unet.onnx')
# 推論の設定（倍率・芯の割合）。アプリ（lib/server/ships.ts）はこれを読んで、学習と同じ前処理・後処理をする
OUT_META = os.path.join(ROOT, 'models', 'ship_unet.json')

# FLAIR-INC の重み（2024-08-09 の版。Etalab 2.0）と、その学習データの平均・標準偏差
FLAIR_REPO = 'IGNF/FLAIR-INC_rgb_15cl_resnet34-unet'
FLAIR_REVISION = 'd8a81bc5bc46357677ba0569e83c4c68d3f78b89'
FLAIR_FILE = 'FLAIR-INC_rgb_15cl_resnet34-unet_weights.pth'
MEAN = np.array([105.08, 110.87, 101.82], np.float32)
STD = np.array([52.17, 45.38, 44.0], np.float32)

# 芯の縮め方（--core で変えられる。lib/server/ships.ts と同じ値にする）
CORE_W, CORE_L = 0.3, 0.7
SIZE = 512


def corners(cx, cy, length, width, angle):
    ux, uy = np.cos(angle), np.sin(angle)
    vx, vy = -uy, ux
    hl, hw = length / 2, width / 2
    return np.array([
        [cx + ux * hl + vx * hw, cy + uy * hl + vy * hw],
        [cx + ux * hl - vx * hw, cy + uy * hl - vy * hw],
        [cx - ux * hl - vx * hw, cy - uy * hl - vy * hw],
        [cx - ux * hl + vx * hw, cy - uy * hl + vy * hw],
    ], np.float32)


def load_chips(image_dir=None):
    """船を確認済みのチップ。画像の無いものは飛ばす。image_dir を指定すると、そこにある拡大済みの写真（<id>.png）を使う"""
    out = []
    for f in sorted(glob.glob(os.path.join(CHIP_DIR, '*.json'))):
        c = json.load(open(f, encoding='utf-8'))
        if not c['reviewed']['ship']:
            continue
        img = os.path.join(image_dir, f"{c['id']}.png") if image_dir else os.path.join(IMAGE_DIR, f"{c['id']}.jpg")
        if not os.path.exists(img):
            print(f'写真がありません（npm run annotate:prepare で作ります）: {c["id"]}')
            continue
        ships = [o for o in c['objects'] if o['kind'] == 'ship' and o['status'] == 'accepted']
        out.append({'id': c['id'], 'site': c['site'], 'img': img, 'ships': ships})
    return out


def masks(ships):
    """船体・芯・無視（見えにくい船）のマスク"""
    body = np.zeros((SIZE, SIZE), np.uint8)
    core = np.zeros((SIZE, SIZE), np.uint8)
    ignore = np.zeros((SIZE, SIZE), np.uint8)
    for s in ships:
        full = corners(s['cx'], s['cy'], s['length'], s['width'], s['angle'])
        small = corners(s['cx'], s['cy'], max(1.5, s['length'] * CORE_L), max(1.5, s['width'] * CORE_W), s['angle'])
        if s.get('difficult'):
            cv2.fillPoly(ignore, [np.round(full).astype(np.int32)], 1)
            continue
        cv2.fillPoly(body, [np.round(full).astype(np.int32)], 1)
        cv2.fillPoly(core, [np.round(small).astype(np.int32)], 1)
    return body, core, ignore


class Chips(torch.utils.data.Dataset):
    def __init__(self, chips, train, scale=1.0):
        self.items = []
        self.scale = scale
        n = int(round(SIZE * scale))
        for c in chips:
            rgb = cv2.cvtColor(cv2.imread(c['img']), cv2.COLOR_BGR2RGB)
            ms = masks(c['ships'])
            if n != SIZE:
                ms = tuple(cv2.resize(m, (n, n), interpolation=cv2.INTER_NEAREST) for m in ms)
            # 拡大済みの写真（超解像など）はそのまま使い、そうでなければ bicubic で拡大する
            if rgb.shape[0] != n:
                rgb = cv2.resize(rgb, (n, n), interpolation=cv2.INTER_CUBIC if rgb.shape[0] < n else cv2.INTER_AREA)
            self.items.append((rgb, *ms))
        self.train = train

    def __len__(self):
        # 1 周で同じチップを何度も（違う切り抜き・向きで）使う
        return len(self.items) * (8 if self.train else 1)

    def __getitem__(self, i):
        rgb, body, core, ignore = self.items[i % len(self.items)]
        if self.train:
            # 拡大縮小（0.8〜1.25 倍）・90° 回転・反転・色の揺らし。384 px に切り抜く
            s = random.uniform(0.8, 1.25)
            n = int(round(rgb.shape[0] * s))
            rgb = cv2.resize(rgb, (n, n), interpolation=cv2.INTER_LINEAR)
            body, core, ignore = (cv2.resize(m, (n, n), interpolation=cv2.INTER_NEAREST) for m in (body, core, ignore))
            crop = min(n, 384)
            x, y = random.randint(0, n - crop), random.randint(0, n - crop)
            sl = (slice(y, y + crop), slice(x, x + crop))
            rgb, body, core, ignore = rgb[sl], body[sl], core[sl], ignore[sl]
            k = random.randint(0, 3)
            rgb, body, core, ignore = (np.rot90(a, k) for a in (rgb, body, core, ignore))
            if random.random() < 0.5:
                rgb, body, core, ignore = (a[:, ::-1] for a in (rgb, body, core, ignore))
            rgb = rgb.astype(np.float32)
            rgb = rgb * random.uniform(0.8, 1.2) + random.uniform(-20, 20)
            rgb = rgb * np.array([random.uniform(0.92, 1.08) for _ in range(3)], np.float32)
            rgb = np.clip(rgb, 0, 255)
        x = (rgb.astype(np.float32) - MEAN) / STD
        y = np.stack([body, core]).astype(np.float32)
        return torch.from_numpy(np.ascontiguousarray(x.transpose(2, 0, 1))), torch.from_numpy(np.ascontiguousarray(y)), \
            torch.from_numpy(np.ascontiguousarray(ignore.astype(np.float32)))


def build_model():
    """FLAIR の重みで初期化し、出力ヘッドだけを 2 チャンネル（船体・芯）に付け替える"""
    model = smp.Unet('resnet34', encoder_weights=None, in_channels=3, classes=19)
    sd = torch.load(hf_hub_download(FLAIR_REPO, FLAIR_FILE, revision=FLAIR_REVISION), map_location='cpu', weights_only=True)
    prefix = 'model.seg_model.'
    model.load_state_dict({k[len(prefix):]: v for k, v in sd.items() if k.startswith(prefix)}, strict=True)
    head = model.segmentation_head[0]
    model.segmentation_head[0] = torch.nn.Conv2d(head.in_channels, 2, kernel_size=head.kernel_size, padding=head.padding)
    return model


def loss_fn(logits, y, ignore):
    keep = (1 - ignore).unsqueeze(1)
    bce = torch.nn.functional.binary_cross_entropy_with_logits(logits, y, reduction='none', pos_weight=torch.tensor(3.0, device=y.device))
    bce = (bce * keep).sum() / keep.sum().clamp(min=1) / 2
    p = torch.sigmoid(logits) * keep
    t = y * keep
    dice = 1 - (2 * (p * t).sum((0, 2, 3)) + 1) / (p.sum((0, 2, 3)) + t.sum((0, 2, 3)) + 1)
    return bce + dice.mean()


def decode(prob_core, min_px=6, scale=1.0):
    """芯の確率から 1 隻ずつの回転矩形を作る。[(cx, cy, length, width, angle, score), ...]"""
    m = (prob_core > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
    out = []
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] < min_px * scale * scale:
            continue
        ys, xs = np.nonzero(lab == i)
        # fillPoly は頂点を画素の番号とみなし、両端の画素まで塗る（幅 t の矩形は t+1 画素）。
        # そのため画素の番号のまま測れば、中心も端から端の幅も、注釈の座標と同じになる
        pts = np.stack([xs, ys], 1).astype(np.float32)
        (cx, cy), (w, h), deg = cv2.minAreaRect(pts)
        ang = np.deg2rad(deg)
        if h > w:
            w, h = h, w
            ang += np.pi / 2
        ang = (ang + np.pi / 2) % np.pi - np.pi / 2
        out.append((cx / scale, cy / scale, w / CORE_L / scale, h / CORE_W / scale, ang, float(prob_core[lab == i].mean())))
    return out


def rect_iou(a, b):
    pa, pb = corners(*a[:5]), corners(*b[:5])
    inter, pts = cv2.intersectConvexConvex(pa, pb)
    if inter <= 0:
        return 0.0
    return inter / (cv2.contourArea(pa) + cv2.contourArea(pb) - inter)


def inside(p, g):
    """点 p（予測の中心）が正解の回転矩形 g の中にあるか"""
    dx, dy = p[0] - g[0], p[1] - g[1]
    u = dx * np.cos(g[4]) + dy * np.sin(g[4])
    v = -dx * np.sin(g[4]) + dy * np.cos(g[4])
    return abs(u) <= g[2] / 2 and abs(v) <= g[3] / 2


def match(pred, gt, hit_fn):
    used, hit = set(), 0
    for p in sorted(pred, key=lambda r: -r[5]):
        best, bi = 0.0, -1
        for j, g in enumerate(gt):
            if j not in used:
                v = hit_fn(p, g)
                if v > best:
                    best, bi = v, j
        if bi >= 0:
            used.add(bi)
            hit += 1
    return hit


def predict(model, chip, device, scale):
    x, _, _ = Chips([chip], train=False, scale=scale)[0]
    with torch.no_grad():
        prob = torch.sigmoid(model(x[None].to(device)))[0].cpu().numpy()
    return prob, decode(prob[1], scale=scale)


def evaluate(model, chips, device, scale=1.0):
    model.eval()
    tot = {'iou': [0, 0, 0], 'center': [0, 0, 0]}
    per_site = {}
    count_err = []
    for c in chips:
        _, pred = predict(model, c, device, scale)
        gt = [(s['cx'], s['cy'], s['length'], s['width'], s['angle']) for s in c['ships'] if not s.get('difficult')]
        for key, fn in (('iou', lambda p, g: rect_iou(p, g) if rect_iou(p, g) >= 0.25 else 0),
                        ('center', lambda p, g: 1.0 if inside(p, g) else 0)):
            hit = match(pred, gt, fn)
            t = tot[key]
            t[0] += hit; t[1] += len(pred) - hit; t[2] += len(gt) - hit
            if key == 'iou':
                s = per_site.setdefault(c['site'], [0, 0, 0])
                s[0] += hit; s[1] += len(pred) - hit; s[2] += len(gt) - hit
        count_err.append(abs(len(pred) - len(gt)))
    f = lambda t, p, n: tuple(round(v, 3) for v in (t / max(1, t + p), t / max(1, t + n), 2 * t / max(1, 2 * t + p + n)))
    return {'precision_recall_f1': f(*tot['iou']), 'tp_fp_fn': tuple(tot['iou']),
            'center_precision_recall_f1': f(*tot['center']), 'center_tp_fp_fn': tuple(tot['center']),
            'per_site': {k: f(*v) + (tuple(v),) for k, v in per_site.items()},
            'count_mae_per_chip': round(float(np.mean(count_err)), 3) if count_err else 0.0}


def save_viz(model, chips, device, scale, out_dir):
    """予測（赤）と正解（水色）を描いた画像を残す（どこで外れるかを見るため）"""
    os.makedirs(out_dir, exist_ok=True)
    for c in chips:
        _, pred = predict(model, c, device, scale)
        img = cv2.resize(cv2.imread(c['img']), (SIZE * 2, SIZE * 2), interpolation=cv2.INTER_NEAREST)
        for s in c['ships']:
            cv2.polylines(img, [np.round(corners(s['cx'], s['cy'], s['length'], s['width'], s['angle']) * 2).astype(np.int32)], True, (255, 224, 62), 2)
        for p in pred:
            cv2.polylines(img, [np.round(corners(*p[:5]) * 2).astype(np.int32)], True, (60, 60, 255), 2)
        cv2.imwrite(os.path.join(out_dir, f"{c['id']}.jpg"), img)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--val-sites', default='')
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--epochs', type=int, default=40)
    ap.add_argument('--export', action='store_true')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--core', default='0.3,0.7', help='芯の幅・長さの割合（lib/server/ships.ts と同じ値にする）')
    ap.add_argument('--save', default='', help='学習した重みを保存する場所（.pt）')
    ap.add_argument('--viz', default='', help='評価のチップに予測と正解を描いた画像を残すフォルダ')
    ap.add_argument('--image-dir', default='', help='拡大済みの写真（<id>.png、--scale 倍の大きさ）のフォルダ。超解像と比べるときに使う')
    args = ap.parse_args()
    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed)
    global CORE_W, CORE_L
    CORE_W, CORE_L = (float(v) for v in args.core.split(','))
    device = 'mps' if torch.backends.mps.is_available() else 'cpu'

    chips = load_chips(args.image_dir or None)
    val_sites = set(filter(None, args.val_sites.split(',')))
    train = chips if args.all else [c for c in chips if c['site'] not in val_sites]
    val = [c for c in chips if c['site'] in val_sites]
    print(f'学習 {len(train)} 枚（船 {sum(len(c["ships"]) for c in train)} 隻）・評価 {len(val)} 枚（船 {sum(len(c["ships"]) for c in val)} 隻）・{device}')

    model = build_model().to(device)
    loader = torch.utils.data.DataLoader(Chips(train, train=True, scale=args.scale), batch_size=8, shuffle=True, drop_last=True,
                                         num_workers=0)   # macOS では worker を別プロセスで起こすので、かえって遅くなる
    params = [{'params': model.encoder.parameters(), 'lr': 1e-4},
              {'params': list(model.decoder.parameters()) + list(model.segmentation_head.parameters()), 'lr': 5e-4}]
    opt = torch.optim.AdamW(params, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[1e-4, 5e-4], total_steps=args.epochs * len(loader))
    for epoch in range(args.epochs):
        model.train()
        t0, total = time.time(), 0.0
        for x, y, ign in loader:
            x, y, ign = x.to(device), y.to(device), ign.to(device)
            opt.zero_grad()
            loss = loss_fn(model(x), y, ign)
            loss.backward()
            opt.step()
            sched.step()
            total += loss.item()
        msg = f'{epoch + 1:3d}/{args.epochs} 損失 {total / len(loader):.4f}（{time.time() - t0:.0f} 秒）'
        if val and ((epoch + 1) % 10 == 0 or epoch + 1 == args.epochs):
            r = evaluate(model, val, device, args.scale)
            p, rc, f1 = r['precision_recall_f1']
            msg += f'　評価：適合率 {p:.3f}・再現率 {rc:.3f}・F1 {f1:.3f}（中心で F1 {r["center_precision_recall_f1"][2]:.3f}）'
        print(msg, flush=True)

    if args.save:
        torch.save(model.state_dict(), args.save)
    if val:
        r = evaluate(model, val, device, args.scale)
        print(json.dumps(r, ensure_ascii=False))
        if args.viz:
            save_viz(model, val, device, args.scale, args.viz)

    if args.export:
        model.eval().cpu()
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        torch.onnx.export(model, torch.randn(1, 3, 512, 512), OUT, opset_version=17, input_names=['input'],
                          output_names=['logits'], dynamic_axes={'input': {0: 'N', 2: 'H', 3: 'W'}, 'logits': {0: 'N', 2: 'H', 3: 'W'}},
                          dynamo=False)
        import onnxruntime as ort
        x = np.random.default_rng(0).normal(size=(1, 3, SIZE, SIZE)).astype(np.float32)
        with torch.no_grad():
            want = model(torch.from_numpy(x)).numpy()
        got = ort.InferenceSession(OUT, providers=['CPUExecutionProvider']).run(None, {'input': x})[0]
        with open(OUT_META, 'w', encoding='utf-8') as f:
            json.dump({'scale': args.scale, 'core_w': CORE_W, 'core_l': CORE_L, 'patch': 512,
                       'mean': MEAN.tolist(), 'std': STD.tolist(), 'epochs': args.epochs}, f, ensure_ascii=False, indent=1)
        print(f'書き出しました: {OUT}（{os.path.getsize(OUT) / 1e6:.1f} MB、最大誤差 {np.abs(want - got).max():.2e}、'
              f'推論は写真を {args.scale} 倍にして 512 px の窓で）')


if __name__ == '__main__':
    main()
