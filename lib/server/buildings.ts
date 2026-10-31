/**
 * 範囲の中の建物を、国土地理院の地図データ（最適化ベクトルタイル）から取り出す（サーバー専用）。
 *
 * 写真から建物を 1 棟ずつ数えるのは難しい（FLAIR の建物マスクは隣どうしの住宅が 1 つにつながる）。
 * 地図データの建物の外周線なら、棟数・種別・形がそのまま使える。ただし地図データの時点と写真の撮影時期は
 * 違うので、新築・解体は合わないことがある（画面と AI にも時点を伝える）。
 *
 * - PMTiles 版を使う。ファイルごとのタイル（{z}/{x}/{y}.pbf）は 2023-10 時点で更新が止まっている
 *   （https://github.com/gsi-cyberjapan/optimal_bvmap の README、2026-10 に確認）
 * - z16（地理院タイルの z17 相当）の BldA レイヤ。タイルには周りの余白の分まで入っているので、タイルの枠で
 *   切りそろえてから、境目で切れた片（隣のタイルの片と境目の線を共有するもの）を 1 棟にまとめて数える
 * - 都心では 1 回に数万棟になるので、数は全部を数え、画面に返す形は面積の大きい順に上限までにする
 * - 国土地理院コンテンツ利用規約（PDL1.0）に従い、出典と加工したことを書く
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { VectorTile, classifyRings } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { PMTiles } from 'pmtiles';
import polygonClipping, { type Polygon } from 'polygon-clipping';
import { type BBox, latToPx, lonToPx, pxToLat, pxToLon, TILE_SIZE } from '@/lib/geo';
import type { MapObjects } from '@/lib/types';
import { writeAtomic } from '@/lib/server/tiles';

const PMTILES_URL = 'https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles';
const Z = 16;
const CACHE_DIR = path.join(process.cwd(), '.cache', 'bvmap');
const FETCH_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
/** 画面に返す形の上限。これを超える分は数にだけ入れる（数万棟の形は重く、写真の上では見分けもつかない） */
const MAX_SHAPES = 3000;

/** 地物種別コード（optbv_featurecodes.xlsx の BldA） */
const BUILDING_TYPES: Record<number, string> = {
  3101: '普通建物',
  3102: '堅ろう建物',
  3103: '高層建物',
  3111: '普通無壁舎',
  3112: '堅ろう無壁舎',
};

/** 1 棟の建物。境目でつなげなかったときは、複数の多角形のまま 1 棟として持つ */
export type Building = { type: string; polygons: Polygon[]; center: [number, number]; areaM2: number };

// ---- 地図データの取得 -------------------------------------------------------------------

let archive: PMTiles | null = null;
const pmtiles = () => (archive ??= new PMTiles(PMTILES_URL));

/**
 * pmtiles はヘッダの取得に中止もタイムアウトも効かず、失敗した結果を覚えたままにする。
 * そこで待ち時間に上限を付け、失敗したら次の呼び出しで作り直す
 */
async function guarded<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const limit = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  try {
    return await new Promise<T>((resolve, reject) => {
      limit.throwIfAborted();
      const onAbort = () => reject(limit.reason);
      limit.addEventListener('abort', onAbort, { once: true });
      work().then(resolve, reject).finally(() => limit.removeEventListener('abort', onAbort));
    });
  } catch (e) {
    archive = null;
    throw e;
  }
}

/** データの時点（例「2026-07」）。ETag ごとに覚える（データが更新されたら読み直す） */
const dataMonths = new Map<string, Promise<string | null>>();
function dataTime(etag: string, signal: AbortSignal): Promise<string | null> {
  let p = dataMonths.get(etag);
  if (!p) {
    // メタデータの生成記録にある「26-07.mbtiles」から読む。読めなければ null
    p = guarded(() => pmtiles().getMetadata(), signal)
      .then((m) => {
        const hit = JSON.stringify(m).match(/\b(\d\d)-(\d\d)\.mbtiles/);
        return hit ? `20${hit[1]}-${hit[2]}` : null;
      })
      .catch(() => {
        dataMonths.delete(etag);
        return null;
      });
    dataMonths.set(etag, p);
  }
  return p;
}

const tagOf = (etag: string | undefined) => (etag ?? 'none').replace(/[^0-9a-z]/gi, '').slice(0, 16) || 'none';

