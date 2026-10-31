/**
 * 範囲の中の船を、自前で学習した検出モデル（models/ship_unet.onnx）で数える（サーバー専用）。
 *
 * モデルは data/annotations の注釈で FLAIR-INC の ResNet34-UNet を微調整したもの（tools/ship-train）。
 * 出力は「船体」と「芯（船体を幅 30%・長さ 70% に縮めたもの）」の 2 つで、横に並べて係留された船も
 * 芯は離れるので、芯の塊を 1 隻として数え、縮めた割合で戻して枠にする（tools/ship-train/train.py と同じ計算）。
 *
 * 学習は z18（約 0.5 m/px）の写真を拡大したもので行ったので（倍率は models/ship_unet.json）、解析の写真の解像度によらず
 * z18 の写真を取り直し、同じ倍率に拡大して推論する。
 * 範囲が広いとタイルと時間がかかりすぎるので、一辺 SHIP_MAX_PX（z18 の画素）までに限る。
 * モデルが無ければ使わない（AI は「1 隻ずつは数えられない」と答える）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';
import { type BBox, latToPx, lonToPx, metersPerPixel, pxToLat, pxToLon } from '@/lib/geo';
import type { MapObjects } from '@/lib/types';
import { stitchBBox } from '@/lib/server/tiles';

export const SHIP_MODEL_PATH = path.join(process.cwd(), 'models', 'ship_unet.onnx');
const Z = 18;
const PATCH = 512;
const STRIDE = 384;
/** 推論の設定（倍率・芯の割合）。学習の書き出し（tools/ship-train/train.py）がモデルの隣に残す */
const SHIP_META_PATH = path.join(process.cwd(), 'models', 'ship_unet.json');
type ShipMeta = { scale: number; core_w: number; core_l: number };
/** 推論する写真の一辺の上限（z18 の画素。約 1 km。2 倍に拡大すると 4096 px、窓は約 120 枚） */
export const SHIP_MAX_PX = 2048;
/** 芯の塊の最小の大きさ（拡大する前の画素）。これより小さいものは雑音とみなす（train.py の decode と同じ） */
const MIN_CORE_PX = 6;

function readMeta(): ShipMeta {
  const m = JSON.parse(fs.readFileSync(SHIP_META_PATH, 'utf8')) as Partial<ShipMeta>;
  if (!(Number(m.scale) > 0 && Number(m.core_w) > 0 && Number(m.core_l) > 0)) {
    throw new Error('船の検出モデルの設定（models/ship_unet.json）が正しくありません');
  }
  return { scale: Number(m.scale), core_w: Number(m.core_w), core_l: Number(m.core_l) };
}
/** FLAIR と同じ正規化（学習データの平均・標準偏差） */
const MEAN = [105.08, 110.87, 101.82];
const STD = [52.17, 45.38, 44.0];

export const SHIP_SOURCE = '検出モデル（sat_ai_vision。国土地理院の写真に付けた注釈で FLAIR-INC を微調整、注釈は CC BY 4.0）';

