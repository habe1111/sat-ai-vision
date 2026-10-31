'use client';
/**
 * 解析結果のパネル（判読調書）。PC では右側、スマホでは下から出す。
 * 結果は届いた順に埋まっていく（写真 → 土地被覆 → AI の所見）。終わった後は AI に追加で質問できる。
 */
import { useEffect, useMemo, useRef } from 'react';
import type { AnalysisState, StageKey } from '@/lib/client/useAnalysis';
import { bboxCenter, bboxSizeMeters, formatArea, formatDms, formatLength } from '@/lib/geo';
import { REGION_LABEL, regionCell } from '@/lib/regions';
import type { BBox } from '@/lib/geo';
import type { Highlight, LandCoverClass, MapObjects } from '@/lib/types';
import { AskSection } from '@/components/AskSection';
import { LandCoverSection } from '@/components/LandCoverSection';
import { STAGE_ORDER, StageTimeline } from '@/components/StageTimeline';
import { IconAlert, IconClose } from '@/components/icons';

type Props = {
  state: AnalysisState;
  overlayOn: boolean;
  onOverlayChange: (on: boolean) => void;
  /** 写真に重ねる土地被覆の絵（区分を選んでいれば、その色だけを残したもの） */
  overlaySrc: string | null;
  /** 写真と地図に示している区分・区画 */
  highlight: Highlight;
  onClassesChange: (keys: string[]) => void;
  onShowHighlight: (h: Highlight) => void;
  onClearHighlight: () => void;
  onClose: () => void;
  onRetry: () => void;
  /** 狭い画面で検索パネルを開いている間は、重ならないように隠す（中身はそのまま残す） */
  concealOnMobile: boolean;
};

/** スクリーンリーダーに伝える、段の切り替わり */
const STAGE_RUNNING: Record<StageKey, string> = {
  imagery: '空中写真を取得しています',
  landcover: '土地被覆を判定しています',
  ai: 'AI が写真を判読しています',
};
/**
 * 読み上げる短い文。毎秒変わる経過秒数や % は入れない（そのたびに読み上げが積まれるため）。
 * エラーは role="alert" の側で知らせるので、ここでは空にする
 */
function announcement(state: AnalysisState): string {
  if (state.status === 'done') {
    if (state.ai) return '解析が終わりました。AI の所見を表示しています。';
    if (state.aiUnavailable) return '解析が終わりました。AI の所見はありません。';
    return '解析が終わりました。';
  }
  if (state.status !== 'running') return '';
  const k = STAGE_ORDER.find((key) => state.stages[key].status === 'running');
  if (!k) return '';
  if (k === 'ai' && state.landCover) return `土地被覆の構成を表示しました。${STAGE_RUNNING.ai}`;
  return STAGE_RUNNING[k];
}

/** 写真と地図にいま何を示しているか */
function describeHighlight(h: Highlight, classes: LandCoverClass[]): string {
  const names = h.classes.map((k) => classes.find((c) => c.key === k)?.label).filter(Boolean);
  const parts = [];
  if (names.length) parts.push(`${names.join('・')}の色だけ`);
  if (h.objects) parts.push(`${h.objects.scope}の${h.objects.label} ${h.objects.count.toLocaleString('ja-JP')} ${h.objects.unit}（${h.objects.basis}）`);
  if (h.region) parts.push(`${REGION_LABEL[h.region]}の区画`);
  return `${parts.join('と')}を表示しています。`;
}

/**
 * 写真の上に建物などの形を描く。写真は Web メルカトルなので、緯度はメルカトルの縦位置に直す。
 * 数千棟でも軽いよう 1 本の path にまとめ、形が変わったときだけ作り直す
 */
