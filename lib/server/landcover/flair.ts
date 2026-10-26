/**
 * 土地被覆のセグメンテーション（IGN FLAIR-INC、RGB・15 クラス、ResNet34-UNet）。
 *
 * フランスの航空写真（0.2 m/px）で学習したモデルを ONNX にしたもの。日本の地理院写真で
 * 実測した結果（2026-10、6 地点）から、使い方を次のように決めている。
 *
 * - **約 0.33 m/px（z18 の写真を 1.5 倍）に拡大して推論する。** 等倍（0.49 m）では港の水面が
 *   消え、戸建住宅が道路に埋もれる。2 倍では都心のビルに農地・温室の斑点が出る。1.5 倍は
 *   住宅（建物 16%→40%）と都心（ほぼ等倍並み）の両方で崩れなかった。
 * - **15 クラスを 7 区分にまとめる。** 針葉樹と広葉樹の区別（吉野の杉林が広葉樹になる）や、
 *   温室・ぶどう畑・プールは日本では当てにならない。区分ごとに確率を足してから最大を取る。
 *
 * モデル（約 98 MB）はリポジトリに入れず models/ に置く（npm run setup:model）。
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-node';
import sharp from 'sharp';

export const FLAIR_MODEL_PATH = path.join(process.cwd(), 'models', 'flair_rgb15.onnx');

/** 学習データ（TRAIN+VAL）の平均と標準偏差。モデルカードの値 */
const MEAN = [105.08, 110.87, 101.82];
const STD = [52.17, 45.38, 44.0];
const PATCH = 512;
const STRIDE = 384;
/** 推論する解像度の目安（m/px）。z18 の写真なら 1.5 倍になる */
const TARGET_MPP = 0.33;
/** 拡大後の長辺の上限（px）。これを超えると時間が掛かりすぎる（121 パッチ ≒ 十数秒） */
const MAX_WORK_PX = 4096;
/** 結果を集計する解像度の長辺の上限（px）。メモリを抑えるため */
const MAX_OUT_PX = 2048;

/** 表示する 7 区分と、FLAIR の 15 クラス（番号）の対応 */
export const FLAIR_GROUPS = [
  { key: 'building', label: '建物', color: [219, 40, 150], classes: [0, 14] },       // 建物・温室（青い屋根やホーム屋根が温室になるため建物へ）
  { key: 'paved', label: '舗装地（道路・駐車場）', color: [226, 72, 56], classes: [2] },
  { key: 'bare', label: '裸地・未舗装地（線路・グラウンドなど）', color: [176, 132, 70], classes: [1, 3] },  // 透水面（線路・グラウンド・枯れ芝）と裸地
  { key: 'water', label: '水域', color: [40, 98, 190], classes: [4, 12] },
  { key: 'forest', label: '森林', color: [28, 112, 60], classes: [5, 6, 7] },        // 針葉樹・広葉樹・低木は分けない
  { key: 'grass', label: '草地・芝生', color: [120, 200, 70], classes: [9] },
  { key: 'farm', label: '農地（田畑）', color: [232, 206, 60], classes: [8, 10, 11] },
] as const;
// 13（雪）は日本の写真では出ないので使わない

/** クラス番号 → 区分の番号（使わないクラスは -1）。画素ごとの集計で使う */
const GROUP_OF = (() => {
  const t = new Int8Array(15).fill(-1);
  FLAIR_GROUPS.forEach((g, gi) => g.classes.forEach((c) => { t[c] = gi; }));
  return t;
})();

