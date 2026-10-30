/**
 * 選んだ範囲の空中写真を、タイルを取って 1 枚の画像にする（サーバー専用）。
 *
 * 地理院タイルに明示の回数制限は無いが、「正常な運用を妨げる程度の負荷」はアクセス遮断の
 * 対象になる（地理院地図利用規約）。そこで同時接続を絞り、取ったタイルは手元にキャッシュして
 * 同じ範囲を何度も取りに行かない。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { type BBox, TILE_SIZE, bboxPixelSize, latToPx, lonToPx, metersPerPixel } from '@/lib/geo';
import { tileUrl } from '@/lib/imagery';

const CACHE_DIR = path.join(process.cwd(), '.cache', 'tiles');
const CONCURRENCY = 6;
const USER_AGENT = 'sat_ai_vision/0.1 (local research app; https://github.com/habe1111/sat-ai-vision)';

export type Stitched = {
  image: Buffer;          // JPEG
  width: number;
  height: number;
  zoom: number;
  metersPerPixel: number;
  tiles: number;
  missingTiles: number;
};

/** 利用者の選び方に原因がある失敗（画面にそのまま出す） */
export class SelectionError extends Error {}

/** 1 回の取得の待ち時間の上限。地理院が応答しないとき、既定（300 秒）まで待たないため */
const FETCH_TIMEOUT_MS = 15_000;

/** 一時ファイルに書いてから置き換える。途中で止まっても、書きかけのタイルを読まないため */
export async function writeAtomic(file: string, data: Buffer | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function fetchTile(z: number, x: number, y: number, signal: AbortSignal): Promise<Buffer | null> {
  const file = path.join(CACHE_DIR, String(z), String(x), `${y}.jpg`);
  try {
    return await fs.readFile(file);
  } catch {
    // キャッシュに無ければ取りに行く
  }
  const missing = `${file}.404`;
  try {
    await fs.access(missing);
    return null;     // 以前 404 だったタイル（海上・提供範囲外）
  } catch {
    // 未確認
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try {
      const res = await fetch(tileUrl(z, x, y), {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]),
      });
      if (res.status === 404) {
        await writeAtomic(missing, '');
        return null;
      }
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        await writeAtomic(file, buf);
        return buf;
      }
    } catch (e) {
      // 画面側の中止はそのまま止める。通信の失敗（切断・DNS・時間切れ）は取り直す
      if (signal.aborted) throw e;
      console.warn(`[tiles] z${z}/${x}/${y} の取得に失敗しました（${attempt + 1} 回目）`, e);
    }
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
  throw new Error(`空中写真のタイルを取得できませんでした（z${z}/${x}/${y}）。時間をおいて再度お試しください。`);
}

/** 並列数を絞って順に処理する。中止されたら残りは取りに行かない */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        signal.throwIfAborted();
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/**
 * 範囲を覆うタイルを取り、範囲ぴったりに切り抜いた 1 枚の JPEG を返す。
 * onProgress は取得済みのタイル数を知らせる（画面の進み具合に使う）。
 * signal が中止されると、取得中のタイルを打ち切って AbortError を投げる。
 */
export async function stitchBBox(
  bbox: BBox,
  zoom: number,
  signal: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<Stitched> {
  const [w, s, e, n] = bbox;
  const left = lonToPx(w, zoom);
  const top = latToPx(n, zoom);
  const { width, height } = bboxPixelSize(bbox, zoom);
  const x0 = Math.floor(left / TILE_SIZE);
  const y0 = Math.floor(top / TILE_SIZE);
  const x1 = Math.floor((lonToPx(e, zoom) - 1e-9) / TILE_SIZE);
  const y1 = Math.floor((latToPx(s, zoom) - 1e-9) / TILE_SIZE);

  const coords: [number, number][] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) coords.push([x, y]);

  let done = 0;
  const bufs = await mapLimit(coords, CONCURRENCY, signal, async ([x, y]) => {
    const buf = await fetchTile(zoom, x, y, signal);
    onProgress?.(++done, coords.length);
    return buf;
  });

  const missingTiles = bufs.filter((b) => b === null).length;
  if (missingTiles === coords.length) {
    throw new SelectionError('この範囲には空中写真がありません。日本国内の陸地を選んでください。');
  }

  const cols = x1 - x0 + 1;
  const rows = y1 - y0 + 1;
  const mosaic = await sharp({
    create: { width: cols * TILE_SIZE, height: rows * TILE_SIZE, channels: 3, background: '#000000' },
  })
    .composite(
      coords.flatMap(([x, y], i) =>
        bufs[i] ? [{ input: bufs[i]!, left: (x - x0) * TILE_SIZE, top: (y - y0) * TILE_SIZE }] : [],
      ),
    )
    .png()
    .toBuffer();

  // タイルの継ぎ目ではなく、選んだ範囲どおりに切り抜く
  const offX = Math.round(left - x0 * TILE_SIZE);
  const offY = Math.round(top - y0 * TILE_SIZE);
  const outW = Math.max(1, Math.min(width, cols * TILE_SIZE - offX));
  const outH = Math.max(1, Math.min(height, rows * TILE_SIZE - offY));
  const image = await sharp(mosaic)
    .extract({ left: offX, top: offY, width: outW, height: outH })
    .jpeg({ quality: 90 })
    .toBuffer();

  return {
    image,
    width: outW,
    height: outH,
    zoom,
    metersPerPixel: metersPerPixel((s + n) / 2, zoom),
    tiles: coords.length,
    missingTiles,
  };
}