/** 1 枚のタイル（展開済みの pbf）。データが更新されたら取り直すよう、ETag ごとに置き場所を分ける */
async function tile(x: number, y: number, signal: AbortSignal): Promise<Uint8Array | null> {
  const before = await guarded(() => pmtiles().getHeader(), signal);
  const cached = path.join(CACHE_DIR, tagOf(before.etag), String(Z), String(x), `${y}.pbf`);
  try {
    const buf = await fs.readFile(cached);
    return buf.length ? new Uint8Array(buf) : null;
  } catch {
    // キャッシュに無ければ取りに行く
  }
  const res = await guarded(() => pmtiles().getZxy(Z, x, y, signal), signal);
  // 取得の途中でデータが更新されると、pmtiles はヘッダを読み直す。置き場所は取得した後のヘッダで決める
  const after = await guarded(() => pmtiles().getHeader(), signal);
  const file = path.join(CACHE_DIR, tagOf(after.etag), String(Z), String(x), `${y}.pbf`);
  // 海の上などはタイルが無い。空のファイルを置いて、次からは取りに行かない
  const data = res ? new Uint8Array(res.data) : new Uint8Array();
  await writeAtomic(file, Buffer.from(data));
  return data.length ? data : null;
}

// ---- 形の計算 ---------------------------------------------------------------------------

type Pt = [number, number];

/**
 * 多角形の環をタイルの枠（0〜extent の正方形）で切る（Sutherland–Hodgman）。
 * 枠は凸なので、建物がへこんだ形でも切れる。枠の上の点は座標がちょうど 0 か extent になる
 */
function clipRing(ring: Pt[], ext: number): Pt[] {
  const edges: [(p: Pt) => boolean, (a: Pt, b: Pt) => Pt][] = [
    [(p) => p[0] >= 0, (a, b) => [0, a[1] + ((b[1] - a[1]) * (0 - a[0])) / (b[0] - a[0])]],
    [(p) => p[0] <= ext, (a, b) => [ext, a[1] + ((b[1] - a[1]) * (ext - a[0])) / (b[0] - a[0])]],
    [(p) => p[1] >= 0, (a, b) => [a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1]), 0]],
    [(p) => p[1] <= ext, (a, b) => [a[0] + ((b[0] - a[0]) * (ext - a[1])) / (b[1] - a[1]), ext]],
  ];
  let out = ring;
  for (const [inside, cross] of edges) {
    if (!out.length) break;
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const cur = input[i], prev = input[(i + input.length - 1) % input.length];
      if (inside(cur)) {
        if (!inside(prev)) out.push(cross(prev, cur));
        out.push(cur);
      } else if (inside(prev)) {
        out.push(cross(prev, cur));
      }
    }
  }
  return out;
}

/**
 * 経緯度の環の面積（m²）と重心。数 km の範囲なので中心の緯度で平面とみなす。
 * 経緯度のまま掛け算すると桁が落ちる（130 × 33 に対して建物は 1e-9 度²）ので、最初の点からの差で計算する
 */
function ringStats(ring: Pt[], lat0: number): { area: number; cx: number; cy: number } {
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 111_320;
  const [ox, oy] = ring[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xj = (ring[j][0] - ox) * kx, yj = (ring[j][1] - oy) * ky;
    const xi = (ring[i][0] - ox) * kx, yi = (ring[i][1] - oy) * ky;
    const f = xj * yi - xi * yj;
    a += f;
    cx += (xj + xi) * f;
    cy += (yj + yi) * f;
  }
  if (Math.abs(a) < 1e-9) return { area: 0, cx: ox, cy: oy };
  return { area: Math.abs(a) / 2, cx: ox + cx / (3 * a) / kx, cy: oy + cy / (3 * a) / ky };
}

/** 建物 1 棟の面積と重心（多角形が複数でも、面積で重み付けした 1 点にする） */
function measure(polygons: Polygon[], lat0: number): { areaM2: number; center: Pt } {
  let area = 0, sx = 0, sy = 0;
  for (const p of polygons) {
    const outer = ringStats(p[0] as Pt[], lat0);
    const holes = p.slice(1).reduce((t, r) => t + ringStats(r as Pt[], lat0).area, 0);
    area += outer.area - holes;
    sx += outer.cx * outer.area;
    sy += outer.cy * outer.area;
  }
  const total = polygons.reduce((t, p) => t + ringStats(p[0] as Pt[], lat0).area, 0);
  const first = polygons[0][0][0] as Pt;
  return { areaM2: Math.max(0, area), center: total > 0 ? [sx / total, sy / total] : first };
}

