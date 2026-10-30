/**
 * 解析した写真を 3×3 に分けた区画。追加の質問で「どこに」を答えるときの単位にする。
 * 画面とサーバーの両方から使うので、Node や DOM に依存しない純粋な関数だけを置く。
 */
import type { BBox } from '@/lib/geo';

export const REGION_KEYS = ['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'] as const;
export type RegionKey = (typeof REGION_KEYS)[number];

/** 写真は北が上なので、上下左右と方角を併記する */
export const REGION_LABEL: Record<RegionKey, string> = {
  nw: '左上（北西）',
  n: '上（北）',
  ne: '右上（北東）',
  w: '左（西）',
  c: '中央',
  e: '右（東）',
  sw: '左下（南西）',
  s: '下（南）',
  se: '右下（南東）',
};

export function isRegionKey(v: unknown): v is RegionKey {
  return typeof v === 'string' && (REGION_KEYS as readonly string[]).includes(v);
}

/** 区画の列・行（0〜2）。左上が 0, 0 */
export function regionCell(key: RegionKey): { col: number; row: number } {
  const i = REGION_KEYS.indexOf(key);
  return { col: i % 3, row: Math.floor(i / 3) };
}

/** 区画の経緯度の矩形。数 km までの範囲なので、緯度も線形に割る */
export function regionBBox(bbox: BBox, key: RegionKey): BBox {
  const [w, s, e, n] = bbox;
  const { col, row } = regionCell(key);
  const dx = (e - w) / 3, dy = (n - s) / 3;
  return [w + dx * col, n - dy * (row + 1), w + dx * (col + 1), n - dy * row];
}

/** 経緯度の点が入る区画（regionBBox と同じく、緯度も線形に割る）。範囲の外なら端の区画にまとめる */
export function regionAt(bbox: BBox, lon: number, lat: number): RegionKey {
  const [w, s, e, n] = bbox;
  const col = Math.min(2, Math.max(0, Math.floor(((lon - w) / (e - w)) * 3)));
  const row = Math.min(2, Math.max(0, Math.floor(((n - lat) / (n - s)) * 3)));
  return REGION_KEYS[row * 3 + col];
}

/**
 * 質問文から、写真の中の位置を指す語を拾う。2 文字の組（左上・北東など）を先に見る。
 * 「以上」「上空」などを拾わないよう、1 文字の向きは「側・部・端・の方・寄り」などが続くときだけにする。
 * 「中央線」「中央分離帯」「中心市街地」のような、位置ではない言葉も拾わない
 */
const SIDE = '(?:側|部|端|の方|のほう|寄り|半分|あたり|辺り)';
const PATTERNS: [RegionKey, RegExp][] = [
  ['nw', /左上|北西/g],
  ['ne', /右上|北東/g],
  ['sw', /左下|南西/g],
  ['se', /右下|南東/g],
  ['c', /(?:中央|中心)(?![線分区通道口駅市街病公卸])|真ん中/g],
  ['n', new RegExp(`(?:上|北)${SIDE}`, 'g')],
  ['s', new RegExp(`(?:下|南)${SIDE}`, 'g')],
  ['w', new RegExp(`(?:左|西)${SIDE}`, 'g')],
  ['e', new RegExp(`(?:右|東)${SIDE}`, 'g')],
];

/** 文に出てくる順に、区画を重ならないように返す（「左上と右下を比べて」なら nw, se） */
export function regionsInText(text: string, max = 2): RegionKey[] {
  const hits: { key: RegionKey; at: number }[] = [];
  let rest = text;
  for (const [key, re] of PATTERNS) {
    for (const m of rest.matchAll(re)) hits.push({ key, at: m.index });
    // 「左上」を拾った後で「上の方」などに二重に当たらないよう、拾った語は伏せる
    rest = rest.replace(re, (w) => '　'.repeat(w.length));
  }
  const keys = [...new Set(hits.sort((a, b) => a.at - b.at).map((h) => h.key))];
  return keys.slice(0, max);
}
