import sharp from 'sharp';
import { CHIP_PX, type Chip, type ObjectKind, shipCorners } from '@/lib/annotate';
import { DEV_ONLY, notFound } from '@/lib/server/annotate/devOnly';
import { chipLandCover, chipPhoto, readChip } from '@/lib/server/annotate/store';

/**
 * チップの画像。
 * - photo.jpg … 写真
 * - landcover.png … 土地被覆の重ね絵（候補を出すのに使ったもの）
 * - preview.png … 写真に注釈を番号付きで描いた拡大画像（?scale=1〜4）。Claude が下付けするときに見る。
 *   ?grid=1 で 64 px ごとの目盛り（チップの画素）を描く（写真から位置を読み取るため）。?kind=ship|car でその種類だけ
 */
export async function GET(request: Request, ctx: RouteContext<'/api/dev/annotate/[chip]/[file]'>) {
  if (!DEV_ONLY) return notFound();
  const { chip: id, file } = await ctx.params;
  try {
    if (file === 'photo.jpg') {
      const buf = await chipPhoto(id, request.signal);
      return buf ? image(buf, 'image/jpeg') : notFound();
    }
    if (file === 'landcover.png') {
      const buf = await chipLandCover(id, request.signal);
      return buf ? image(buf, 'image/png') : notFound();
    }
    if (file === 'preview.png') {
      const chip = await readChip(id);
      const photo = chip && (await chipPhoto(id, request.signal));
      if (!chip || !photo) return notFound();
      const q = new URL(request.url).searchParams;
      // 画像の大きさは整数でないといけないので、倍率は 1〜4 の整数にする
      const scale = Math.min(4, Math.max(1, Math.round(Number(q.get('scale')) || 2)));
      const kind = q.get('kind');
      return new Response(new Uint8Array(await preview(chip, photo, scale, q.get('grid') === '1', kind === 'ship' || kind === 'car' ? kind : null)), {
        headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' },
      });
    }
  } catch (e) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error('[annotate]', e);
    return new Response('画像を作れませんでした', { status: 500 });
  }
  return notFound();
}

function image(buf: Buffer, type: string): Response {
  // 写真はタイル座標で決まるので変わらない。重ね絵も同じチップでは作り直さない
  return new Response(new Uint8Array(buf), { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' } });
}

/** 未確認は黄色の破線、確認済みは水色の実線。番号は objects の並び（1 始まり。種類で絞っても変えない） */
async function preview(chip: Chip, photo: Buffer, scale: number, grid: boolean, kind: ObjectKind | null): Promise<Buffer> {
  const size = CHIP_PX * scale;
  const lines: string[] = [];
  if (grid) {
    for (let v = 64; v < CHIP_PX; v += 64) {
      const p = v * scale;
      lines.push(`<line x1="${p}" y1="0" x2="${p}" y2="${size}" stroke="#fff" stroke-opacity="0.45" stroke-width="1"/>`);
      lines.push(`<line x1="0" y1="${p}" x2="${size}" y2="${p}" stroke="#fff" stroke-opacity="0.45" stroke-width="1"/>`);
      const t = (x: number, y: number) => `<text x="${x}" y="${y}" font-size="12" font-family="sans-serif" fill="#fff" stroke="#000" stroke-width="3" paint-order="stroke">${v}</text>`;
      lines.push(t(p + 2, 12), t(2, p - 2));
    }
  }
  const marks = chip.objects.map((o, i) => {
    if (kind && o.kind !== kind) return '';
    const color = o.status === 'accepted' ? '#3ee0ff' : '#ffd400';
    const dash = o.status === 'accepted' ? '' : ' stroke-dasharray="6 4"';
    const label = (x: number, y: number) =>
      `<text x="${x}" y="${y}" font-size="${11 + scale * 2}" font-family="sans-serif" font-weight="700" fill="${color}" stroke="#000" stroke-width="3" paint-order="stroke">${i + 1}</text>`;
    if (o.kind === 'car') {
      const x = o.x * scale, y = o.y * scale, r = 3 * scale;
      return `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="2"${dash}/>${label(x + r + 2, y - r)}`;
    }
    const pts = shipCorners(o).map(([x, y]) => `${x * scale},${y * scale}`).join(' ');
    return `<polygon points="${pts}" fill="none" stroke="${color}" stroke-width="2"${dash}/>${label(o.cx * scale + 4, o.cy * scale - 4)}`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">${lines.join('')}${marks.join('')}</svg>`;
  return sharp(photo)
    .resize(size, size, { kernel: 'nearest' })
    .composite([{ input: Buffer.from(svg) }])
    .png()
    .toBuffer();
}