export function shipModelAvailable(): boolean {
  return fs.existsSync(SHIP_MODEL_PATH) && fs.existsSync(SHIP_META_PATH);
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
function session() {
  sessionPromise ??= ort.InferenceSession.create(SHIP_MODEL_PATH, {
    executionProviders: process.platform === 'darwin' ? ['coreml', 'cpu'] : ['cpu'],
  }).catch((e) => {
    sessionPromise = null;
    throw e;
  });
  return sessionPromise;
}

/** 推論は 1 本ずつ（土地被覆と同じく、メインスレッドをふさぐので重ねない） */
let queue: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

export type Ship = {
  /** 回転した矩形の 4 隅（経緯度） */
  ring: [number, number][];
  center: [number, number];
  lengthM: number;
  widthM: number;
  /** 芯の確率の平均（0〜1） */
  score: number;
};

export class ShipAreaError extends Error {}

function starts(len: number): number[] {
  const out: number[] = [];
  for (let s = 0; s + PATCH <= len; s += STRIDE) out.push(s);
  if (out.length === 0 || out[out.length - 1] + PATCH < len) out.push(Math.max(0, len - PATCH));
  return out;
}

/** 範囲の中の船（中心が範囲に入るもの） */
export function shipsIn(bbox: BBox, signal: AbortSignal): Promise<Ship[]> {
  const [w, s, e, n] = bbox;
  const W0 = Math.round(lonToPx(e, Z) - lonToPx(w, Z)), H0 = Math.round(latToPx(s, Z) - latToPx(n, Z));
  if (Math.max(W0, H0) > SHIP_MAX_PX) {
    const km = (SHIP_MAX_PX * metersPerPixel((s + n) / 2, Z) / 1000).toFixed(1);
    return Promise.reject(new ShipAreaError(`船を数えられるのは一辺 約 ${km} km までの範囲です`));
  }
  return exclusive(async () => {
    signal.throwIfAborted();
    const sess = await session();
    const meta = readMeta();
    const SHIP_SCALE = meta.scale;
    const st = await stitchBBox(bbox, Z, signal);
    // 学習と同じ倍率に拡大する。1 枚の窓に満たない小さな範囲は、黒で埋めて広げる
    const sw = Math.round(st.width * SHIP_SCALE), sh = Math.round(st.height * SHIP_SCALE);
    const W = Math.max(PATCH, sw), H = Math.max(PATCH, sh);
    const { data: rgb } = await sharp(st.image)
      .resize(sw, sh, { fit: 'fill', kernel: 'cubic' })
      .extend({ right: W - sw, bottom: H - sh, background: '#000000' })
      .removeAlpha().raw().toBuffer({ resolveWithObject: true });

    // 窓を重ねて推論し、芯の確率を平均する
    const sum = new Float32Array(W * H), cnt = new Uint8Array(W * H);
    const input = new Float32Array(3 * PATCH * PATCH);
    const N = PATCH * PATCH;
    for (const py of starts(H)) {
      for (const px of starts(W)) {
        signal.throwIfAborted();
        for (let y = 0; y < PATCH; y++) {
          for (let x = 0; x < PATCH; x++) {
            const si = ((py + y) * W + (px + x)) * 3, di = y * PATCH + x;
            input[di] = (rgb[si] - MEAN[0]) / STD[0];
            input[N + di] = (rgb[si + 1] - MEAN[1]) / STD[1];
            input[2 * N + di] = (rgb[si + 2] - MEAN[2]) / STD[2];
          }
        }
        const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, PATCH, PATCH]) });
        const logits = out[sess.outputNames[0]].data as Float32Array;   // [1, 2, 512, 512]
        for (let i = 0; i < N; i++) {
          const oi = (py + ((i / PATCH) | 0)) * W + px + (i % PATCH);
          sum[oi] += 1 / (1 + Math.exp(-logits[N + i]));
          cnt[oi]++;
        }
      }
    }
    const prob = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) prob[i] = cnt[i] ? sum[i] / cnt[i] : 0;

    // 写真の左上の世界座標（stitchBBox は範囲の西端・北端から切り抜く）
    const left = lonToPx(w, Z), top = latToPx(n, Z);
    const mpp = st.metersPerPixel;
    return decode(prob, W, H, MIN_CORE_PX * SHIP_SCALE * SHIP_SCALE, meta)
      .map((b) => toShip({ ...b, cx: b.cx / SHIP_SCALE, cy: b.cy / SHIP_SCALE, length: b.length / SHIP_SCALE, width: b.width / SHIP_SCALE }, left, top, mpp))
      .filter((sh) => sh.center[0] >= w && sh.center[0] <= e && sh.center[1] >= s && sh.center[1] <= n);
  });
}

type PixelBox = { cx: number; cy: number; length: number; width: number; angle: number; score: number };

/**
 * 芯の確率が 0.5 を超える塊ごとに、主軸に沿った矩形を測り、縮めた割合で戻す。
 * 学習のマスクは頂点を画素の番号とみなして両端まで塗ったもの（幅 t が t+1 画素）なので、
 * 画素の番号のまま端から端を測れば元の幅になる（train.py の decode と同じ）
 */
