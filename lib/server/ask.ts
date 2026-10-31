/**
 * 解析した範囲について、追加の質問に答える。
 *
 * 答える前に、AI へ渡す根拠を CV 側で足す（追加の解析）:
 * - 土地被覆の重ね絵から、写真を 3×3 に分けた区画ごとの構成を数える（「どこに多いか」に答えるため）
 * - 質問に位置を指す語（左上・北東など）があれば、その区画（2 つまで）を切り出して拡大した写真も渡す
 *
 * - 建物の数や位置を聞かれたら、国土地理院の地図データから建物を取り出し、棟数（区画ごと）を数える
 * - 車や駐車場を聞かれたら、OpenStreetMap の駐車場を取り出し、か所数と収容台数（区画ごと）を数える
 * - 船を聞かれたら、自前で学習した検出モデルで、z18 の写真から船を 1 隻ずつ見つけて数える
 *
 * AI には、答えの文と、画面で色を付けて示す区分・区画を構造化出力で返させる。建物の形と数は地図データの
 * ものをそのまま画面に出し、AI にはその数を言葉にさせる。
 * 数値は CV を正とし、AI には言語化を任せる（解析と同じ方針）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { type BBox, bboxCenter, formatDms, formatLength } from '@/lib/geo';
import { REGION_KEYS, REGION_LABEL, type RegionKey, isRegionKey, regionAt, regionCell, regionsInText } from '@/lib/regions';
import type { AiReport, AskEvent, AskTurn, LandCover, LandCoverClass, MapObjects } from '@/lib/types';
import { type Building, buildingObjects, buildingsIn } from '@/lib/server/buildings';
import { OverpassBusyError, type ParkingLot, type SkippedLot, capacityText, parkingCapacity, parkingIn, parkingObjects } from '@/lib/server/parking';
import { type Ship, ShipAreaError, shipModelAvailable, shipObjects, shipsIn } from '@/lib/server/ships';
import { ANALYSIS_DIR, readSaved } from '@/lib/server/analysis';
import { fitForModel, planAi, runAiJson } from '@/lib/server/ai';

/** 利用者に見せてよい失敗（解析が無い・AI が使えないなど） */
export class AskError extends Error {}

/** 続けて質問するときに AI へ渡す、前の質問と答えの数 */
const HISTORY_TURNS = 4;
/** 拡大した区画の写真の長辺の下限（px）。小さな範囲でも細部が読めるように広げる */
const CROP_MIN_PX = 896;
/** 区画を切り出すとき、境目の地物が切れないよう周りに足す割合 */
const CROP_MARGIN = 0.15;

export const ASK_SYSTEM_PROMPT = `あなたは空中写真判読の専門家です。日本の空中写真（オルソ画像）と、その解析結果をもとに、利用者の追加の質問に日本語で答えます。

守ること:
- 写真・土地被覆の数値・これまでの所見から言えることだけを答える。分からないことは分からないと答える。
- 地名・施設名は、写真に文字が読めるときを除いて推測で書かない。
- 位置は写真の中の場所（左上・中央・右下など）で示す。写真は北が上。
- 割合は与えた数値（区画ごとの構成を含む）を使い、独自の割合は書かない。「どこに多いか」は「区分ごとに多い区画」の順位に従う。
- 割合を並べるだけにせず、写真に写っているもの（建物の形や並び方、道路、水面、グラウンドなど）を説明する。数値は根拠として 1〜2 個までにする。
- answer は 2〜5 文で、です・ます調。key（building・se などの英字）は answer に書かず、日本語の名前で書く。
- classes には、答えの説明に使う土地被覆の区分の key を入れる（画面ではその色だけを写真と地図に残して示す）。関係が無ければ空にする。
- region には、答えの中心になる区画の key を入れる。範囲全体の話や、特定できないときは none。
- 建物の数（棟数）を与えたときは、その数をそのまま使い、独自に数えない。地図データの時点と写真の撮影時期が違うことに触れてよい。
- 車は、この写真の解像度（約 0.5 m/px）では 1 台ずつ数えられない。駐車場の数と収容台数（地図データ）を与えたときは、その数をそのまま使い、「収容できる台数の目安で、写真に写っている車の数ではない」ことを必ず添える。与えていないときは、数えられないことと理由を伝え、舗装地の割合・位置で答える。
- 船の数（検出モデル）を与えたときは、その数をそのまま使い、自動で見つけた数で数え違いがあり得ることを添える。与えていないときは、数えられないことを伝え、水域の割合・位置で答える。
- 建物・駐車場・船の数は、与えた数だけを使う。数を与えていないものの数は、写真から推測して答えず、「今回は数えていない」と伝える。
- 写真や解析と関係の無い質問には、答えられないと短く伝える。`;

