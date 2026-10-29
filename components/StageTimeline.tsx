'use client';
/**
 * 解析の流れ（① 写真の取得 → ② 土地被覆 → ③ AI の判読）を、線でつないだタイムラインで見せる。
 * 実行中は進み具合と経過秒数を、終わった後は段ごとにかかった時間を残す。
 * 読み上げは ReportPanel の role="status" に任せ、ここは live region にしない。
 */
import { useEffect, useState } from 'react';
import type { AnalysisState, StageKey, StageState } from '@/lib/client/useAnalysis';
import { IconCheck } from '@/components/icons';

export const STAGE_ORDER: StageKey[] = ['imagery', 'landcover', 'ai'];

const STATUS_TEXT: Partial<Record<StageState['status'], string>> = {
  running: '（実行中）',
  done: '（完了）',
  failed: '（失敗）',
  skipped: '（行えず）',
};

/**
 * 動いている段の経過秒数。手元の VLM は 1 枚に数十秒かかるので、止まっていないことを示す
 */
export function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span aria-hidden className="num ml-auto shrink-0 text-xs text-ink-2">{Math.max(0, Math.floor((now - since) / 1000))} 秒</span>;
}

/** 段の右端に出す、かかった時間など */
function Trailing({ st }: { st: StageState }) {
  if (st.status === 'running') {
    if (typeof st.progress === 'number') {
      return <span aria-hidden className="num ml-auto shrink-0 text-xs text-ink-2">{Math.round(st.progress * 100)}%</span>;
    }
    return st.startedAt ? <Elapsed since={st.startedAt} /> : null;
  }
  if (st.status === 'done') {
    const text = st.startedAt && st.finishedAt
      ? `${((st.finishedAt - st.startedAt) / 1000).toFixed(1)} 秒`
      : '前回の結果';
    return <span className="num ml-auto shrink-0 text-xs text-ink-2">{text}</span>;
  }
  return null;
}

export function StageTimeline({ state }: { state: AnalysisState }) {
  return (
    <section className="mt-5" aria-labelledby="timeline-heading">
      <h3 id="timeline-heading" className="sr-only">解析の流れ</h3>
      <ol>
        {STAGE_ORDER.map((k, i) => {
          const st = state.stages[k];
          const last = i === STAGE_ORDER.length - 1;
          return (
            <li key={k} className={`relative flex gap-3 text-sm ${last ? '' : 'pb-3.5'}`}>
              {/* 次の段へつなぐ線。この段が終わると濃くなる */}
              {!last && (
                <span
                  aria-hidden
                  className={`absolute bottom-0 left-3 top-6 w-0.5 -translate-x-1/2 transition-colors duration-300
                    ${st.status === 'done' ? 'bg-ink' : 'bg-rule'}`}
                />
              )}
              <span
                className={`num relative grid size-6 shrink-0 place-items-center rounded-full border text-xs
                  ${st.status === 'done' ? 'border-ink bg-ink text-paper' : 'bg-paper'}
                  ${st.status === 'running' ? 'border-survey text-survey' : ''}
                  ${st.status === 'failed' ? 'border-danger text-danger' : ''}
                  ${st.status === 'waiting' || st.status === 'skipped' ? 'border-rule text-ink-2' : ''}`}
              >
                {st.status === 'running' && (
                  <span aria-hidden className="absolute inset-[-4px] rounded-full border border-survey/40 motion-safe:animate-ping" />
                )}
                {st.status === 'done' ? <IconCheck className="size-3.5" /> : i + 1}
              </span>
              <div className="flex min-w-0 flex-1 flex-col pt-0.5">
                <div className="flex items-baseline gap-3">
                  <span className={`min-w-0 ${st.status === 'waiting' || st.status === 'skipped' ? 'text-ink-2' : ''}`}>
                    {st.message}
                    {STATUS_TEXT[st.status] && <span className="sr-only">{STATUS_TEXT[st.status]}</span>}
                  </span>
                  <Trailing st={st} />
                </div>
                {st.detail && <span className="block text-xs text-ink-2">{st.detail}</span>}
                {st.status === 'running' && typeof st.progress === 'number' && (
                  <span aria-hidden className="mt-1.5 block h-1 overflow-hidden rounded-full bg-paper-2">
                    <span className="block h-full bg-survey transition-[width] duration-300" style={{ width: `${st.progress * 100}%` }} />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
