/**
 * 船・車の検出モデルを学習するための注釈データ（開発用の注釈ページと、そのサーバー側で共有する）。
 *
 * 1 枚の「チップ」は、国土地理院の写真の z18 タイル 2×2（512 px 四方、約 250 m）。
 * 画像はリポジトリに入れず、タイル座標から取り直す。注釈の座標はチップ内の画素（z18 基準）で持つ。
 *
 * - 車は点（中心）で付ける。0.5 m/px では 1 台が 9×4 px ほどで、枠を描くより速く、学習もヒートマップで足りる。
 * - 船は回転した矩形で付ける。大きさと向きが船ごとに大きく違うため。
 *
 * 画面とサーバーの両方から使うので、Node や DOM に依存しない純粋な関数だけを置く。
 */
import { type BBox, TILE_SIZE, metersPerPixel, pxToLat, pxToLon } from '@/lib/geo';

export const CHIP_ZOOM = 18;
/** チップは z18 タイルの 2×2 */
export const CHIP_TILES = 2;
export const CHIP_PX = TILE_SIZE * CHIP_TILES;

export type ObjectKind = 'ship' | 'car';
export const OBJECT_KINDS: readonly ObjectKind[] = ['ship', 'car'];
export const OBJECT_LABEL: Record<ObjectKind, string> = { ship: '船', car: '車' };

/**
 * proposed … 自動の候補や Claude の下付け。人がまだ確かめていない
 * accepted … 人が確かめたもの（チップを「確認済み」にすると、残っている候補もこれになる）
 */
export type AnnotationStatus = 'proposed' | 'accepted';
/** 誰が付けたか（auto … 土地被覆と明るさからの自動の候補） */
export type AnnotationSource = 'auto' | 'claude' | 'human';

type Common = {
  id: string;
  status: AnnotationStatus;
  source: AnnotationSource;
  /** 隠れている・判別しにくいもの。学習では正解にも誤りにも数えない */
  difficult?: boolean;
};
export type CarPoint = Common & { kind: 'car'; x: number; y: number };
/** 回転した矩形。angle は長辺の向き（ラジアン、画像の右向きから時計回り、-π/2〜π/2） */
export type ShipBox = Common & { kind: 'ship'; cx: number; cy: number; length: number; width: number; angle: number };
export type Annotation = CarPoint | ShipBox;

export type Chip = {
  /** `18-<x>-<y>`（x, y は左上のタイル） */
  id: string;
  z: number;
  x: number;
  y: number;
  /** 地点（data/annotations/sites.json の id） */
  site: string;
  /** 1 画素の地上距離（m）。チップの中央の緯度で出す */
  mpp: number;
  /** 種類ごとに、人が確かめ終えたか */
  reviewed: Record<ObjectKind, boolean>;
  objects: Annotation[];
  updatedAt: string;
};

/** 一覧に出す要約 */
export type ChipSummary = Pick<Chip, 'id' | 'site' | 'reviewed'> & {
  counts: Record<ObjectKind, { proposed: number; accepted: number }>;
};

export type Site = {
  id: string;
  name: string;
  /** 主に何の注釈を付けるための地点か */
  focus: ObjectKind;
  lon: number;
  lat: number;
  /** 中心のチップから何枚ぶん広げるか（1 なら 3×3） */
  radius: number;
};

export function chipId(x: number, y: number): string {
  return `${CHIP_ZOOM}-${x}-${y}`;
}

const CHIP_ID = /^18-(\d{1,6})-(\d{1,6})$/;
export function parseChipId(id: string): { x: number; y: number } | null {
  const m = CHIP_ID.exec(id);
  if (!m) return null;
  const x = Number(m[1]), y = Number(m[2]);
  const max = 2 ** CHIP_ZOOM;
  // 左上のタイルは 2 の倍数にそろえる（隣のチップと重ねない）
  if (x % CHIP_TILES || y % CHIP_TILES || x >= max || y >= max) return null;
  return { x, y };
}

/** 経緯度の点を含むチップの左上タイル */
export function chipAt(lon: number, lat: number): { x: number; y: number } {
  const n = 2 ** CHIP_ZOOM;
  const tx = Math.floor(((lon + 180) / 360) * n);
  const r = (lat * Math.PI) / 180;
  const ty = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return { x: tx - (tx % CHIP_TILES), y: ty - (ty % CHIP_TILES) };
}

export function chipBBox(x: number, y: number): BBox {
  const px0 = x * TILE_SIZE, py0 = y * TILE_SIZE;
  return [
    pxToLon(px0, CHIP_ZOOM),
    pxToLat(py0 + CHIP_PX, CHIP_ZOOM),
    pxToLon(px0 + CHIP_PX, CHIP_ZOOM),
    pxToLat(py0, CHIP_ZOOM),
  ];
}

export function chipMpp(y: number): number {
  return metersPerPixel(pxToLat(y * TILE_SIZE + CHIP_PX / 2, CHIP_ZOOM), CHIP_ZOOM);
}

/** 地点のまわりのチップ（中心から radius 枚ぶん）を、左上から順に並べる */
export function siteChips(site: Site): { x: number; y: number }[] {
  const c = chipAt(site.lon, site.lat);
  const out: { x: number; y: number }[] = [];
  for (let dy = -site.radius; dy <= site.radius; dy++) {
    for (let dx = -site.radius; dx <= site.radius; dx++) {
      out.push({ x: c.x + dx * CHIP_TILES, y: c.y + dy * CHIP_TILES });
    }
  }
  return out;
}

/**
 * 船の枠として受け付ける範囲（チップの画素）。中心はチップの外でもよい（チップの境で切れた船）。
 * 大きさは 1 px〜チップの 1.5 倍。画面の操作もこの範囲に収め、サーバーでも同じ範囲で検める
 */
