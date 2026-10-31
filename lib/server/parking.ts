/**
 * 範囲の中の駐車場を、OpenStreetMap（amenity=parking）から取り出す（サーバー専用）。
 *
 * 写真（約 0.5 m/px）では車が 9×4 px ほどにしか写らず、人が見ても 1 台ずつ見分けられない。そこで車は
 * 「どこに駐車場があり、何台分あるか」を地図データで答える。いま停まっている台数ではない。
 *
 * - 台数は、収容台数（capacity）が書いてあればその値。平面の駐車場で書いていなければ、面積から
 *   1 台 25 m²（通路を含む）で割った目安。立体・地下は床の数が分からないので、面積からは出さない。
 * - Overpass API（公開のサーバー）の利用の目安（1 日 1 万件まで）を守るため、結果は 7 日間手元に残し、
 *   同時には 1 件ずつ問い合わせる。OSM のデータは ODbL なので、出典を必ず画面に出す。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BBox } from '@/lib/geo';
import type { MapObjects } from '@/lib/types';
import { writeAtomic } from '@/lib/server/tiles';

/**
 * 公開の Overpass サーバー。混み合うと 429・502・504 を返すので、順に試す。
 * 2026-10-31 の実測では、応答は mail.ru が 15〜18 秒（断るときは 2 秒）、ほかは約 30 秒だったので、mail.ru を先にする
 */
const OVERPASS_URLS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
/** すべて断られたときに、間を空けて試し直す回数と間隔（ms） */
const RETRY_WAIT_MS = [2000, 6000];
const CACHE_DIR = path.join(process.cwd(), '.cache', 'parking');
const CACHE_MS = 7 * 24 * 3600_000;
/** 1 回の問い合わせの待ち時間と、試し直しを含めた全体の上限（ms） */
const TIMEOUT_MS = 45_000;
const DEADLINE_MS = 90_000;
const USER_AGENT = 'sat_ai_vision/0.1 (local research app; https://github.com/habe1111/sat-ai-vision)';
/** 平面の駐車場の 1 台あたりの面積（m²）。区画（約 12.5 m²）に通路を足した目安 */
const M2_PER_CAR = 25;

export const PARKING_SOURCE = '© OpenStreetMap contributors（ODbL）';

export type ParkingLot = {
  /** 外周の輪（経緯度）。外周が複数ある駐車場（multipolygon の関係）は複数。穴は持たない */
  rings: [number, number][][];
  /** 重心（外周が複数あれば面積で重み付け） */
  center: [number, number];
  areaM2: number;
  /** surface（平面）・multi-storey（立体）・underground（地下）・rooftop（屋上）など。書いてなければ surface とみなす */
  layout: string;
  /** 書いてある収容台数（数でなければ null） */
  capacity: number | null;
};

type OsmElement = {
  type: 'way' | 'relation';
  id: number;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
  members?: { type: string; role: string; geometry?: { lat: number; lon: number }[] }[];
};

/** 小さな範囲なので、中央の緯度で平面に直して面積と重心を出す */
function measure(ring: [number, number][]): { areaM2: number; center: [number, number] } {
  const lat0 = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180), ky = 110_540;
  const [ox, oy] = ring[0];
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = (ring[i][0] - ox) * kx, y1 = (ring[i][1] - oy) * ky;
    const x2 = (ring[i + 1][0] - ox) * kx, y2 = (ring[i + 1][1] - oy) * ky;
    const c = x1 * y2 - x2 * y1;
    a += c; cx += (x1 + x2) * c; cy += (y1 + y2) * c;
  }
  if (Math.abs(a) < 1e-9) return { areaM2: 0, center: ring[0] };
  return { areaM2: Math.abs(a / 2), center: [ox + cx / (3 * a) / kx, oy + cy / (3 * a) / ky] };
}

function closed(g: { lat: number; lon: number }[] | undefined): [number, number][] | null {
  if (!g || g.length < 4) return null;
  const ring = g.map((p) => [p.lon, p.lat] as [number, number]);
  const [a, b] = [ring[0], ring[ring.length - 1]];
  return a[0] === b[0] && a[1] === b[1] ? ring : null;
}

/** 数の capacity だけを受け付ける（「約50」「100;20」などは読まない） */
function capacityOf(v: string | undefined): number | null {
  return v && /^\d{1,5}$/.test(v.trim()) ? Number(v.trim()) : null;
}

/** 形にできなかった駐車場（線をつなぎ合わせる必要のある関係など）。範囲で絞るため、節点の平均を代表点にする */
export type SkippedLot = { center: [number, number] };

