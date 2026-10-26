'use client';
/**
 * 画面下中央の操作バー。範囲選択の「始める → ドラッグ → 解析する」を 1 か所で案内する。
 */
import { useEffect, useRef } from 'react';
import type { ZoomChoice } from '@/lib/selection';
import { IconFrame } from '@/components/icons';

type Props = {
  mode: 'idle' | 'selecting' | 'selected' | 'report';
  choice: ZoomChoice | null;
  disabled: boolean;
  hiddenOnMobile: boolean;
  /** 検索パネル（sm 以上は左に幅 360px）を開いているか。開いている間は、その右の残りに寄せる */
  searchOpen: boolean;
  onBegin: () => void;
  /** いま表示している範囲を選ぶ（ドラッグできない人のための代わり） */
  onSelectView: () => void;
  onCancel: () => void;
  onAnalyze: () => void;
};

const primary = 'rounded-md bg-survey px-4 py-2.5 text-sm font-bold text-white hover:bg-survey-ink disabled:opacity-50';
const secondary = 'rounded-md px-3 py-2.5 text-sm font-bold text-ink hover:bg-paper-2';

export function SelectBar({ mode, choice, disabled, hiddenOnMobile, searchOpen, onBegin, onSelectView, onCancel, onAnalyze }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const prevMode = useRef(mode);
  const moveFocus = useRef(false);

  // 段が進むと押したボタンが消えるので、フォーカスを次に押すボタンへ移す（body に落とさない）。
  // 結果パネルを開いたときは、パネルの側が見出しへフォーカスを移す
  useEffect(() => {
    if (prevMode.current === mode) return;
    prevMode.current = mode;
    const lost = !document.activeElement || document.activeElement === document.body;
    const wanted = moveFocus.current || lost;
    moveFocus.current = false;
    if (mode === 'report' || !wanted) return;
    const target =
      wrapRef.current?.querySelector<HTMLButtonElement>('button[data-autofocus]:not(:disabled)') ??
      wrapRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    target?.focus({ preventScroll: true });
  }, [mode]);

  const act = (fn: () => void) => () => {
    moveFocus.current = true;
    fn();
  };

  const wrap = `pointer-events-none fixed inset-x-0 z-10 flex justify-center px-3
    bottom-[calc(max(12px,env(safe-area-inset-bottom))+28px)]
    lg:[.has-report_&]:right-[428px] ${searchOpen ? 'sm:left-[384px]' : ''} ${hiddenOnMobile ? 'max-lg:hidden' : ''}`;
  const card = 'pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-2 rounded-lg bg-paper px-3 py-2 text-ink shadow-[var(--shadow)]';

  if (mode === 'idle' || mode === 'report') {
    return (
      <div ref={wrapRef} className={wrap}>
        <div className={card}>
          <button type="button" disabled={disabled} onClick={act(onBegin)} className={`${primary} flex items-center gap-2`}>
            <IconFrame className="size-5" />
            {mode === 'report' ? '別の範囲を選ぶ' : '範囲を選んで解析'}
          </button>
        </div>
      </div>
    );
  }

  if (mode === 'selecting') {
    return (
      <div ref={wrapRef} className={wrap}>
        <div className={card}>
          <p className="px-1 text-sm" role="status">解析したい範囲を、地図の上でドラッグしてください</p>
          <div className="flex gap-1">
            <button type="button" onClick={act(onCancel)} className={secondary}>やめる</button>
            <button type="button" onClick={act(onSelectView)} data-autofocus className={secondary}>
              いま表示している範囲を選ぶ
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={wrapRef} className={wrap}>
      <div className={card}>
        {choice && !choice.ok && <p className="px-1 text-sm text-danger" role="alert">{choice.reason}</p>}
        {choice?.ok && (
          <p className="num px-1 text-sm">
            約 {choice.metersPerPixel.toFixed(2)} m/px で解析します
          </p>
        )}
        <div className="flex gap-1">
          <button type="button" onClick={act(onBegin)} className={secondary}>選び直す</button>
          <button type="button" onClick={act(onAnalyze)} disabled={!choice?.ok} data-autofocus className={primary}>この範囲を解析</button>
        </div>
      </div>
    </div>
  );
}