export const SHIP_LIMITS = { minCenter: -CHIP_PX, maxCenter: 2 * CHIP_PX, minSize: 1, maxSize: CHIP_PX * 1.5 } as const;

type ShipShape = Pick<ShipBox, 'cx' | 'cy' | 'length' | 'width' | 'angle'>;

/** 船の枠を受け付ける範囲に収める（長さは幅より短くしない） */
export function clampShip<T extends ShipShape>(b: T): T {
  const c = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const length = c(b.length, SHIP_LIMITS.minSize, SHIP_LIMITS.maxSize);
  return {
    ...b,
    cx: c(b.cx, SHIP_LIMITS.minCenter, SHIP_LIMITS.maxCenter),
    cy: c(b.cy, SHIP_LIMITS.minCenter, SHIP_LIMITS.maxCenter),
    length,
    width: c(b.width, SHIP_LIMITS.minSize, length),
  };
}

/** 回転した矩形の 4 隅（船首側の右 → 船首側の左 → 船尾側の左 → 船尾側の右） */
export function shipCorners(b: Pick<ShipBox, 'cx' | 'cy' | 'length' | 'width' | 'angle'>): [number, number][] {
  const ux = Math.cos(b.angle), uy = Math.sin(b.angle);   // 長辺の向き
  const vx = -uy, vy = ux;                                 // 短辺の向き
  const hl = b.length / 2, hw = b.width / 2;
  return [
    [b.cx + ux * hl + vx * hw, b.cy + uy * hl + vy * hw],
    [b.cx + ux * hl - vx * hw, b.cy + uy * hl - vy * hw],
    [b.cx - ux * hl - vx * hw, b.cy - uy * hl - vy * hw],
    [b.cx - ux * hl + vx * hw, b.cy - uy * hl + vy * hw],
  ];
}

/** 長辺の両端（ドラッグで長さと向きを変える取っ手） */
export function shipEnds(b: Pick<ShipBox, 'cx' | 'cy' | 'length' | 'angle'>): [[number, number], [number, number]] {
  const dx = (Math.cos(b.angle) * b.length) / 2, dy = (Math.sin(b.angle) * b.length) / 2;
  return [[b.cx + dx, b.cy + dy], [b.cx - dx, b.cy - dy]];
}

/** 向きは前後を区別しないので、-π/2〜π/2 にまとめる */
export function normalizeAngle(a: number): number {
  let t = a % Math.PI;
  if (t >= Math.PI / 2) t -= Math.PI;
  if (t < -Math.PI / 2) t += Math.PI;
  return t;
}

/** 2 点（長辺の両端）から回転した矩形を作る */
export function shipFromEnds(a: [number, number], b: [number, number], width: number): Pick<ShipBox, 'cx' | 'cy' | 'length' | 'width' | 'angle'> {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return {
    cx: (a[0] + b[0]) / 2,
    cy: (a[1] + b[1]) / 2,
    length: Math.hypot(dx, dy),
    width,
    angle: normalizeAngle(Math.atan2(dy, dx)),
  };
}

/** 点が回転した矩形の中にあるか */
export function insideShip(b: Pick<ShipBox, 'cx' | 'cy' | 'length' | 'width' | 'angle'>, x: number, y: number): boolean {
  const dx = x - b.cx, dy = y - b.cy;
  const u = dx * Math.cos(b.angle) + dy * Math.sin(b.angle);
  const v = -dx * Math.sin(b.angle) + dy * Math.cos(b.angle);
  return Math.abs(u) <= b.length / 2 && Math.abs(v) <= b.width / 2;
}

export function summarize(chip: Chip): ChipSummary {
  const counts = { ship: { proposed: 0, accepted: 0 }, car: { proposed: 0, accepted: 0 } };
  for (const o of chip.objects) counts[o.kind][o.status]++;
  return { id: chip.id, site: chip.site, reviewed: chip.reviewed, counts };
}

/** 外から受け取った注釈を検める（壊れた値をファイルに書かないため）。正しくなければ null */
export function sanitizeAnnotation(v: unknown): Annotation | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== 'object') return null;
  if (typeof o.id !== 'string' || !/^[\w-]{1,40}$/.test(o.id)) return null;
  if (o.status !== 'proposed' && o.status !== 'accepted') return null;
  if (o.source !== 'auto' && o.source !== 'claude' && o.source !== 'human') return null;
  const num = (k: string, min: number, max: number) => {
    const n = o[k];
    return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max ? Math.round(n * 100) / 100 : null;
  };
  const base = { id: o.id, status: o.status, source: o.source, ...(o.difficult === true ? { difficult: true } : {}) } as const;
  if (o.kind === 'car') {
    const x = num('x', 0, CHIP_PX), y = num('y', 0, CHIP_PX);
    return x === null || y === null ? null : { ...base, kind: 'car', x, y };
  }
  if (o.kind === 'ship') {
    const L = SHIP_LIMITS;
    const cx = num('cx', L.minCenter, L.maxCenter), cy = num('cy', L.minCenter, L.maxCenter);
    const length = num('length', L.minSize, L.maxSize), width = num('width', L.minSize, L.maxSize);
    const angle = num('angle', -Math.PI, Math.PI);
    if (cx === null || cy === null || length === null || width === null || angle === null) return null;
    // 長辺を length に保つ（幅の方が長くなったら 90° 回す）
    return length >= width
      ? { ...base, kind: 'ship', cx, cy, length, width, angle: normalizeAngle(angle) }
      : { ...base, kind: 'ship', cx, cy, length: width, width: length, angle: normalizeAngle(angle + Math.PI / 2) };
  }
  return null;
}
