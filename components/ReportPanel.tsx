'use client';
/**
 * 解析結果のパネル（判読調書）。PC では右側、スマホでは下から出す。
 * 結果は届いた順に埋まっていく（写真 → 土地被覆 → AI の所見）。
 */
import type { AnalysisState, StageKey } from '@/lib/client/useAnalysis';
import { bboxCenter, bboxSizeMeters, formatArea, formatDms, formatLength } from '@/lib/geo';
import { IconAlert, IconCheck, IconClose } from '@/components/icons';

type Props = {
  state: AnalysisState;
  overlayOn: boolean;
  onOverlayChange: (on: boolean) => void;
  onClose: () => void;
  onRetry: () => void;
};

const STAGE_ORDER: StageKey[] = ['imagery', 'landcover', 'ai'];

export function ReportPanel({ state, overlayOn, onOverlayChange, onClose, onRetry }: Props) {
  const { meta, landCover, ai, bbox } = state;
  const running = state.status === 'running';
  const size = bbox ? bboxSizeMeters(bbox) : null;
  const center = bbox ? bboxCenter(bbox) : null;

  return (
    <aside
      aria-label="判読結果"
      className="fixed inset-x-0 bottom-0 z-20 flex max-h-[62dvh] flex-col rounded-t-xl bg-paper text-ink shadow-[var(--shadow)]
        pb-[env(safe-area-inset-bottom)]
        lg:inset-x-auto lg:bottom-3 lg:right-3 lg:top-3 lg:max-h-none lg:w-[416px] lg:rounded-lg"
    >
      <header className="flex items-start justify-between gap-3 border-b border-rule px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h2 className="text-lg font-bold">判読結果</h2>
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

        {/* 進み具合。終わった後も、どこで止まったか分かるように残す */}
        {(running || state.status === 'error') && (
          <ol className="mt-5 space-y-2.5" aria-live="polite">
            {STAGE_ORDER.map((k, i) => {
              const st = state.stages[k];
              return (
                <li key={k} className="flex items-center gap-3 text-sm">
                  <span
                    className={`num grid size-6 shrink-0 place-items-center rounded-full border text-xs
                      ${st.status === 'done' ? 'border-ink bg-ink text-paper' : ''}
                      ${st.status === 'running' ? 'border-survey text-survey' : ''}
                      ${st.status === 'failed' ? 'border-danger text-danger' : ''}
                      ${st.status === 'waiting' || st.status === 'skipped' ? 'border-rule text-ink-2' : ''}`}
                  >
                    {st.status === 'done' ? <IconCheck className="size-3.5" /> : i + 1}
                  </span>
                  <span className={`min-w-0 ${st.status === 'waiting' ? 'text-ink-2' : ''}`}>
                    {st.message}
                    {st.detail && <span className="block text-xs text-ink-2">{st.detail}</span>}
                  </span>
                  {st.status === 'running' && typeof st.progress === 'number' && (
                    <span className="num ml-auto text-xs text-ink-2">{Math.round(st.progress * 100)}%</span>
                  )}
                </li>
              );
            })}
          </ol>
        )}

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
              {landCover?.overlayUrl && overlayOn && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={landCover.overlayUrl} alt="" className="absolute inset-0 size-full object-cover opacity-60" />
              )}
            </div>
            {landCover?.overlayUrl && (
              <label className="mt-2 flex cursor-pointer items-center gap-2 text-sm">
                <input
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
          <section className="mt-6">
            <h3 className="font-bold">土地被覆の構成</h3>
            <p className="mt-0.5 text-xs text-ink-2">{landCover.methodLabel}</p>
            <div className="mt-3 flex h-3 overflow-hidden rounded-sm" role="img" aria-label="土地被覆の構成比">
              {landCover.classes.map((c) => (
                <span key={c.key} style={{ width: `${c.ratio * 100}%`, background: c.color }} />
              ))}
            </div>
            <table className="num mt-3 w-full text-sm">
              <tbody>
                {landCover.classes.map((c) => (
                  <tr key={c.key} className="border-b border-rule/60 last:border-0">
                    <td className="py-1.5">
                      <span className="mr-2 inline-block size-3 rounded-[2px] align-[-1px]" style={{ background: c.color }} />
                      {c.label}
                    </td>
                    <td className="py-1.5 text-right">{(c.ratio * 100).toFixed(1)}%</td>
                    <td className="py-1.5 pl-3 text-right text-ink-2">{formatArea(c.areaM2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {landCover.notes.length > 0 && (
              <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-2">
                {landCover.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
          </section>
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
  );
}
