/**
 * 色だけで土地被覆をざっくり分ける（依存なし・必ず動く代替経路）。
 *
 * 空中写真は可視光（RGB）しかなく、植生指数の NDVI に要る近赤外が無い。そこで
 * 緑の強さを表す ExG（2g − r − b、正規化した rgb で計算）と、明るさ・彩度で分ける。
 * 影と水、舗装と屋根は色だけでは区別できないので、結果は「目安」として扱う。
 */
import sharp from 'sharp';

export type ColorClass = 'vegetation' | 'artificial' | 'bare' | 'dark' | 'other';

export const COLOR_CLASSES: Record<ColorClass, { label: string; color: [number, number, number] }> = {
  vegetation: { label: '植生（樹木・草地・水田）', color: [76, 140, 74] },
  artificial: { label: '人工物（建物・舗装）', color: [184, 92, 92] },
  bare: { label: '裸地・土', color: [196, 160, 98] },
  dark: { label: '影・水面（暗部）', color: [62, 98, 150] },
  other: { label: 'その他', color: [150, 150, 150] },
};

export function classifyPixel(r: number, g: number, b: number): ColorClass {
  const sum = r + g + b;
  const v = sum / 765;                          // 明るさ 0〜1
  if (v < 0.13) return 'dark';
  const exg = (2 * g - r - b) / sum;            // 正規化した ExG
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sat = max === 0 ? 0 : (max - min) / max;
  if (exg > 0.04 && g >= r) return 'vegetation';
  if (sat < 0.14) return 'artificial';          // 灰色系：コンクリート・アスファルト・屋根
  if (r > b && r >= g * 0.95) return 'bare';    // 赤みのある土・グラウンド
  return 'other';
}

export async function colorIndexLandCover(jpeg: Buffer, maxSide = 1024) {
  const { data, info } = await sharp(jpeg)
    .resize({ width: maxSide, height: maxSide, fit: 'inside' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const counts: Record<ColorClass, number> = { vegetation: 0, artificial: 0, bare: 0, dark: 0, other: 0 };
  const mask = Buffer.alloc(info.width * info.height * 4);
  let valid = 0;
  for (let i = 0, p = 0; i < data.length; i += 3, p += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r === 0 && g === 0 && b === 0) continue;   // 写真の無い部分（黒で埋めたタイル）
    const c = classifyPixel(r, g, b);
    counts[c]++;
    valid++;
    const [cr, cg, cb] = COLOR_CLASSES[c].color;
    mask[p] = cr; mask[p + 1] = cg; mask[p + 2] = cb; mask[p + 3] = 255;
  }
  const overlay = await sharp(mask, { raw: { width: info.width, height: info.height, channels: 4 } }).png().toBuffer();
  return { counts, valid, overlay };
}
