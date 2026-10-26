/**
 * 解析の手順をまとめる：空中写真の取得 → 土地被覆 → AI の判読。
 * 段ごとに結果を emit し、画面は届いた順に表示する。
 *
 * 結果は .cache/analyses/<id>/ に残し、同じ範囲・同じ AI なら取り直さずに返す。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { type BBox, bboxCenter, bboxSizeMeters } from '@/lib/geo';
import { ANALYSIS_CREDIT } from '@/lib/imagery';
import { chooseZoom } from '@/lib/selection';
import type { AiReport, AnalysisEvent, AnalysisMeta, LandCover } from '@/lib/types';
import { SelectionError, stitchBBox } from '@/lib/server/tiles';
import { analyzeLandCover } from '@/lib/server/landcover';
import { planAi, runAi } from '@/lib/server/ai';

export const ANALYSIS_DIR = path.join(process.cwd(), '.cache', 'analyses');
/** 解析の中身を変えたら上げる（古いキャッシュを使わないため） */
const PIPELINE_VERSION = 2;

type Saved = { meta: AnalysisMeta; landCover: LandCover; ai: Record<string, AiReport> };

export function analysisId(bbox: BBox): string {
  const key = JSON.stringify({ v: PIPELINE_VERSION, bbox: bbox.map((n) => n.toFixed(6)) });
  return createHash('sha256').update(key).digest('hex').slice(0, 20);
}

async function readSaved(dir: string): Promise<Saved | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, 'result.json'), 'utf8')) as Saved;
  } catch {
    return null;
  }
}

export async function runAnalysis(bbox: BBox, emit: (ev: AnalysisEvent) => void, signal: AbortSignal) {
  const choice = chooseZoom(bbox);
  if (!choice.ok) throw new SelectionError(choice.reason);

  const id = analysisId(bbox);
  const dir = path.join(ANALYSIS_DIR, id);
  const aiPlan = await planAi();
  const saved = await readSaved(dir);

  // 写真と土地被覆は範囲だけで決まるので、前に解析していれば使い回す
  let meta: AnalysisMeta;
  let landCover: LandCover;
  let photo: Buffer;
  if (saved) {
    meta = saved.meta;
    landCover = saved.landCover;
    photo = await fs.readFile(path.join(dir, 'photo.jpg'));
    emit({ type: 'meta', meta });
    emit({ type: 'landcover', landCover });
  } else {
    emit({ type: 'stage', stage: 'imagery', message: '空中写真を取得', progress: 0 });
    const st = await stitchBBox(bbox, choice.zoom, (done, total) =>
      emit({ type: 'stage', stage: 'imagery', message: `空中写真を取得（${done}/${total} タイル）`, progress: done / total }),
    );
    if (signal.aborted) return;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'photo.jpg'), st.image);
    photo = st.image;
    const size = bboxSizeMeters(bbox);
    meta = {
      id,
      bbox,
      zoom: st.zoom,
      metersPerPixel: st.metersPerPixel,
      widthPx: st.width,
      heightPx: st.height,
      widthM: size.width,
      heightM: size.height,
      areaM2: size.width * size.height,
      imageUrl: `/api/analyses/${id}/photo.jpg`,
      missingTiles: st.missingTiles,
      credit: ANALYSIS_CREDIT,
    };
    emit({ type: 'meta', meta });

    emit({ type: 'stage', stage: 'landcover', message: '土地被覆を判定', progress: 0 });
    const lc = await analyzeLandCover(photo, meta.metersPerPixel, meta.areaM2, (done, total) =>
      emit({ type: 'stage', stage: 'landcover', message: '土地被覆を判定', progress: done / total }),
    );
    if (lc.credit) meta = { ...meta, credit: `${meta.credit}。${lc.credit}` };
    if (signal.aborted) return;
    if (lc.overlayPng) await fs.writeFile(path.join(dir, 'overlay.png'), lc.overlayPng);
    landCover = { ...lc.landCover, overlayUrl: lc.overlayPng ? `/api/analyses/${id}/overlay.png` : null };
    emit({ type: 'meta', meta });
    emit({ type: 'landcover', landCover });
    await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify({ meta, landCover, ai: {} } satisfies Saved));
  }

  if (!aiPlan.provider) {
    emit({ type: 'ai-unavailable', message: aiPlan.reason });
    emit({ type: 'done', cached: Boolean(saved) });
    return;
  }
  const cachedAi = saved?.ai[aiPlan.label];
  if (cachedAi) {
    emit({ type: 'ai', ai: cachedAi });
    emit({ type: 'done', cached: true });
    return;
  }

  emit({ type: 'stage', stage: 'ai', message: 'AI が写真を判読', detail: aiPlan.label });
  const [lon, lat] = bboxCenter(bbox);
  let ai: AiReport;
  try {
    ai = await runAi(aiPlan, photo, {
      centerLon: lon,
      centerLat: lat,
      widthM: meta.widthM,
      heightM: meta.heightM,
      metersPerPixel: meta.metersPerPixel,
      landCoverMethod: landCover.methodLabel,
      landCoverLines: landCover.classes.map((c) => `${c.label} ${(c.ratio * 100).toFixed(1)}%`),
    }, signal);
  } catch (e) {
    if (signal.aborted) return;
    emit({ type: 'ai-unavailable', message: `AI の判読に失敗しました（${e instanceof Error ? e.message : String(e)}）。` });
    emit({ type: 'done', cached: Boolean(saved) });
    return;
  }
  const latest = (await readSaved(dir)) ?? { meta, landCover, ai: {} };
  latest.ai[aiPlan.label] = ai;
  await fs.writeFile(path.join(dir, 'result.json'), JSON.stringify(latest));
  emit({ type: 'ai', ai });
  emit({ type: 'done', cached: Boolean(saved) });
}
