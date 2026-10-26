/**
 * 経緯度とタイル座標（Web メルカトル）の計算。
 * 画面・サーバーの両方から使うので、Node や DOM に依存しない純粋な関数だけを置く。
 */

/** 経緯度の矩形。[西, 南, 東, 北]（度） */
export type BBox = [west: number, south: number, east: number, north: number];

export const TILE_SIZE = 256;

/** 経度 → ズーム z でのワールドピクセル X */
export function lonToPx(lon: number, z: number): number {
  return ((lon + 180) / 360) * TILE_SIZE * 2 ** z;
}

/** 緯度 → ズーム z でのワールドピクセル Y */
export function latToPx(lat: number, z: number): number {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * TILE_SIZE * 2 ** z;
}

export function pxToLon(x: number, z: number): number {
  return (x / (TILE_SIZE * 2 ** z)) * 360 - 180;
}

export function pxToLat(y: number, z: number): number {
  const n = Math.PI - (2 * Math.PI * y) / (TILE_SIZE * 2 ** z);
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
}

/** ズーム z・緯度 lat での 1 ピクセルあたりの地上距離（m） */
export function metersPerPixel(lat: number, z: number): number {
  return (156543.03392804097 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;
}

/** 矩形をズーム z で画像にしたときの大きさ（px） */
export function bboxPixelSize(bbox: BBox, z: number): { width: number; height: number } {
  const [w, s, e, n] = bbox;
  return {
    width: Math.round(lonToPx(e, z) - lonToPx(w, z)),
    height: Math.round(latToPx(s, z) - latToPx(n, z)),
  };
}

/** 矩形の東西・南北の長さ（m）。中央の緯度で近似する */
export function bboxSizeMeters(bbox: BBox): { width: number; height: number } {
  const [w, s, e, n] = bbox;
  const lat = (s + n) / 2;
  const mPerDegLat = 111_320;
  return {
    width: (e - w) * mPerDegLat * Math.cos((lat * Math.PI) / 180),
    height: (n - s) * mPerDegLat,
  };
}

export function bboxCenter(bbox: BBox): [lon: number, lat: number] {
  return [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2];
}

/** 2 点から、軸に沿った矩形を作る（ドラッグの向きを問わない） */
export function bboxFromPoints(a: [number, number], b: [number, number]): BBox {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

export function bboxToPolygon(bbox: BBox): GeoJSON.Feature<GeoJSON.Polygon> {
  const [w, s, e, n] = bbox;
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
  };
}

export function isValidBBox(v: unknown): v is BBox {
  return (
    Array.isArray(v) &&
    v.length === 4 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n)) &&
    v[0] >= -180 && v[2] <= 180 && v[1] >= -85 && v[3] <= 85 &&
    v[0] < v[2] && v[1] < v[3]
  );
}

/** 度を「35°40′52″N」の形にする */
export function formatDms(value: number, axis: 'lat' | 'lon'): string {
  const hemi = axis === 'lat' ? (value >= 0 ? 'N' : 'S') : value >= 0 ? 'E' : 'W';
  let v = Math.abs(value);
  let d = Math.floor(v);
  v = (v - d) * 60;
  let m = Math.floor(v);
  let s = Math.round((v - m) * 60);
  if (s === 60) { s = 0; m += 1; }
  if (m === 60) { m = 0; d += 1; }
  return `${d}°${String(m).padStart(2, '0')}′${String(s).padStart(2, '0')}″${hemi}`;
}

/** 面積を読みやすい単位にする（1 ha 未満は m²、1 km² 以上は km²） */
export function formatArea(m2: number): string {
  if (m2 >= 1_000_000) return `${(m2 / 1_000_000).toFixed(2)} km²`;
  if (m2 >= 10_000) return `${(m2 / 10_000).toFixed(1)} ha`;
  return `${Math.round(m2).toLocaleString('ja-JP')} m²`;
}

export function formatLength(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
