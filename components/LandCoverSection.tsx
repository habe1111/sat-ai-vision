'use client';
/**
 * 土地被覆の構成。区分を押すと、その色だけを写真と地図に残す（もう一度押すと外す。複数選べる）。
 * 何も選んでいないときは全部の色を出す。
 */
import { useRef } from 'react';
import type { LandCover } from '@/lib/types';
import { formatArea } from '@/lib/geo';
import { IconCheck } from '@/components/icons';

type Props = {
  landCover: LandCover;
  /** 残している区分（空なら全部） */
  selected: string[];
  onSelectedChange: (keys: string[]) => void;
};

export function LandCoverSection({ landCover, selected, onSelectedChange }: Props) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const filtering = selected.length > 0;
  // 重ね絵が無いと色を出し分けられないので、押せなくする
  const selectable = Boolean(landCover.overlayUrl);
  const toggle = (key: string) =>
    onSelectedChange(selected.includes(key) ? selected.filter((k) => k !== key) : [...selected, key]);

  return (
    <section className="mt-6" aria-labelledby="landcover-heading">
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="landcover-heading" ref={headingRef} tabIndex={-1} className="font-bold">土地被覆の構成</h3>
        {filtering && (
          <button
            type="button"
            onClick={() => {
              // このボタンは押すと消えるので、フォーカスを見出しへ移す
              headingRef.current?.focus();
              onSelectedChange([]);
            }}
            className="-my-2 shrink-0 rounded-md px-2 py-2 text-sm font-bold text-survey-ink underline underline-offset-4 hover:bg-paper-2"
          >
            すべての色を表示
          </button>
        )}
      </div>
      <p className="mt-0.5 text-xs text-ink-2">{landCover.methodLabel}</p>
      <div className="mt-3 flex h-3 overflow-hidden rounded-sm" role="img" aria-label="土地被覆の構成比">
        {landCover.classes.map((c) => (
          <span
            key={c.key}
            className="transition-opacity duration-200"
            style={{ width: `${c.ratio * 100}%`, background: c.color, opacity: filtering && !selected.includes(c.key) ? 0.25 : 1 }}
          />
        ))}
      </div>
      {selectable && (
        <p id="landcover-hint" className="mt-3 text-xs text-ink-2">
          区分を押すと、その色だけを写真と地図に表示します（複数選べます）。
        </p>
      )}
      <ul className="num mt-1.5 text-sm" aria-describedby={selectable ? 'landcover-hint' : undefined}>
        {landCover.classes.map((c) => {
          const on = selected.includes(c.key);
          const dim = filtering && !on;
          const cells = (
            <>
              <span
                aria-hidden
                className={`grid size-4 shrink-0 place-items-center rounded-[3px] text-white transition-opacity ${dim ? 'opacity-35' : ''}`}
                style={{ background: c.color }}
              >
                {on && <IconCheck className="size-3 drop-shadow-[0_0_1px_rgb(0_0_0/0.9)]" />}
              </span>
              <span className={`min-w-0 flex-1 ${dim ? 'text-ink-2' : ''}`}>{c.label}</span>
              <span className={`text-right ${dim ? 'text-ink-2' : ''}`}>{(c.ratio * 100).toFixed(1)}%</span>
              <span className="w-[5.5rem] shrink-0 whitespace-nowrap text-right text-ink-2">{formatArea(c.areaM2)}</span>
            </>
          );
          return (
            <li key={c.key} className="border-b border-rule/60 last:border-0">
              {selectable ? (
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(c.key)}
                  className={`-mx-1.5 flex min-h-10 w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left
                    hover:bg-paper-2 lg:min-h-9 ${on ? 'bg-paper-2' : ''}`}
                >
                  {cells}
                </button>
              ) : (
                <div className="flex items-center gap-2.5 py-1.5">{cells}</div>
              )}
            </li>
          );
        })}
      </ul>
      {landCover.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs leading-relaxed text-ink-2">
          {landCover.notes.map((n) => <li key={n}>{n}</li>)}
        </ul>
      )}
    </section>
  );
}