/** 片として残す最小の面積（タイル座標の単位²。z16 では 1 単位が約 15 cm なので、4 は約 0.1 m²） */
const MIN_PIECE_AREA = 4;

function tileArea(ring: Pt[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

/** タイルの境目の上にある辺。line は境目の線（タイル番号で表す）、a〜b はその線の上の区間 */
type Seg = { line: string; a: number; b: number };
type Piece = { key: string; tile: string; code: number; polygon: Polygon; segs: Seg[] };

/** タイルの建物を、タイルの枠でちょうど切った経緯度の多角形にする（タイルには周りの余白の分まで入っている） */
function decode(data: Uint8Array, x: number, y: number): Piece[] {
  const layer = new VectorTile(new PbfReader(data)).layers.BldA;
  if (!layer) return [];
  const ext = layer.extent;
  const toLonLat = ([px, py]: Pt): Pt => [pxToLon((x + px / ext) * TILE_SIZE, Z), pxToLat((y + py / ext) * TILE_SIZE, Z)];
  const tileKey = `${x}/${y}`;
  const out: Piece[] = [];
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const code = Number(f.properties.vt_code);
    if (!BUILDING_TYPES[code] || f.type !== 3) continue;
    for (const rings of classifyRings(f.loadGeometry())) {
      // 外周が枠の外に出て消えたときは、その多角形ごと捨てる（穴だけ残さない）
      const outer = clipRing(rings[0].map((p) => [p.x, p.y] as Pt), ext);
      // 枠の上に線として残っただけの片（隣のタイルの余白に入っていた建物の縁）は捨てる。1 単位は約 15 cm
      if (outer.length < 3 || tileArea(outer) < MIN_PIECE_AREA) continue;
      const segs: Seg[] = [];
      for (let k = 0; k < outer.length; k++) {
        const [ax, ay] = outer[k], [bx, by] = outer[(k + 1) % outer.length];
        const along = (u: number, v: number, base: number) => {
          const lo = base + Math.min(u, v) / ext, hi = base + Math.max(u, v) / ext;
          return { a: lo, b: hi };
        };
        if (ax === 0 && bx === 0) segs.push({ line: `v:${x}`, ...along(ay, by, y) });
        else if (ax === ext && bx === ext) segs.push({ line: `v:${x + 1}`, ...along(ay, by, y) });
        else if (ay === 0 && by === 0) segs.push({ line: `h:${y}`, ...along(ax, bx, x) });
        else if (ay === ext && by === ext) segs.push({ line: `h:${y + 1}`, ...along(ax, bx, x) });
      }
      const holes = rings.slice(1).map((r) => clipRing(r.map((p) => [p.x, p.y] as Pt), ext)).filter((r) => r.length >= 3);
      const close = (r: Pt[]) => [...r.map(toLonLat), toLonLat(r[0])];
      out.push({ key: `${tileKey}#${i}`, tile: tileKey, code, polygon: [close(outer), ...holes.map(close)], segs });
    }
  }
  return out;
}

/**
 * 境目で切れた片をまとめて 1 棟にする。まとめるのは、同じ地物から出た片と、
 * 違うタイルの片のうち同じ種別で境目の線の区間が重なるものだけ（壁を共有する別の建物はまとめない）
 */
function joinPieces(pieces: Piece[], lat0: number): Building[] {
  const parent = pieces.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const unite = (i: number, j: number) => { parent[find(i)] = find(j); };
  const byKey = new Map<string, number>();
  const onLine = new Map<string, { i: number; a: number; b: number }[]>();
  pieces.forEach((p, i) => {
    const same = byKey.get(p.key);
    if (same !== undefined) unite(i, same);
    else byKey.set(p.key, i);
    for (const s of p.segs) onLine.set(s.line, [...(onLine.get(s.line) ?? []), { i, a: s.a, b: s.b }]);
  });
  const eps = 1e-6;
  for (const segs of onLine.values()) {
    for (let m = 0; m < segs.length; m++) {
      for (let n = m + 1; n < segs.length; n++) {
        const s = segs[m], t = segs[n];
        const P = pieces[s.i], Q = pieces[t.i];
        if (P.tile === Q.tile || P.code !== Q.code) continue;
        if (Math.min(s.b, t.b) - Math.max(s.a, t.a) > eps) unite(s.i, t.i);
      }
    }
  }
  const groups = new Map<number, Piece[]>();
  pieces.forEach((p, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), p]));
  return [...groups.values()].map((g) => {
    let polygons: Polygon[] = g.map((p) => p.polygon);
    if (g.length > 1) {
      // つなぎ目を消して 1 つの形にする。計算に失敗する形もあるので、そのときは片のまま 1 棟とする
      try {
        polygons = polygonClipping.union(polygons[0], ...polygons.slice(1));
      } catch {
        // 片のまま
      }
    }
    return { type: BUILDING_TYPES[g[0].code], polygons, ...measure(polygons, lat0) };
  });
}