function askSchema(classKeys: string[]) {
  return {
    type: 'object',
    properties: {
      answer: { type: 'string', description: '質問への答え。2〜5 文、です・ます調' },
      classes: {
        type: 'array',
        description: '答えの説明に使う土地被覆の区分。画面ではこの色だけを残して示す。関係が無ければ空',
        items: { type: 'string', enum: classKeys },
      },
      region: {
        type: 'string',
        enum: [...REGION_KEYS, 'none'],
        description: '答えの中心になる区画。範囲全体の話や特定できないときは none',
      },
    },
    required: ['answer', 'classes', 'region'],
    additionalProperties: false,
  };
}

type RegionStats = Record<RegionKey, { valid: number; counts: Map<string, number> }>;

/** 「rgb(219 40 150)」→ 0xdb2896。重ね絵の画素と突き合わせる */
function colorKey(css: string): number | null {
  const m = css.match(/\d+/g);
  if (!m || m.length < 3) return null;
  return (Number(m[0]) << 16) | (Number(m[1]) << 8) | Number(m[2]);
}

/** 区画ごとの集計は、同じ重ね絵なら何度聞かれても同じなので覚えておく */
const statsCache = new Map<string, RegionStats>();
const STATS_CACHE_MAX = 16;

/**
 * 重ね絵（区分ごとに単色で塗った PNG）を 3×3 に分け、区画ごとに区分の画素を数える。
 * 透明な画素（写真の無い部分）は数えない
 */
async function regionStats(file: string, classes: LandCoverClass[]): Promise<RegionStats> {
  const hit = statsCache.get(file);
  if (hit) return hit;
  const { data, info } = await sharp(await fs.readFile(file)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const lut = new Map<number, string>();
  for (const c of classes) {
    const k = colorKey(c.color);
    if (k !== null) lut.set(k, c.key);
  }
  const stats = Object.fromEntries(REGION_KEYS.map((k) => [k, { valid: 0, counts: new Map() }])) as RegionStats;
  const { width: W, height: H, channels } = info;
  for (let y = 0; y < H; y++) {
    const row = Math.min(2, Math.floor((y * 3) / H));
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * channels;
      if (data[i + 3] === 0) continue;
      const cell = stats[REGION_KEYS[row * 3 + Math.min(2, Math.floor((x * 3) / W))]];
      cell.valid++;
      // 0.1% 未満で一覧から外した区分の画素は、分母にだけ入れる
      const key = lut.get((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (key) cell.counts.set(key, (cell.counts.get(key) ?? 0) + 1);
    }
  }
  if (statsCache.size >= STATS_CACHE_MAX) statsCache.delete(statsCache.keys().next().value!);
  statsCache.set(file, stats);
  return stats;
}

function regionLines(stats: RegionStats, classes: LandCoverClass[]): string[] {
  const label = new Map(classes.map((c) => [c.key, c.label]));
  return REGION_KEYS.map((k) => {
    const { valid, counts } = stats[k];
    if (!valid) return `- ${k} ${REGION_LABEL[k]}：写真なし`;
    const parts = [...counts]
      .map(([key, n]) => ({ key, ratio: n / valid }))
      .filter((p) => p.ratio >= 0.03)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 4)
      .map((p) => `${label.get(p.key)} ${Math.round(p.ratio * 100)}%`);
    return `- ${k} ${REGION_LABEL[k]}：${parts.join('・') || '目立つ区分なし'}`;
  });
}

/** 区分ごとに、その区分が多い区画を上から 3 つ。「どこに多いか」をモデルが表から読み違えないように */
function rankingLines(stats: RegionStats, classes: LandCoverClass[]): string[] {
  return classes.map((c) => {
    const top = REGION_KEYS
      .map((k) => ({ k, ratio: stats[k].valid ? (stats[k].counts.get(c.key) ?? 0) / stats[k].valid : 0 }))
      .filter((r) => r.ratio >= 0.03)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 3)
      .map((r) => `${r.k} ${REGION_LABEL[r.k]} ${Math.round(r.ratio * 100)}%`);
    return `- ${c.key} ${c.label}：${top.join(' > ') || '目立って多い区画なし'}`;
  });
}

