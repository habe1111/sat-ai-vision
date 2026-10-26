import fs from 'node:fs/promises';
import path from 'node:path';
import { ANALYSIS_DIR } from '@/lib/server/analysis';

/**
 * 解析で作った画像（写真・土地被覆の重ね絵）を返す。名前は決まったものだけ受け付ける。
 * 重ね絵は判定の方式ごとに名前が違う（作り直したときに URL が変わり、古い絵がブラウザに残らない）
 */
const FILES: Record<string, string> = {
  'photo.jpg': 'image/jpeg',
  'overlay-segmentation.png': 'image/png',
  'overlay-color-index.png': 'image/png',
};

export async function GET(_req: Request, ctx: RouteContext<'/api/analyses/[id]/[file]'>) {
  const { id, file } = await ctx.params;
  if (!/^[0-9a-f]{20}$/.test(id) || !Object.hasOwn(FILES, file)) return new Response('Not found', { status: 404 });
  try {
    const buf = await fs.readFile(path.join(ANALYSIS_DIR, id, file));
    return new Response(new Uint8Array(buf), {
      headers: { 'Content-Type': FILES[file], 'Cache-Control': 'private, max-age=86400, immutable' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
