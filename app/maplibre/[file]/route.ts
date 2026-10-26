import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * MapLibre GL JS の Web Worker を配信する。
 *
 * v6 は ESM 専用になり、worker の場所を「本体のファイルの隣」（import.meta.url 基準）で探す。
 * バンドルすると本体の場所が変わって worker が見つからなくなる（"Worker failed to load"）ので、
 * node_modules にある worker をここから返し、画面側は setWorkerUrl でここを指す。
 * コピーを置かずに直接返すので、MapLibre を更新しても版がずれない。
 */
const FILES = new Set(['maplibre-gl-worker.mjs']);
const DIST = path.join(process.cwd(), 'node_modules', 'maplibre-gl', 'dist');

export async function GET(_req: Request, ctx: RouteContext<'/maplibre/[file]'>) {
  const { file } = await ctx.params;
  if (!FILES.has(file)) return new Response('Not found', { status: 404 });
  const body = await fs.readFile(path.join(DIST, file));
  return new Response(new Uint8Array(body), {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' },
  });
}