/**
 * 質問の語 → 関係する区分。小さなモデルは表の途中を読み落とすので、該当する順位を質問の直前にも置く。
 * 1 文字の語は別の言葉の一部に当たりやすい（「土地」の土、「空港」の港、「鉄道」の道）ので、2 文字以上の語で見る
 */
const CLASS_WORDS: [RegExp, string[]][] = [
  [/建物|ビル|家屋|住宅|民家|屋根|工場|倉庫|施設/, ['building', 'artificial']],
  [/道路|車道|駐車場|舗装|アスファルト|交差点/, ['paved', 'artificial']],
  [/水域|水辺|水面|海|川|池|湖|港湾|漁港|運河|水路/, ['water', 'dark']],
  [/森|林|樹木|木々|樹林/, ['forest', 'vegetation']],
  [/草地|芝|公園/, ['grass', 'vegetation']],
  [/緑|植物|植生/, ['forest', 'grass', 'farm', 'vegetation']],
  [/水田|田んぼ|田畑|畑|農地|農業/, ['farm', 'vegetation']],
  [/裸地|むき出し|未舗装|グラウンド|線路|鉄道|空き地|造成/, ['bare']],
];

function classesInText(text: string, classes: LandCoverClass[]): Set<string> {
  const present = new Set(classes.map((c) => c.key));
  // 「水田」は水域ではなく農地として扱う
  const t = text.replace(/水田/g, '田んぼ');
  const out = new Set<string>();
  for (const [re, keys] of CLASS_WORDS) if (re.test(t)) keys.filter((k) => present.has(k)).forEach((k) => out.add(k));
  return out;
}

/**
 * 建物の数や位置を聞いているか。建物の語に加えて、数・場所を問う語があるときだけにする。
 * 「住宅地以外で緑が多いのは」「建物と道路の割合は」のような土地被覆の質問は、建物の形を出さずに答える
 */
const BUILDING_WORDS = /建物|ビル|家屋|住宅|民家|戸建|一軒家|マンション|団地|工場|倉庫|建築物/;
const COUNT_OR_PLACE = /何棟|棟数|何軒|いくつ|数|どこ|どの|位置|場所|分布|示して|見せて|表示/;
const NOT_OBJECTS = /以外|割合|比率|面積|[%％]/;
export function asksForBuildings(q: string): boolean {
  if (/何棟|棟数/.test(q)) return true;
  return BUILDING_WORDS.test(q) && COUNT_OR_PLACE.test(q) && !NOT_OBJECTS.test(q);
}

/** 「ありますか」「いますか」も含めて、ものがあるかを問う語 */
const EXISTS = /多い|少ない|あ[るりっ]|い[るまっ]/;
/** 車ではない「車」（電車・自転車・観覧車・車庫など）と、自動車以外の乗り物 */
const NOT_CARS = /電車|列車|汽車|馬車|風車|水車|滑車|自転車|観覧車|貨車|停車|下車|発車|乗車|車庫|車道|車線|車両|車窓|船|ボート|ヨット|クレーン/;
/** 道路や交通を聞く質問は、駐車場ではなく舗装の区分で答える */
const ROAD_WORDS = /道路|通り|交通|渋滞|交差点|高速/;
const CAR_WORDS = /駐車|パーキング|車|クルマ|自動車/;

/**
 * 車や駐車場の数・位置を聞いているか。車ではない「車」（電車・自転車など）や、道路・交通の質問は除く。
 * 「駐車場の割合は」のような土地被覆の質問も、駐車場の形を出さずに答える
 */
