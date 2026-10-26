'use client';
/**
 * 画面下中央の操作バー。範囲選択の「始める → ドラッグ → 解析する」を 1 か所で案内する。
 */
import type { ZoomChoice } from '@/lib/selection';
import { IconFrame } from '@/components/icons';

type Props = {
  mode: 'idle' | 'selecting' | 'selected' | 'report';
  choice: ZoomChoice | null;
  disabled: boolean;
  hiddenOnMobile: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onAnalyze: () => void;
};

const primary = 'rounded-md bg-survey px-4 py-2.5 text-sm font-bold text-white hover:bg-survey-ink disabled:opacity-50';
const secondary = 'rounded-md px-3 py-2.5 text-sm font-bold text-ink hover:bg-paper-2';

export function SelectBar({ mode, choice, disabled, hiddenOnMobile, onBegin, onCancel, onAnalyze }: Props) {
  const wrap = `pointer-events-none fixed inset-x-0 z-10 flex justify-center px-3
    bottom-[calc(max(12px,env(safe-area-inset-bottom))+28px)]
    lg:[.has-report_&]:right-[428px] ${hiddenOnMobile ? 'max-lg:hidden' : ''}`;
  const card = 'pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg bg-paper px-3 py-2 text-ink shadow-[var(--shadow)]';

  if (mode === 'idle' || mode === 'report') {
    return (
      <div className={wrap}>
        <div className={card}>
          <button type="button" disabled={disabled} onClick={onBegin} className={`${primary} flex items-center gap-2`}>
            <IconFrame className="size-5" />
            {mode === 'report' ? '別の範囲を選ぶ' : '範囲を選んで解析'}
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'selecting') {
    return (
      <div className={wrap}>
        <div className={card} role="status">
          <p className="px-1 text-sm">解析したい範囲を、地図の上でドラッグしてください</p>
          <button type="button" onClick={onCancel} className={secondary}>やめる</button>
        </div>
      </div>
    );
  }

  return (
    <div className={wrap}>
      <div className={card}>
        {choice && !choice.ok && <p className="px-1 text-sm text-danger" role="alert">{choice.reason}</p>}
        {choice?.ok && (
          <p className="num px-1 text-sm">
            約 {choice.metersPerPixel.toFixed(2)} m/px で解析します
          </p>
        )}
        <div className="flex gap-1">
          <button type="button" onClick={onBegin} className={secondary}>選び直す</button>
          <button type="button" onClick={onAnalyze} disabled={!choice?.ok} className={primary}>この範囲を解析</button>
        </div>
      </div>
    </div>
  );
}
