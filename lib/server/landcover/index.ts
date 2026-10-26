/**
 * 土地被覆の判定。使える方法のうち、いちばん確かなものを使う。
 */
import type { LandCover, LandCoverClass } from '@/lib/types';
import { COLOR_CLASSES, type ColorClass, colorIndexLandCover } from './colorIndex';

const rgb = ([r, g, b]: [number, number, number]) => `rgb(${r} ${g} ${b})`;

export type LandCoverResult = { landCover: Omit<LandCover, 'overlayUrl'>; overlayPng: Buffer | null };

export async function analyzeLandCover(jpeg: Buffer, areaM2: number): Promise<LandCoverResult> {
  const { counts, valid, overlay } = await colorIndexLandCover(jpeg);
  const classes: LandCoverClass[] = (Object.keys(COLOR_CLASSES) as ColorClass[])
    .map((k) => ({
      key: k,
      label: COLOR_CLASSES[k].label,
      color: rgb(COLOR_CLASSES[k].color),
      ratio: valid ? counts[k] / valid : 0,
      areaM2: valid ? (counts[k] / valid) * areaM2 : 0,
    }))
    .filter((c) => c.ratio > 0.001)
    .sort((a, b) => b.ratio - a.ratio);
  return {
    landCover: {
      method: 'color-index',
      methodLabel: '色の指標による簡易推定（目安）',
      classes,
      notes: ['写真の色（緑の強さ・明るさ・彩度）だけで分けています。影と水面、舗装と屋根は区別できません。'],
    },
    overlayPng: overlay,
  };
}
