/**
 * 解析した範囲について、追加の質問に答える。
 *
 * 答える前に、AI へ渡す根拠を CV 側で足す（追加の解析）:
 * - 土地被覆の重ね絵から、写真を 3×3 に分けた区画ごとの構成を数える（「どこに多いか」に答えるため）
 * - 質問に位置を指す語（左上・北東など）があれば、その区画（2 つまで）を切り出して拡大した写真も渡す
 *
 * AI には、答えの文と、画面で色を付けて示す区分・区画を構造化出力で返させる。
 * 数値は CV を正とし、AI には言語化を任せる（解析と同じ方針）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { bboxCenter, formatDms, formatLength } from '@/lib/geo';
import { REGION_KEYS, REGION_LABEL, type RegionKey, isRegionKey, regionCell, regionsInText } from '@/lib/regions';
import type { AiReport, AskEvent, AskTurn, LandCover, LandCoverClass } from '@/lib/types';
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

  // 3. AI に答えさせる
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
    ...(focusRanking.length ? [``, `この質問に関係する集計（多い順。「どこに多いか」はこの順位で答える）:`, ...focusRanking] : []),
    ``,
    `質問：${question}`,
  ].join('\n');

  const raw = await runAiJson(plan, ASK_SYSTEM_PROMPT, user, images, askSchema(landCover.classes.map((c) => c.key)), signal);
  const o = raw as { answer?: unknown; classes?: unknown; region?: unknown } | null;
  const text = typeof o?.answer === 'string' ? o.answer.trim() : '';
  if (!text) throw new Error('AI の答えを読み取れませんでした。');
  const known = new Set(landCover.classes.map((c) => c.key));
  const classes = Array.isArray(o?.classes)
    ? [...new Set(o.classes.filter((k): k is string => typeof k === 'string' && known.has(k)))]
    : [];
  // AI が「none」（範囲全体の話）と判断したときはそれに従う。値が無い・壊れているときだけ、質問で指した区画を使う
  const region = o?.region === 'none' ? null : isRegionKey(o?.region) ? o.region : (asked[0] ?? null);
  emit({
    type: 'answer',
    answer: { text, classes, region, checks, engine: plan.label, seconds: (performance.now() - t0) / 1000 },
  });
}

/** 重ね絵のファイル。URL の名前は解析が決めたものだけなので、そのまま解析の置き場所に当てる */
function overlayPath(dir: string, landCover: LandCover): string | null {
  const name = landCover.overlayUrl?.split('/').pop();
  return name && /^overlay-[a-z-]+\.png$/.test(name) ? path.join(dir, name) : null;
}