function toLots(elements: OsmElement[]): { lots: ParkingLot[]; skipped: SkippedLot[] } {
  const lots: ParkingLot[] = [];
  const skipped: SkippedLot[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    // つながった 1 本の外周で書かれたものだけを形にする（線をつなぎ合わせる必要のある複雑な区画は数えない）
    const rings = el.type === 'way'
      ? [closed(el.geometry)]
      : (el.members ?? []).filter((m) => m.type === 'way' && m.role === 'outer').map((m) => closed(m.geometry));
    const ok = rings.filter((r): r is [number, number][] => r !== null);
    if (!ok.length || ok.length !== rings.length) {
      const pts = el.type === 'way' ? el.geometry ?? [] : (el.members ?? []).flatMap((m) => m.geometry ?? []);
      if (pts.length) {
        skipped.push({ center: [pts.reduce((a, p) => a + p.lon, 0) / pts.length, pts.reduce((a, p) => a + p.lat, 0) / pts.length] });
      }
      continue;
    }
    // 外周が複数あっても 1 か所の駐車場として数える（収容台数を重ねて数えない）
    const parts = ok.map(measure);
    const areaM2 = parts.reduce((a, m) => a + m.areaM2, 0);
    const center: [number, number] = areaM2 > 0
      ? [parts.reduce((a, m) => a + m.center[0] * m.areaM2, 0) / areaM2, parts.reduce((a, m) => a + m.center[1] * m.areaM2, 0) / areaM2]
      : parts[0].center;
    lots.push({ rings: ok, center, areaM2, layout: tags.parking ?? 'surface', capacity: capacityOf(tags.capacity) });
  }
  return { lots, skipped };
}

/** 問い合わせは 1 件ずつ（公開のサーバーに同時にいくつも送らない） */
let queue: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn);
  queue = run.catch(() => {});
  return run;
}

/** 公開の Overpass サーバーがどれも応えなかった（混み合っている・止まっている） */
export class OverpassBusyError extends Error {}