export function flairAvailable(): boolean {
  return fs.existsSync(FLAIR_MODEL_PATH);
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
function session() {
  // 作るのに数秒かかるので、最初の 1 回だけ作って使い回す。
  // Mac では CoreML（Neural Engine / GPU）を使い、他の環境は CPU で動かす
  sessionPromise ??= ort.InferenceSession.create(FLAIR_MODEL_PATH, {
    executionProviders: process.platform === 'darwin' ? ['coreml', 'cpu'] : ['cpu'],
  }).catch((e) => {
    sessionPromise = null;
    throw e;
  });
  return sessionPromise;
}

/** パッチの重み（2 次元のハン窓）。重なりの継ぎ目を目立たなくする */
const HANN = (() => {
  const w = new Float32Array(PATCH);
  for (let i = 0; i < PATCH; i++) w[i] = Math.sin((Math.PI * (i + 1)) / (PATCH + 1)) ** 2;
  const w2 = new Float32Array(PATCH * PATCH);
  for (let y = 0; y < PATCH; y++) for (let x = 0; x < PATCH; x++) w2[y * PATCH + x] = Math.max(w[y] * w[x], 1e-3);
  return w2;
})();

function starts(len: number): number[] {
  const out: number[] = [];
  for (let s = 0; s + PATCH <= len; s += STRIDE) out.push(s);
  if (out.length === 0 || out[out.length - 1] + PATCH < len) out.push(Math.max(0, len - PATCH));
  return out;
}

export type FlairResult = {
  counts: number[];          // 区分ごとの画素数（FLAIR_GROUPS の順）
  valid: number;
  overlay: Buffer;           // PNG（区分の色を塗った重ね絵）
  scale: number;             // 推論に使った拡大率
  workMpp: number;           // 推論した解像度（m/px）
  seconds: number;
};

export async function runFlair(
  jpeg: Buffer,
  mpp: number,
  onProgress?: (done: number, total: number) => void,
): Promise<FlairResult> {
  const t0 = performance.now();
  const sess = await session();
  const meta = await sharp(jpeg).metadata();
  const W0 = meta.width!, H0 = meta.height!;

  // 推論する大きさ：0.33 m/px を目指して拡大し、長辺 4096 px で頭打ち
  let scale = Math.max(1, mpp / TARGET_MPP);
  scale = Math.min(scale, MAX_WORK_PX / Math.max(W0, H0));
  scale = Math.max(scale, PATCH / Math.min(W0, H0), 0.25); // 短辺が 1 パッチに満たないときは広げる
  const W = Math.max(PATCH, Math.round(W0 * scale));
  const H = Math.max(PATCH, Math.round(H0 * scale));
  const { data: rgb } = await sharp(jpeg)
    .resize(W, H, { fit: 'fill', kernel: 'cubic' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 集計は元の画像の解像度（上限 2048 px）で行う
  const outScale = Math.min(1, MAX_OUT_PX / Math.max(W0, H0));
  const OW = Math.max(1, Math.round(W0 * outScale));
  const OH = Math.max(1, Math.round(H0 * outScale));
  const G = FLAIR_GROUPS.length;
  const acc = new Float32Array(G * OW * OH);
  const toOx = OW / W, toOy = OH / H;

  const ys = starts(H), xs = starts(W);
  const total = ys.length * xs.length;
  const input = new Float32Array(3 * PATCH * PATCH);
  const gp = new Float32Array(FLAIR_GROUPS.length);   // 画素ごとの区分別の確率（作業用）
  let done = 0;
  for (const py of ys) {
    for (const px of xs) {
      for (let y = 0; y < PATCH; y++) {
        for (let x = 0; x < PATCH; x++) {
          const si = ((py + y) * W + (px + x)) * 3;
          const di = y * PATCH + x;
          input[di] = (rgb[si] - MEAN[0]) / STD[0];
          input[PATCH * PATCH + di] = (rgb[si + 1] - MEAN[1]) / STD[1];
          input[2 * PATCH * PATCH + di] = (rgb[si + 2] - MEAN[2]) / STD[2];
        }
      }
      const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, PATCH, PATCH]) });
      const logits = out[sess.outputNames[0]].data as Float32Array;   // [1, 15, 512, 512]
      const N = PATCH * PATCH;
      for (let i = 0; i < N; i++) {
        // softmax（最大値を引いてから exp）
        let m = -Infinity;
        for (let c = 0; c < 15; c++) m = Math.max(m, logits[c * N + i]);
        let s = 0;
        gp.fill(0);
        for (let c = 0; c < 15; c++) {
          const e = Math.exp(logits[c * N + i] - m);
          s += e;
          if (GROUP_OF[c] >= 0) gp[GROUP_OF[c]] += e;
        }
        // 画素ごとに最大の区分を選ぶだけなので、重みの合計で割り戻す必要は無い
        const w = HANN[i] / s;
        const oi = Math.min(OH - 1, Math.floor((py + (i / PATCH | 0)) * toOy)) * OW
          + Math.min(OW - 1, Math.floor((px + (i % PATCH)) * toOx));
        for (let g = 0; g < G; g++) acc[g * OW * OH + oi] += gp[g] * w;
      }
      onProgress?.(++done, total);
    }
  }

  // 区分ごとの確率の和が最大のものを、その画素の区分にする。写真の無い（黒い）画素は数えない
  const { data: small } = await sharp(jpeg).resize(OW, OH, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const counts = new Array<number>(G).fill(0);
  const mask = Buffer.alloc(OW * OH * 4);
  let valid = 0;
  for (let i = 0; i < OW * OH; i++) {
    if (small[i * 3] < 3 && small[i * 3 + 1] < 3 && small[i * 3 + 2] < 3) continue;
    let best = 0;
    for (let g = 1; g < G; g++) if (acc[g * OW * OH + i] > acc[best * OW * OH + i]) best = g;
    counts[best]++;
    valid++;
    const [r, gg, b] = FLAIR_GROUPS[best].color;
    mask[i * 4] = r; mask[i * 4 + 1] = gg; mask[i * 4 + 2] = b; mask[i * 4 + 3] = 255;
  }
  const overlay = await sharp(mask, { raw: { width: OW, height: OH, channels: 4 } }).png().toBuffer();
  return { counts, valid, overlay, scale, workMpp: mpp / scale, seconds: (performance.now() - t0) / 1000 };
}
