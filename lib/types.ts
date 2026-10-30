/** 画面とサーバーで共有する型 */
import type { BBox } from '@/lib/geo';
import type { RegionKey } from '@/lib/regions';

export type Place = {
  id: string;
  name: string;
  /** 都道府県・市区町村など、同名の場所を見分けるための補足 */
  address: string;
  /** 「駅」「城」「公園」などの種類（日本語） */
  kind: string;
  lon: number;
  lat: number;
  bbox: BBox | null;
};

export type SearchResponse = { places: Place[]; attribution: string } | { error: string };

/** 土地被覆の 1 区分 */
export type LandCoverClass = {
  key: string;
  label: string;
  color: string;
  ratio: number;      // 0〜1
  areaM2: number;
};

export type LandCover = {
  method: 'segmentation' | 'color-index';
  methodLabel: string;
  classes: LandCoverClass[];
  overlayUrl: string | null;
  notes: string[];
};

export type Finding = {
  name: string;
  where: string;
  detail: string;
  confidence: '高' | '中' | '低';
};

export type AiReport = {
  engine: string;     // 表示用（例「Ollama gemma4:e4b-it-q4_K_M」）
  summary: string;
  findings: Finding[];
  caveats: string[];
  seconds: number;
};

export type AnalysisMeta = {
  id: string;
  bbox: BBox;
  zoom: number;
  metersPerPixel: number;
  widthPx: number;
  heightPx: number;
  widthM: number;
  heightM: number;
  areaM2: number;
  imageUrl: string;
  missingTiles: number;
  credit: string;
};

/** 地図に形と数を出すもの（いまは建物）。数は地図データや検出の結果を正とし、AI はそれを言葉にする */
export type MapObjects = {
  kind: 'building';
  label: string;          // 「建物」
  unit: string;           // 「棟」
  count: number;
  /** 数えた範囲（「範囲全体」「右下（南東）の区画」など）。数が何を指すかを画面に書くため */
  scope: string;
  /** 種別ごとの数（多い順） */
  breakdown: { label: string; count: number }[];
  /** 出典（画面に出す） */
  source: string;
  /** 数を読むときの注意 */
  note: string;
  geojson: GeoJSON.FeatureCollection<GeoJSON.Polygon | GeoJSON.MultiPolygon>;
};

/** 追加の質問への答え */
export type AskAnswer = {
  text: string;
  /** 説明に使う土地被覆の区分（LandCoverClass.key）。画面はこの色だけを写真と地図に残す */
  classes: string[];
  /** 説明の中心になる区画。特定できないときは null */
  region: RegionKey | null;
  /** 位置と数を地図に出すもの（建物の質問など）。無ければ null */
  objects: MapObjects | null;
  /** 答える前に行った追加の解析（画面に「確かめたこと」として出す） */
  checks: string[];
  engine: string;
  seconds: number;
};

/** 写真と地図に示しているもの：色を残す土地被覆の区分（空なら全部）・枠で囲む区画・形を描くもの */
export type Highlight = { classes: string[]; region: RegionKey | null; objects: MapObjects | null };

/** 前の質問と答え。続けて質問するときに文脈として渡す */
export type AskTurn = { question: string; answer: string };

/** 質問 API が NDJSON で 1 行ずつ返すイベント */
export type AskEvent =
  | { type: 'step'; message: string }
  | { type: 'answer'; answer: AskAnswer }
  | { type: 'error'; message: string };

/** 解析 API が NDJSON で 1 行ずつ返すイベント */
export type AnalysisEvent =
  | { type: 'stage'; stage: 'imagery' | 'landcover' | 'ai'; message: string; progress?: number; detail?: string }
  | { type: 'meta'; meta: AnalysisMeta }
  | { type: 'landcover'; landCover: LandCover }
  | { type: 'ai'; ai: AiReport }
  | { type: 'ai-unavailable'; message: string }
  | { type: 'done'; cached: boolean }
  | { type: 'error'; message: string };