export function asksForParking(q: string): boolean {
  // 「駐車」が無い質問では、車ではない「車」の語を消してから車の語を探す
  const t = /駐車|パーキング/.test(q) ? q : q.replace(new RegExp(NOT_CARS.source, 'g'), '');
  if (!CAR_WORDS.test(t) && !(/何台|台数/.test(q) && !NOT_CARS.test(q))) return false;
  if (!/駐車|パーキング/.test(q) && ROAD_WORDS.test(q)) return false;
  if (/何台|台数/.test(q)) return true;
  return (COUNT_OR_PLACE.test(q) || EXISTS.test(q)) && !NOT_OBJECTS.test(q);
}

/** 船の数や位置を聞いているか。「風船」「造船所」は除く。船の語があれば「何台」も船の数とみなす */
const SHIP_WORDS = /(?<![風造])船(?!所)|ボート|ヨット|漁船|フェリー|タンカー|艦|何隻|隻数/;
export function asksForShips(q: string): boolean {
  if (/何隻|隻数/.test(q)) return true;
  if (!SHIP_WORDS.test(q)) return false;
  if (/何台|台数/.test(q)) return true;
  return (COUNT_OR_PLACE.test(q) || EXISTS.test(q)) && !NOT_OBJECTS.test(q);
}

/** 区画ごとの数（多い順）。プロンプトに渡す */
function countByRegion(items: { center: [number, number] }[], bbox: BBox, unit: string): string[] {
  const counts = new Map<RegionKey, number>();
  for (const it of items) {
    const k = regionAt(bbox, it.center[0], it.center[1]);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return REGION_KEYS.map((k) => ({ k, n: counts.get(k) ?? 0 }))
    .sort((a, b) => b.n - a.n)
    .map(({ k, n }) => `- ${k} ${REGION_LABEL[k]}：${n} ${unit}`);
}

/** 区画ごとの駐車場のか所数と収容台数（台数の多い順）。プロンプトに渡す */
function parkingRegionLines(lots: ParkingLot[], bbox: BBox): string[] {
  const by = new Map<RegionKey, ParkingLot[]>();
  for (const l of lots) {
    const k = regionAt(bbox, l.center[0], l.center[1]);
    by.set(k, [...(by.get(k) ?? []), l]);
  }
  return REGION_KEYS.map((k) => ({ k, list: by.get(k) ?? [] }))
    .map(({ k, list }) => ({ k, n: list.length, cap: parkingCapacity(list), text: capacityText(list) }))
    .sort((a, b) => b.cap.total - a.cap.total || b.n - a.n)
    .map(({ k, n, text }) => `- ${k} ${REGION_LABEL[k]}：${n} か所${text ? `・${text}` : ''}`);
}

/** 区画を周りを少し含めて切り出し、細部が読める大きさに広げる */
async function cropRegion(photo: Buffer, key: RegionKey): Promise<Buffer> {
  const { width: W = 0, height: H = 0 } = await sharp(photo).metadata();
  const { col, row } = regionCell(key);
  const cw = W / 3, ch = H / 3;
  const left = Math.max(0, Math.floor(col * cw - cw * CROP_MARGIN));
  const top = Math.max(0, Math.floor(row * ch - ch * CROP_MARGIN));
  const right = Math.min(W, Math.ceil((col + 1) * cw + cw * CROP_MARGIN));
  const bottom = Math.min(H, Math.ceil((row + 1) * ch + ch * CROP_MARGIN));
  const w = right - left, h = bottom - top;
  const scale = Math.max(1, CROP_MIN_PX / Math.max(w, h));
  return sharp(photo)
    .extract({ left, top, width: w, height: h })
    .resize(Math.round(w * scale), Math.round(h * scale), { kernel: 'cubic' })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function findingLines(ai: AiReport | undefined): string[] {
  if (!ai) return ['- （まだありません）'];
  return [
    `要約：${ai.summary}`,
    ...ai.findings.map((f) => `- ${f.name}（${f.where}、確度 ${f.confidence}）：${f.detail}`),
  ];
}

/** 前の質問と答え。長すぎる答えは切り詰めて、最近のものだけを渡す */
function historyLines(history: AskTurn[]): string[] {
  return history.slice(-HISTORY_TURNS).flatMap((t) => [
    `Q：${t.question.slice(0, 400)}`,
    `A：${t.answer.slice(0, 600)}`,
  ]);
}

export async function answerQuestion(
  id: string,
  question: string,
  history: AskTurn[],
  emit: (ev: AskEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const dir = path.join(ANALYSIS_DIR, id);
  const saved = await readSaved(dir);
  if (!saved) throw new AskError('この範囲の解析結果が見つかりません。もう一度解析してから質問してください。');
  const plan = await planAi();
  if (!plan.provider) throw new AskError(plan.reason);

  const { meta, landCover } = saved;
  const t0 = performance.now();
  const checks: string[] = [];

  // 1. 区画ごとの土地被覆（重ね絵があるときだけ）
  let regions: string[] = [];
  let ranking: string[] = [];
  let focusRanking: string[] = [];
  const overlayFile = overlayPath(dir, landCover);
  if (overlayFile) {
    emit({ type: 'step', message: '区画ごとの土地被覆を集計' });
    const stats = await regionStats(overlayFile, landCover.classes);
    regions = regionLines(stats, landCover.classes);
    ranking = rankingLines(stats, landCover.classes);
    const mentioned = classesInText(question, landCover.classes);
    focusRanking = rankingLines(stats, landCover.classes.filter((c) => mentioned.has(c.key)));
    checks.push('写真を 3×3 の区画に分け、区画ごとの土地被覆を集計しました');
  }
  signal.throwIfAborted();

  // 2. 位置を聞かれていれば、その区画（比べる質問なら 2 つまで）を拡大した写真も見せる
  const photo = await fs.readFile(path.join(dir, 'photo.jpg'));
  const images = [await fitForModel(photo, plan.provider)];
  const asked = regionsInText(question);
  if (asked.length) {
    const names = asked.map((k) => REGION_LABEL[k]).join('と');
    emit({ type: 'step', message: `${names}の区画を拡大` });
    for (const k of asked) images.push(await fitForModel(await cropRegion(photo, k), plan.provider));
    checks.push(`${names}の区画を拡大した写真で確かめました`);
  }
  signal.throwIfAborted();

  // 3. 建物を聞かれていれば、地図データから取り出して数える（取れなくても答えは続ける）
  let found: { buildings: Building[]; dataTime: string | null } | null = null;
  let parking: { lots: ParkingLot[]; skipped: SkippedLot[] } | null = null;
  let buildingLines: string[] = [];
  let parkingLines: string[] = [];
  let ships: Ship[] | null = null;
  let shipLines: string[] = [];
  // 1 つの質問で地図に描くのは 1 種類だけ（棟数を名指しされていれば建物、次に船、駐車場、建物の順）
  const named = /何棟|棟数/.test(question);
  const wantsShips = !named && asksForShips(question);
  const wantsParking = !named && !wantsShips && asksForParking(question);
  const wantsBuildings = !wantsShips && !wantsParking && asksForBuildings(question);
  // 選ばなかった種類も聞かれていたら、数えていないことを伝える（AI が根拠なく数を答えないため）
  const dropped = [
    !wantsShips && asksForShips(question) ? '船' : '',
    !wantsParking && asksForParking(question) ? '駐車場' : '',
    !wantsBuildings && asksForBuildings(question) ? '建物' : '',
  ].filter(Boolean);
  if (dropped.length) checks.push(`${dropped.join('・')}は数えていません（1 回の質問で地図に示すのは 1 種類です。分けて聞いてください）`);
  if (wantsShips) {
    if (!shipModelAvailable()) {
      checks.push('船の検出モデル（models/ship_unet.onnx）が無いため、船は数えていません');
    } else {
      emit({ type: 'step', message: '検出モデルで船を探す（z18 の写真）' });
      try {
        ships = await shipsIn(meta.bbox, signal);
        const all = shipObjects(ships, '範囲全体');
        const inAsked = ships.filter((sh) => asked.includes(regionAt(meta.bbox, sh.center[0], sh.center[1])));
        shipLines = [
          `船の数（${all.basis}。自動で見つけた数で、数え違いがあり得る）:`,
          `- 範囲全体：${all.count} 隻（${all.breakdown.map((t) => `${t.label} ${t.count}`).join('・') || 'なし'}）`,
          ...(asked.length ? [`- 質問の区画（${asked.map((k) => REGION_LABEL[k]).join('・')}）：${inAsked.length} 隻`] : []),
          `区画ごとの隻数（多い順。「船がどこに多いか」はこの隻数で答える）:`,
          ...countByRegion(ships, meta.bbox, '隻'),
        ];
      } catch (e) {
        if (signal.aborted) throw e;
        if (e instanceof ShipAreaError) checks.push(`${e.message}。地図で範囲を狭めて解析し直してください`);
        else {
          console.error('[ask] 船を探せませんでした', e);
          checks.push('船を探せなかったため、写真と土地被覆だけで答えました');
        }
      }
    }
  }
  if (wantsBuildings) {
    emit({ type: 'step', message: '地図データから建物を取り出す' });
    try {
      found = await buildingsIn(meta.bbox, signal);
      const { buildings, dataTime } = found;
      const all = buildingObjects(buildings, dataTime, '範囲全体');
      const kinds = (o: MapObjects) => o.breakdown.map((t) => `${t.label} ${t.count}`).join('・');
      const inAsked = buildings.filter((b) => asked.includes(regionAt(meta.bbox, b.center[0], b.center[1])));
      buildingLines = [
        `建物の数（${all.source}。写真の撮影時期とは違う）:`,
        `- 範囲全体：${all.count} 棟（${kinds(all) || 'なし'}）`,
        ...(asked.length ? [`- 質問の区画（${asked.map((k) => REGION_LABEL[k]).join('・')}）：${inAsked.length} 棟`] : []),
        `区画ごとの棟数（多い順。「建物がどこに多いか」はこの棟数で答える）:`,
        ...countByRegion(buildings, meta.bbox, '棟'),
      ];
    } catch (e) {
      if (signal.aborted) throw e;
      console.error('[ask] 建物を取り出せませんでした', e);
      checks.push('地図データの建物を取り出せなかったため、写真と土地被覆だけで答えました');
    }
  }
  if (wantsParking) {
    emit({ type: 'step', message: '地図データ（OpenStreetMap）から駐車場を取り出す' });
    try {
      parking = await parkingIn(meta.bbox, signal);
      const all = parkingObjects(parking.lots, parking.skipped.length, '範囲全体');
      const inAsked = parking.lots.filter((l) => asked.includes(regionAt(meta.bbox, l.center[0], l.center[1])));
      parkingLines = [
        `駐車場（${all.source}。収容できる台数の目安で、写真に写っている車の数ではない）:`,
        `- 範囲全体：${all.count} か所${all.summary ? `、${all.summary}` : ''}`,
        ...(asked.length ? [`- 質問の区画（${asked.map((k) => REGION_LABEL[k]).join('・')}）：${inAsked.length} か所${inAsked.length ? `・${capacityText(inAsked)}` : ''}`] : []),
        `区画ごとの駐車場（収容台数の多い順。「駐車場や車がどこに多いか」はこの順位で答える）:`,
        ...parkingRegionLines(parking.lots, meta.bbox),
      ];
    } catch (e) {
      if (signal.aborted) throw e;
      console.error('[ask] 駐車場を取り出せませんでした', e);
      checks.push(e instanceof OverpassBusyError
        ? 'OpenStreetMap のサーバーが混み合っていて駐車場を取り出せなかったため、写真と土地被覆だけで答えました（時間をおいて聞き直してください）'
        : '地図データの駐車場を取り出せなかったため、写真と土地被覆だけで答えました');
    }
  }
  signal.throwIfAborted();

  // 4. AI に答えさせる
  emit({ type: 'step', message: `AI が答えを作成（${plan.label}）` });
  const [lon, lat] = bboxCenter(meta.bbox);
  const user = [
    `写真の条件:`,
    `- 中心：${formatDms(lat, 'lat')} ${formatDms(lon, 'lon')}（日本）`,
    `- 範囲：東西 ${formatLength(meta.widthM)} × 南北 ${formatLength(meta.heightM)}、北が上`,
    `- 解像度：約 ${meta.metersPerPixel.toFixed(2)} m/px`,
    ``,
    `土地被覆の区分（key：名前 範囲全体の割合、${landCover.methodLabel}）:`,
    ...landCover.classes.map((c) => `- ${c.key}：${c.label} ${(c.ratio * 100).toFixed(1)}%`),
    ...(regions.length ? [``, `区画ごとの構成（写真を 3×3 に分けた区画。key 名前：構成）:`, ...regions] : []),
    ...(ranking.length ? [``, `区分ごとに多い区画（多い順）:`, ...ranking] : []),
    ``,
    `これまでの所見:`,
    ...findingLines(saved.ai[plan.label] ?? Object.values(saved.ai)[0]),
    ...(history.length ? [``, `これまでの質問と答え:`, ...historyLines(history)] : []),
    ``,
    asked.length
      ? `1 枚目は範囲全体。${asked.map((k, i) => `${i + 2} 枚目は「${REGION_LABEL[k]}」`).join('、')}の区画（周りを少し含む）を拡大した写真です。`
      : `写真は範囲全体です。`,
    // 建物の棟数を渡すときは、建物の「どこに多いか」を土地被覆の割合ではなく棟数で答えさせる
    ...((f) => (f.length ? [``, `この質問に関係する集計（多い順。「どこに多いか」はこの順位で答える）:`, ...f] : []))(
      buildingLines.length ? focusRanking.filter((l) => !l.startsWith('- building '))
        : parkingLines.length ? focusRanking.filter((l) => !l.startsWith('- paved '))
          : shipLines.length ? focusRanking.filter((l) => !l.startsWith('- water ')) : focusRanking,
    ),
    ...(buildingLines.length ? [``, ...buildingLines] : []),
    ...(parkingLines.length ? [``, ...parkingLines] : []),
    ...(shipLines.length ? [``, ...shipLines] : []),
    ``,
    `質問：${question}`,
  ].join('\n');

  const raw = await runAiJson(plan, ASK_SYSTEM_PROMPT, user, images, askSchema(landCover.classes.map((c) => c.key)), signal);
  const o = raw as { answer?: unknown; classes?: unknown; region?: unknown } | null;
  const text = typeof o?.answer === 'string' ? o.answer.trim() : '';
  if (!text) throw new Error('AI の答えを読み取れませんでした。');
  const known = new Set(landCover.classes.map((c) => c.key));
  // AI が「none」（範囲全体の話）と判断したときはそれに従う。値が無い・壊れているときだけ、質問で指した区画を使う
  const region = o?.region === 'none' ? null : isRegionKey(o?.region) ? o.region : (asked[0] ?? null);
  // 示す区画（質問で指した区画、無ければ AI が挙げた区画）の分だけを描いて数える。数と枠の範囲をそろえるため
  const scopeKeys = asked.length ? asked : region ? [region] : [];
  const scope = scopeKeys.length ? `${scopeKeys.map((k) => REGION_LABEL[k]).join('と')}の区画` : '範囲全体';
  const inScope = <T extends { center: [number, number] }>(items: T[]) =>
    scopeKeys.length ? items.filter((it) => scopeKeys.includes(regionAt(meta.bbox, it.center[0], it.center[1]))) : items;
  let objects: MapObjects | null = null;
  if (found) {
    objects = buildingObjects(inScope(found.buildings), found.dataTime, scope);
    checks.push(`国土地理院の地図データから建物を数えました（${scope}で ${objects.count.toLocaleString('ja-JP')} 棟）`);
  } else if (parking) {
    objects = parkingObjects(inScope(parking.lots), inScope(parking.skipped).length, scope);
    checks.push(`OpenStreetMap から駐車場を数えました（${scope}で ${objects.count.toLocaleString('ja-JP')} か所）`);
  } else if (ships) {
    objects = shipObjects(inScope(ships), scope);
    checks.push(`検出モデルで z18 の写真から船を探しました（${scope}で ${objects.count.toLocaleString('ja-JP')} 隻）`);
  }
  // 建物・駐車場・船の形を描くときは、土地被覆の色は重ねない（形と色が重なって読みにくくなるため）
  const classes = Array.isArray(o?.classes) && !objects
    ? [...new Set(o.classes.filter((k): k is string => typeof k === 'string' && known.has(k)))]
    : [];
  emit({
    type: 'answer',
    answer: { text, classes, region, objects, checks, engine: plan.label, seconds: (performance.now() - t0) / 1000 },
  });
}

/** 重ね絵のファイル。URL の名前は解析が決めたものだけなので、そのまま解析の置き場所に当てる */
function overlayPath(dir: string, landCover: LandCover): string | null {
  const name = landCover.overlayUrl?.split('/').pop();
  return name && /^overlay-[a-z-]+\.png$/.test(name) ? path.join(dir, name) : null;
}
