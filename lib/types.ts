/** 画面とサーバーで共有する型 */
import type { BBox } from '@/lib/geo';

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

/** 解析 API が NDJSON で 1 行ずつ返すイベント */
export type AnalysisEvent =
  | { type: 'stage'; stage: 'imagery' | 'landcover' | 'ai'; message: string; progress?: number; detail?: string }
  | { type: 'meta'; meta: AnalysisMeta }
  | { type: 'landcover'; landCover: LandCover }
  | { type: 'ai'; ai: AiReport }
  | { type: 'ai-unavailable'; message: string }
  | { type: 'done'; cached: boolean }
  | { type: 'error'; message: string };
