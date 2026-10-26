/**
 * 土地被覆の判定。使える方法のうち、いちばん確かなものを使う。
 *
 * 1. FLAIR（セグメンテーションモデル）… models/flair_rgb15.onnx があるとき
 * 2. 色の指標による簡易推定 … モデルが無い・読み込めないとき（必ず動く）
 *
 * 割合は写真のある画素に対する値、面積は 1 画素の面積 × 画素数で出す。
 * タイルが無く黒で埋めた部分（海上・提供範囲外）は、どの区分にも数えない。
 */
import type { LandCover, LandCoverClass } from '@/lib/types';
import { COLOR_CLASSES, type ColorClass, colorIndexLandCover } from './colorIndex';
import { FLAIR_GROUPS, flairAvailable, runFlair } from './flair';

export { flairAvailable };

const rgb = ([r, g, b]: readonly [number, number, number] | readonly number[]) => `rgb(${r} ${g} ${b})`;

/** FLAIR の出典表示（Etalab 2.0 は、提供者名と最終更新日の明示を求める） */
export const FLAIR_CREDIT =
  '土地被覆：IGN FLAIR-INC（RGB・15クラス、2024-08-09 更新、Etalab 2.0）を ONNX に変換して使用';

export type LandCoverResult = { landCover: Omit<LandCover, 'overlayUrl'>; overlayPng: Buffer | null; credit: string | null };

function toClasses(
  defs: { key: string; label: string; color: readonly number[] }[],
  counts: number[],
  valid: number,
  total: number,
  areaM2: number,
): LandCoverClass[] {
  const pixelM2 = total ? areaM2 / total : 0;
  return defs
    .map((d, i) => ({
      key: d.key,
      label: d.label,
      color: rgb(d.color),
      ratio: valid ? counts[i] / valid : 0,
      areaM2: counts[i] * pixelM2,
    }))
    .filter((c) => c.ratio > 0.001)
    .sort((a, b) => b.ratio - a.ratio);
}

/** 写真の無い部分があるとき、割合の分母が範囲全体ではないことを知らせる */
function missingNote(valid: number, total: number): string {
  const covered = total ? valid / total : 1;
  return covered < 0.99
    ? `割合は写真のある部分（範囲の約 ${Math.round(covered * 100)}%）に対する値です。写真の無い部分は面積にも含めていません。`
    : '';
}

function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === 'AbortError';
}

export async function analyzeLandCover(
  jpeg: Buffer,
  mpp: number,
  areaM2: number,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<LandCoverResult> {
  if (flairAvailable()) {
    try {
      const r = await runFlair(jpeg, mpp, signal, onProgress);
      const notes = [
        'フランスの航空写真で学習したモデルの判定です。数値は目安としてお読みください。',
        '波のある海面は、裸地や舗装地と判定されることがあります。',
      ];
      if (r.workMpp > 0.6) notes.push(`写真の解像度が粗い（約 ${r.workMpp.toFixed(2)} m/px）ため、小さな建物や道路は判定しにくくなります。`);
      const missing = missingNote(r.valid, r.total);
      if (missing) notes.push(missing);
      return {
        landCover: {
          method: 'segmentation',
          methodLabel: `土地被覆モデル FLAIR による判定（約 ${r.workMpp.toFixed(2)} m/px で推論、${r.seconds.toFixed(1)} 秒）`,
          classes: toClasses([...FLAIR_GROUPS], r.counts, r.valid, r.total, areaM2),
          notes,
        },
        overlayPng: r.overlay,
        credit: FLAIR_CREDIT,
      };
    } catch (e) {
      // 中止は失敗ではないので、簡易推定に切り替えずにそのまま止める
      if (isAbort(e) || signal.aborted) throw e;
      // モデルが壊れている・実行できない環境では、簡易推定に切り替えて止めない
      console.error('[landcover] FLAIR を実行できませんでした。色の指標で推定します。', e);
    }
  }

  signal.throwIfAborted();
  const { counts, valid, total, overlay } = await colorIndexLandCover(jpeg);
  const keys = Object.keys(COLOR_CLASSES) as ColorClass[];
  return {
    landCover: {
      method: 'color-index',
      methodLabel: '色の指標による簡易推定（目安）',
      classes: toClasses(keys.map((k) => ({ key: k, ...COLOR_CLASSES[k] })), keys.map((k) => counts[k]), valid, total, areaM2),
      notes: [
        '写真の色（緑の強さ・明るさ・彩度）だけで分けています。影と水面、舗装と屋根は区別できません。',
        flairAvailable() ? '' : '「npm run setup」で土地被覆モデルを入れると、建物・道路・農地などを判定できます。',
        missingNote(valid, total),
      ].filter(Boolean),
    },
    overlayPng: overlay,
    credit: null,
  };
}