function ObjectShapes({ objects, bbox }: { objects: MapObjects; bbox: BBox }) {
  const d = useMemo(() => {
    const [w, s, e, n] = bbox;
    const my = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const x = (lon: number) => (((lon - w) / (e - w)) * 1000).toFixed(1);
    const y = (lat: number) => (((my(n) - my(lat)) / (my(n) - my(s))) * 1000).toFixed(1);
    const parts: string[] = [];
    for (const f of objects.geojson.features) {
      const polygons = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      for (const rings of polygons) for (const ring of rings) parts.push(`M${ring.map(([lon, lat]) => `${x(lon)},${y(lat)}`).join('L')}Z`);
    }
    return parts.join('');
  }, [objects, bbox]);
  return (
    <svg aria-hidden viewBox="0 0 1000 1000" preserveAspectRatio="none" className="absolute inset-0 size-full">
      <path d={d} fill="#ffd400" fillOpacity={0.3} fillRule="evenodd" stroke="#ffd400" strokeWidth={1} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function ReportPanel({
  state, overlayOn, onOverlayChange, overlaySrc, highlight, onClassesChange, onShowHighlight, onClearHighlight,
  onClose, onRetry, concealOnMobile,
}: Props) {
  const { meta, landCover, ai, bbox } = state;
  const size = bbox ? bboxSizeMeters(bbox) : null;
  const center = bbox ? bboxCenter(bbox) : null;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const overlayToggleRef = useRef<HTMLInputElement>(null);
  const focus = highlight.region ? regionCell(highlight.region) : null;

  // 開いたら見出しへフォーカスを移す。押した「この範囲を解析」は消えるので、body に落とさない
  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <>
    {/* 読み上げ用。スマホで検索中はパネルごと隠すので、その外に置いて隠れないようにする */}
    <p role="status" className="sr-only">{announcement(state)}</p>
    <aside
      aria-label="判読結果"
      className={`fixed inset-x-0 bottom-0 z-20 flex max-h-[62dvh] flex-col rounded-t-xl bg-paper text-ink shadow-[var(--shadow)]
        pb-[env(safe-area-inset-bottom)]
        land:left-auto land:right-[max(12px,env(safe-area-inset-right))] land:top-3 land:bottom-[max(12px,env(safe-area-inset-bottom))]
        land:max-h-none land:w-[min(360px,46vw)] land:rounded-lg land:pb-0
        lg:inset-x-auto lg:bottom-3 lg:right-3 lg:top-3 lg:max-h-none lg:w-[416px] lg:rounded-lg
        ${concealOnMobile ? 'max-lg:hidden' : ''}`}
    >
      <header className="flex items-start justify-between gap-3 border-b border-rule px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h2 ref={headingRef} tabIndex={-1} className="text-lg font-bold">判読結果</h2>
          {center && (
            <p className="num mt-0.5 text-xs text-ink-2">
              {formatDms(center[1], 'lat')} {formatDms(center[0], 'lon')} 付近
            </p>
          )}
        </div>
        <button type="button" onClick={onClose} className="-mr-2 rounded-md p-2 hover:bg-paper-2" aria-label="判読結果を閉じる">
          <IconClose className="size-5" />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-6">
        {/* 範囲の諸元 */}
        {size && (
          <dl className="num mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <dt className="text-ink-2">大きさ</dt>
            <dd>{formatLength(size.width)} × {formatLength(size.height)}</dd>
            <dt className="text-ink-2">面積</dt>
            <dd>{formatArea(size.width * size.height)}</dd>
            {meta && (
              <>
                <dt className="text-ink-2">解像度</dt>
                <dd>
                  {meta.metersPerPixel.toFixed(2)} m/px（ズーム {meta.zoom}、{meta.widthPx}×{meta.heightPx} px）
                </dd>
              </>
            )}
          </dl>
        )}

        {/* 解析の流れ。終わった後も、段ごとにかかった時間と、どこで止まったかが分かるように残す */}
        <StageTimeline state={state} />

        {state.error && (
          <div role="alert" className="mt-5 flex gap-3 rounded-md border border-danger/40 bg-white px-4 py-3 text-sm">
            <IconAlert className="mt-0.5 size-5 shrink-0 text-danger" />
            <div>
              <p>{state.error}</p>
              <button type="button" onClick={onRetry} className="mt-2 font-bold text-survey-ink underline underline-offset-4">
                もう一度解析する
              </button>
            </div>
          </div>
        )}

        {/* 解析に使った写真 */}
        {meta && (
          <figure className="mt-5">
            <div className="relative overflow-hidden rounded-md bg-ink" style={{ aspectRatio: `${meta.widthPx} / ${meta.heightPx}` }}>
              {/* eslint-disable-next-line @next/next/no-img-element -- 手元のサーバーが作った画像をそのまま見せる */}
              <img src={meta.imageUrl} alt="解析に使った空中写真" className="absolute inset-0 size-full object-cover" />
              {overlaySrc && overlayOn && (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={overlaySrc}
                  alt=""
                  className={`absolute inset-0 size-full object-cover ${highlight.classes.length ? 'opacity-80' : 'opacity-60'}`}
                />
              )}
              {highlight.objects && bbox && <ObjectShapes objects={highlight.objects} bbox={bbox} />}
              {focus && (
                <div
                  aria-hidden
                  className="absolute border-2 border-survey shadow-[0_0_0_9999px_rgb(13_20_24/0.35)]"
                  style={{ left: `${focus.col * 33.333}%`, top: `${focus.row * 33.333}%`, width: '33.334%', height: '33.334%' }}
                />
              )}
            </div>
            {(highlight.classes.length > 0 || highlight.region || highlight.objects) && (
              <p className="mt-2 text-xs leading-relaxed text-ink-2">
                {describeHighlight(highlight, landCover?.classes ?? [])}
                <button
                  type="button"
                  onClick={() => {
                    // このボタンは押すと消えるので、フォーカスをすぐ下の「重ねる」へ移す
                    overlayToggleRef.current?.focus();
                    onClearHighlight();
                  }}
                  className="-my-2 ml-1 rounded-md px-2 py-2 font-bold text-survey-ink underline underline-offset-4 hover:bg-paper-2"
                >
                  元に戻す
                </button>
              </p>
            )}
            {landCover?.overlayUrl && (
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                <input
                  ref={overlayToggleRef}
                  type="checkbox"
                  checked={overlayOn}
                  onChange={(e) => onOverlayChange(e.target.checked)}
                  className="size-4 accent-[var(--survey)]"
                />
                土地被覆を写真と地図に重ねる
              </label>
            )}
            {meta.missingTiles > 0 && (
              <figcaption className="mt-1 text-xs text-ink-2">
                範囲の一部に空中写真がありません（{meta.missingTiles} タイル）。黒い部分は解析から外しています。
              </figcaption>
            )}
          </figure>
        )}

        {/* 土地被覆 */}
        {landCover && (
          <LandCoverSection landCover={landCover} selected={highlight.classes} onSelectedChange={onClassesChange} />
        )}

        {/* AI の所見 */}
        {ai && (
          <section className="mt-6">
            <h3 className="font-bold">AI の所見</h3>
            <p className="num mt-0.5 text-xs text-ink-2">{ai.engine}（{ai.seconds.toFixed(1)} 秒）</p>
            <p className="mt-3 leading-relaxed">{ai.summary}</p>
            {ai.findings.length > 0 && (
              <ul className="mt-4 space-y-3">
                {ai.findings.map((f, i) => (
                  <li key={i} className="text-sm">
                    <p className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-bold">{f.name}</span>
                      <span className="text-xs text-ink-2">{f.where}</span>
                      <span className={`ml-auto text-xs ${f.confidence === '高' ? 'text-ink' : 'text-ink-2'}`}>確度 {f.confidence}</span>
                    </p>
                    {f.detail && <p className="mt-0.5 leading-relaxed text-ink-2">{f.detail}</p>}
                  </li>
                ))}
              </ul>
            )}
            {ai.caveats.length > 0 && (
              <>
                <h4 className="mt-5 text-sm font-bold">写真からは判断できないこと</h4>
                <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-2">
                  {ai.caveats.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              </>
            )}
          </section>
        )}

        {/* 追加の質問。AI の所見が出たときだけ（AI が使えないときは答えられない） */}
        {state.status === 'done' && ai && meta && landCover && (
          <AskSection key={meta.id} analysisId={meta.id} classes={landCover.classes} highlight={highlight} onShow={onShowHighlight} />
        )}

        {state.aiUnavailable && (
          <section className="mt-6 rounded-md border border-rule bg-white px-4 py-3 text-sm leading-relaxed">
            <h3 className="font-bold">AI の所見はありません</h3>
            <p className="mt-1 text-ink-2">{state.aiUnavailable}</p>
          </section>
        )}

        {meta && (
          <p className="mt-6 border-t border-rule pt-3 text-[11px] leading-relaxed text-ink-2">
            {meta.credit}
            {state.cached && '。この範囲は以前に解析した結果を表示しています。'}
          </p>
        )}
      </div>
    </aside>
    </>
  );
}