/** サーバーを順に試し、すべて断られたら間を空けて試し直す（retries 回まで） */
async function overpass(query: string, signal: AbortSignal, retries: number): Promise<OsmElement[]> {
  // 失敗の理由は、試したサーバーの分をすべて残す（最後の 1 件だけでは原因が分からない）
  const failures: string[] = [];
  const deadline = Date.now() + DEADLINE_MS;
  for (let round = 0; round <= retries && deadline - Date.now() >= 1000; round++) {
    if (round) await new Promise((r) => setTimeout(r, RETRY_WAIT_MS[Math.min(round, RETRY_WAIT_MS.length) - 1]));
    for (const url of OVERPASS_URLS) {
      signal.throwIfAborted();
      const left = deadline - Date.now();
      if (left < 1000) break;
      const host = new URL(url).host, t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'User-Agent': USER_AGENT, 'Content-Type': 'application/x-www-form-urlencoded' },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.any([signal, AbortSignal.timeout(Math.min(TIMEOUT_MS, left))]),
        });
        if (res.ok) {
          const body = (await res.json()) as { elements?: OsmElement[]; remark?: string };
          // 時間切れなどで途中までしか返らなかったときは remark が付く。欠けた結果は残さない
          if (body.remark && /error|timed out/i.test(body.remark)) { failures.push(`${host}：${body.remark}`); continue; }
          return body.elements ?? [];
        }
        failures.push(`${host} が ${res.status}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
      } catch (e) {
        if (signal.aborted) throw e;
        failures.push(`${host}：${e instanceof Error ? e.message : String(e)}（${Math.round((Date.now() - t0) / 1000)} 秒）`);
      }
    }
  }
  throw new OverpassBusyError(`OpenStreetMap のサーバーが混み合っていて、駐車場を取得できませんでした（${failures.join('、')}）`);
}

/** 古い結果を使ったあと、問い合わせを控える時間（ms）。混み合っているあいだ、毎回待たせないため */
const BACKOFF_MS = 3600_000;

/** 範囲の中の駐車場（重心が範囲に入るもの）と、形にできなかった区画（代表点が範囲に入るもの） */
export async function parkingIn(bbox: BBox, signal: AbortSignal): Promise<{ lots: ParkingLot[]; skipped: SkippedLot[] }> {
  const [w, s, e, n] = bbox;
  // キャッシュの鍵は、範囲の経緯度を 5 桁（約 1 m）で丸めたもの
  const key = createHash('sha256').update(bbox.map((v) => v.toFixed(5)).join(',')).digest('hex').slice(0, 20);
  const file = path.join(CACHE_DIR, `${key}.json`);
  let cached: OsmElement[] | null = null;
  let fresh = false;
  try {
    const st = await fs.stat(file);
    cached = JSON.parse(await fs.readFile(file, 'utf8')) as OsmElement[];
    fresh = Date.now() - st.mtimeMs < CACHE_MS;
  } catch {
    // 手元に無ければ問い合わせる
  }
  let elements = fresh ? cached : null;
  if (!elements) {
    const q = `[out:json][timeout:25];(way["amenity"="parking"](${s},${w},${n},${e});relation["amenity"="parking"](${s},${w},${n},${e}););out geom;`;
    try {
      // 古い結果があるときは、試し直さずにすぐ切り替える（混雑時に何分も待たせない）
      elements = await oneAtATime(() => overpass(q, signal, cached ? 0 : RETRY_WAIT_MS.length));
    } catch (err) {
      if (signal.aborted || !cached) throw err;
      console.warn('[parking] 取得できなかったので、手元の古い結果を使います', err);
      elements = cached;
      // しばらくは古い結果を新しいものとして扱い、問い合わせを控える
      const t = new Date(Date.now() - CACHE_MS + BACKOFF_MS);
      await fs.utimes(file, t, t).catch(() => {});
    }
    if (elements !== cached) {
      // 書き込めなくても、取れた結果は使う（次の質問で取り直すだけ）
      await writeAtomic(file, JSON.stringify(elements)).catch((e2) => console.warn('[parking] 結果を手元に残せませんでした', e2));
    }
  }
  const inside = (c: [number, number]) => c[0] >= w && c[0] <= e && c[1] >= s && c[1] <= n;
  const { lots, skipped } = toLots(elements);
  return { lots: lots.filter((l) => inside(l.center)), skipped: skipped.filter((k) => inside(k.center)) };
}

const LAYOUT_LABEL: Record<string, string> = {
  surface: '平面', 'multi-storey': '立体', underground: '地下', rooftop: '屋上',
  street_side: '路肩', lane: '路上', garage_boxes: '車庫', carports: 'カーポート',
};
const layoutLabel = (l: string) => LAYOUT_LABEL[l] ?? 'その他';

/** 収容台数の合計。書いてある値と、平面の駐車場を面積から推定した値を分けて数える */
export function parkingCapacity(lots: ParkingLot[]) {
  let known = 0, estimated = 0, knownLots = 0, estimatedLots = 0, unknownLots = 0;
  for (const l of lots) {
    if (l.capacity !== null) { known += l.capacity; knownLots++; }
    else if (l.layout === 'surface' || l.layout === 'rooftop') { estimated += Math.round(l.areaM2 / M2_PER_CAR); estimatedLots++; }
    else unknownLots++;
  }
  return { total: known + estimated, known, estimated, knownLots, estimatedLots, unknownLots };
}

/** 台数を出せない駐車場の区分（「立体 2・地下 1」など） */
function unknownKinds(lots: ParkingLot[]): string {
  const m = new Map<string, number>();
  for (const l of lots) {
    if (l.capacity === null && l.layout !== 'surface' && l.layout !== 'rooftop') m.set(layoutLabel(l.layout), (m.get(layoutLabel(l.layout)) ?? 0) + 1);
  }
  return [...m].map(([k, n]) => `${k} ${n}`).join('・');
}

/** 収容台数の一言。台数を出せないものがあればそのことも書く（AI が合計を全数と言い切らないため） */
export function capacityText(lots: ParkingLot[]): string {
  if (!lots.length) return '';
  const cap = parkingCapacity(lots);
  const parts = [
    cap.knownLots ? `記載のある ${cap.knownLots} か所で ${cap.known.toLocaleString('ja-JP')} 台` : '',
    cap.estimatedLots ? `平面 ${cap.estimatedLots} か所は面積から約 ${cap.estimated.toLocaleString('ja-JP')} 台` : '',
    cap.unknownLots ? `${unknownKinds(lots)} か所は台数の記載が無く不明` : '',
  ].filter(Boolean);
  if (!cap.knownLots && !cap.estimatedLots) return `収容台数は不明（${parts.join('、')}）`;
  return `収容 約 ${cap.total.toLocaleString('ja-JP')} 台分（${parts.join('、')}）`;
}

/** 画面と AI に渡す形にする。scope は数えた範囲 */
export function parkingObjects(lots: ParkingLot[], skipped: number, scope: string): MapObjects {
  const counts = new Map<string, number>();
  for (const l of lots) counts.set(layoutLabel(l.layout), (counts.get(layoutLabel(l.layout)) ?? 0) + 1);
  return {
    kind: 'parking',
    label: '駐車場',
    unit: 'か所',
    count: lots.length,
    basis: '地図データ',
    summary: capacityText(lots),
    scope,
    breakdown: [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
    source: PARKING_SOURCE,
    note: 'OpenStreetMap に登録された駐車場だけです。台数は収容できる台数の目安で、写真に写っている車の数ではありません。'
      + `面積からの推定は 1 台 ${M2_PER_CAR} m²（通路を含む）で割った値です。`
      + '立体・地下などで収容台数の記載が無いものは、台数に含めていません。'
      + (skipped ? `形を描けない駐車場が ${skipped} か所あり、か所数にも含めていません。` : ''),
    geojson: {
      type: 'FeatureCollection',
      features: lots.map((l) => ({
        type: 'Feature',
        properties: { layout: l.layout, capacity: l.capacity, areaM2: Math.round(l.areaM2) },
        geometry: l.rings.length === 1
          ? { type: 'Polygon', coordinates: [l.rings[0]] }
          : { type: 'MultiPolygon', coordinates: l.rings.map((r) => [r]) },
      })),
    },
  };
}