/** fn を同時に limit 本まで動かす。1 つが失敗したら、残りは取りに行かずに止める */
async function mapLimit<T, R>(items: T[], limit: number, signal: AbortSignal, fn: (t: T, signal: AbortSignal) => Promise<R>): Promise<R[]> {
  const ac = new AbortController();
  const inner = AbortSignal.any([signal, ac.signal]);
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !inner.aborted) {
      const i = next++;
      try {
        out[i] = await fn(items[i], inner);
      } catch (e) {
        ac.abort(e);
        throw e;
      }
    }
  }));
  inner.throwIfAborted();
  return out;
}

/** 範囲の中の建物（重心が範囲に入るもの）。範囲からはみ出す部分も、形はそのまま返す */
export async function buildingsIn(bbox: BBox, signal: AbortSignal): Promise<{ buildings: Building[]; dataTime: string | null }> {
  const [w, s, e, n] = bbox;
  const x0 = Math.floor(lonToPx(w, Z) / TILE_SIZE), x1 = Math.floor(lonToPx(e, Z) / TILE_SIZE);
  const y0 = Math.floor(latToPx(n, Z) / TILE_SIZE), y1 = Math.floor(latToPx(s, Z) / TILE_SIZE);
  const coords: [number, number][] = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) coords.push([x, y]);
  const decoded = await mapLimit(coords, CONCURRENCY, signal, async ([x, y], sig) => {
    const data = await tile(x, y, sig);
    return data ? decode(data, x, y) : [];
  });
  const buildings = joinPieces(decoded.flat(), (s + n) / 2)
    .filter((b) => b.center[0] >= w && b.center[0] <= e && b.center[1] >= s && b.center[1] <= n);
  const header = await guarded(() => pmtiles().getHeader(), signal);
  return { buildings, dataTime: await dataTime(header.etag ?? 'none', signal) };
}

/** 画面と AI に渡す形にする。scope は数えた範囲（「範囲全体」「右下（南東）の区画」など） */
export function buildingObjects(buildings: Building[], dataTime: string | null, scope: string): MapObjects {
  const counts = new Map<string, number>();
  for (const b of buildings) counts.set(b.type, (counts.get(b.type) ?? 0) + 1);
  const shapes = buildings.length > MAX_SHAPES ? [...buildings].sort((a, b) => b.areaM2 - a.areaM2).slice(0, MAX_SHAPES) : buildings;
  return {
    kind: 'building',
    label: '建物',
    unit: '棟',
    count: buildings.length,
    basis: '地図データ',
    summary: '',
    scope,
    breakdown: [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    source: `国土地理院最適化ベクトルタイル${dataTime ? `（${dataTime} 時点）` : ''}を加工して作成`,
    note: '地図データの時点と写真の撮影時期は違うため、新築・解体は合わないことがあります。'
      + (shapes.length < buildings.length ? `形は大きい順に ${MAX_SHAPES.toLocaleString('ja-JP')} 棟まで描いています。` : ''),
    geojson: {
      type: 'FeatureCollection',
      features: shapes.map((b) => ({
        type: 'Feature',
        properties: { type: b.type, areaM2: Math.round(b.areaM2) },
        geometry: b.polygons.length === 1
          ? { type: 'Polygon', coordinates: b.polygons[0] }
          : { type: 'MultiPolygon', coordinates: b.polygons },
      })),
    },
  };
}
