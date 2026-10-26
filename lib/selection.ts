/**
 * 解析範囲の決まりごと。画面（選んだ時点の見込み表示）とサーバー（実際の取得）の両方が使う。
 */
import { type BBox, bboxPixelSize, metersPerPixel } from '@/lib/geo';
import { IMAGERY_MAX_ZOOM } from '@/lib/imagery';

/** 解析に回す画像の長辺の上限（px）。これを超える範囲はズームを下げる */
export const MAX_IMAGE_PX = 4096;
/** 解析に使うズームの下限。これより粗いと地物が判別できない（z16 で約 2 m/px） */
export const MIN_ANALYSIS_ZOOM = 16;
/** 短辺の下限（px）。小さすぎる範囲は AI も判別できない */
export const MIN_IMAGE_PX = 128;

export type ZoomChoice =
  | { ok: true; zoom: number; width: number; height: number; metersPerPixel: number }
  | { ok: false; reason: string };

/** 範囲に合う最も細かいズームを選ぶ。広すぎる・狭すぎるときは理由を返す */
export function chooseZoom(bbox: BBox): ZoomChoice {
  for (let z = IMAGERY_MAX_ZOOM; z >= MIN_ANALYSIS_ZOOM; z--) {
    const { width, height } = bboxPixelSize(bbox, z);
    if (Math.max(width, height) > MAX_IMAGE_PX) continue;
    if (Math.min(width, height) < MIN_IMAGE_PX) {
      return { ok: false, reason: '範囲が狭すぎます。一辺 60 m 以上を目安に選んでください。' };
    }
    return { ok: true, zoom: z, width, height, metersPerPixel: metersPerPixel((bbox[1] + bbox[3]) / 2, z) };
  }
  return { ok: false, reason: '範囲が広すぎます。一辺 8 km 以内を目安に選び直してください。' };
}
