/**
 * 地名・ランドマークの検索（OpenStreetMap の Nominatim）。サーバー専用。
 *
 * Nominatim の利用ポリシー（https://operations.osmfoundation.org/policies/nominatim/）に従う：
 * - 毎秒 1 件まで → 呼び出しを直列にして間隔を空ける
 * - アプリを識別できる User-Agent を付ける
 * - 結果はキャッシュする → 同じ語は 1 日使い回す
 * - 入力中の候補表示（オートコンプリート）は禁止 → 画面は確定（Enter）したときだけ呼ぶ
 *
 * 空中写真が日本国内だけなので、検索も日本に絞る（countrycodes=jp）。
 */
import type { Place } from '@/lib/types';

const ENDPOINT = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'sat_ai_vision/0.1 (local research app; https://github.com/habe1111/sat-ai-vision)';
const MIN_INTERVAL_MS = 1100;
const TTL_MS = 24 * 60 * 60 * 1000;

export const SEARCH_ATTRIBUTION = '検索：© OpenStreetMap contributors（Nominatim）';

const cache = new Map<string, { at: number; places: Place[] }>();
let queue: Promise<unknown> = Promise.resolve();
let lastCall = 0;

/** OSM の種類 → 画面に出す日本語。無いものは汎用の語にまとめる */
const KIND: Record<string, string> = {
  station: '駅', train_station: '駅', halt: '駅', subway_entrance: '駅出入口',
  castle: '城', ruins: '史跡', monument: '記念碑', memorial: '記念碑', archaeological_site: '遺跡',
  tower: 'タワー', bridge: '橋', dam: 'ダム', lighthouse: '灯台',
  place_of_worship: '寺社', shrine: '神社', temple: '寺院',
  park: '公園', garden: '庭園', nature_reserve: '自然保護区', stadium: '競技場', golf_course: 'ゴルフ場',
  university: '大学', school: '学校', college: '学校', hospital: '病院', townhall: '役所',
  museum: '博物館', zoo: '動物園', aquarium: '水族館', theme_park: 'テーマパーク', attraction: '観光地',
  aerodrome: '空港', airport: '空港', harbour: '港', port: '港',
  peak: '山', volcano: '火山', mountain_range: '山地', water: '水域', lake: '湖', river: '川', bay: '湾', island: '島', beach: '浜',
  city: '市', town: '町', village: '村', suburb: '地区', neighbourhood: '地区', quarter: '地区', hamlet: '集落',
  administrative: '行政区域', state: '都道府県', province: '都道府県',
  residential: '住宅地', industrial: '工業地', commercial: '商業地', retail: '商業施設', mall: '商業施設',
  farmland: '農地', forest: '森林', wood: '森林',
};

type NominatimItem = {
  place_id: number;
  osm_type: string;
  osm_id: number;
  lat: string;
  lon: string;
  name?: string;
  display_name: string;
  category?: string;
  type?: string;
  addresstype?: string;
  boundingbox?: [string, string, string, string];   // [南, 北, 西, 東]
};

function toPlace(item: NominatimItem): Place {
  const parts = item.display_name.split(',').map((p) => p.trim());
  const name = item.name || parts[0];
  // display_name は「名前, 番地, 区, 市, 県, 郵便番号, 日本」の順。名前と国・郵便番号を除いて
  // 大きい単位から並べ直すと、日本語として読める住所になる
  const address = parts
    .slice(1)
    .filter((p) => p !== '日本' && !/^\d{3}-?\d{4}$/.test(p))
    .reverse()
    .join(' ');
  const bb = item.boundingbox?.map(Number);
  return {
    id: `${item.osm_type}${item.osm_id}`,
    name,
    address,
    kind: KIND[item.type ?? ''] ?? KIND[item.addresstype ?? ''] ?? '場所',
    lon: Number(item.lon),
    lat: Number(item.lat),
    bbox: bb && bb.every(Number.isFinite) ? [bb[2], bb[0], bb[3], bb[1]] : null,
  };
}

export async function searchPlaces(query: string): Promise<Place[]> {
  const key = query.trim().normalize('NFKC');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.places;

  // 直列化して、前回の呼び出しから 1.1 秒以上空ける
  const run = queue.then(async () => {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCall = Date.now();
    const url = new URL(ENDPOINT);
    url.search = new URLSearchParams({
      q: key,
      format: 'jsonv2',
      'accept-language': 'ja',
      countrycodes: 'jp',
      limit: '10',
    }).toString();
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`検索サービスが応答しませんでした（HTTP ${res.status}）。少し待ってから再度お試しください。`);
    return ((await res.json()) as NominatimItem[]).map(toPlace);
  });
  queue = run.catch(() => undefined);
  const places = await run;
  cache.set(key, { at: Date.now(), places });
  return places;
}