function decode(prob: Float32Array, W: number, H: number, minPx: number, meta: ShipMeta): PixelBox[] {
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out: PixelBox[] = [];
  for (let start = 0; start < W * H; start++) {
    if (prob[start] <= 0.5 || seen[start]) continue;
    let top = 0;
    const px: number[] = [];
    stack[top++] = start;
    seen[start] = 1;
    while (top) {
      const i = stack[--top];
      px.push(i);
      const x = i % W, y = (i / W) | 0;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) if (j >= 0 && !seen[j] && prob[j] > 0.5) { seen[j] = 1; stack[top++] = j; }
    }
    if (px.length < minPx) continue;
    let sx = 0, sy = 0, sp = 0;
    for (const i of px) { sx += i % W; sy += (i / W) | 0; sp += prob[i]; }
    const mx = sx / px.length, my = sy / px.length;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const i of px) {
      const dx = (i % W) - mx, dy = ((i / W) | 0) - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const i of px) {
      const dx = (i % W) - mx, dy = ((i / W) | 0) - my;
      const u = dx * ux + dy * uy, v = -dx * uy + dy * ux;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    out.push({
      cx: mx + uc * ux - vc * uy,
      cy: my + uc * uy + vc * ux,
      length: Math.max(1, u1 - u0) / meta.core_l,
      width: Math.max(1, v1 - v0) / meta.core_w,
      angle,
      score: sp / px.length,
    });
  }
  return out;
}

function toShip(b: PixelBox, left: number, top: number, mpp: number): Ship {
  const ux = Math.cos(b.angle), uy = Math.sin(b.angle), vx = -uy, vy = ux;
  const hl = b.length / 2, hw = b.width / 2;
  const pts: [number, number][] = [
    [b.cx + ux * hl + vx * hw, b.cy + uy * hl + vy * hw],
    [b.cx + ux * hl - vx * hw, b.cy + uy * hl - vy * hw],
    [b.cx - ux * hl - vx * hw, b.cy - uy * hl - vy * hw],
    [b.cx - ux * hl + vx * hw, b.cy - uy * hl + vy * hw],
  ];
  const ll = (x: number, y: number): [number, number] => [pxToLon(left + x, Z), pxToLat(top + y, Z)];
  const ring = pts.map(([x, y]) => ll(x, y));
  ring.push(ring[0]);
  return { ring, center: ll(b.cx, b.cy), lengthM: b.length * mpp, widthM: b.width * mpp, score: b.score };
}

/** 画面と AI に渡す形にする。scope は数えた範囲 */
export function shipObjects(ships: Ship[], scope: string): MapObjects {
  const size = (m: number) => (m >= 50 ? '大型（50 m 以上）' : m >= 15 ? '中型（15〜50 m）' : '小型（15 m 未満）');
  const counts = new Map<string, number>();
  for (const sh of ships) counts.set(size(sh.lengthM), (counts.get(size(sh.lengthM)) ?? 0) + 1);
  const order = ['大型（50 m 以上）', '中型（15〜50 m）', '小型（15 m 未満）'];
  return {
    kind: 'ship',
    label: '船',
    unit: '隻',
    count: ships.length,
    basis: '検出モデル',
    summary: '',
    scope,
    breakdown: order.filter((k) => counts.has(k)).map((label) => ({ label, count: counts.get(label)! })),
    source: SHIP_SOURCE,
    note: '写真から自動で見つけた数です。横に並んだ小舟の数え違いや、桟橋・波の取り違えがあります。'
      + '写真の撮影時の船で、いまの様子とは違います。',
    geojson: {
      type: 'FeatureCollection',
      features: ships.map((sh) => ({
        type: 'Feature',
        properties: { lengthM: Math.round(sh.lengthM), score: Math.round(sh.score * 100) / 100 },
        geometry: { type: 'Polygon', coordinates: [sh.ring] },
      })),
    },
  };
}
