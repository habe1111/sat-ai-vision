'use client';
/**
 * 場所の検索パネル。入力は 1 つだけ（地名・ランドマーク）。
 *
 * 検索は確定したとき（Enter・検索ボタン）だけ行う。入力のたびに候補を出すのは
 * Nominatim の利用ポリシーで禁じられているため。
 * 結果を選ぶと地図がそこへ移り、URL（#map=…）がその場所を指すディープリンクになる。
 */
import { useEffect, useRef, useState } from 'react';
import type { Place, SearchResponse } from '@/lib/types';
import { IconClose, IconPin, IconSearch } from '@/components/icons';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (place: Place) => void;
  selectedId: string | null;
  initialQuery: string;
};

export function SearchPanel({ open, onOpenChange, onSelect, selectedId, initialQuery }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [result, setResult] = useState<{ q: string; places: Place[]; attribution: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const prevOpen = useRef(open);
  const ranInitial = useRef(false);

  useEffect(() => {
    const wasOpen = prevOpen.current;
    prevOpen.current = open;
    if (open) {
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!wasOpen) return;
    // 閉じたとき、フォーカスがパネルの中にあった（隠れて body に落ちる）なら、開くタブへ戻す
    const active = document.activeElement;
    if (!active || active === document.body || panelRef.current?.contains(active)) {
      toggleRef.current?.focus({ preventScroll: true });
    }
  }, [open]);

  async function search(q: string) {
    const term = q.trim();
    if (!term) {
      setError('地名やランドマークを入力してください。');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`);
      const body = (await res.json()) as SearchResponse;
      if ('error' in body) {
        setError(body.error);
        setResult(null);
      } else {
        setResult({ q: term, ...body });
      }
      // 検索語も URL に残し、共有したときに同じ結果を開けるようにする
      const url = new URL(window.location.href);
      url.searchParams.set('q', term);
      history.replaceState(history.state, '', url);
    } catch {
      setError('検索できませんでした。ネットワークの接続を確かめてください。');
    } finally {
      setLoading(false);
    }
  }

  // URL に ?q= があれば、開いた時点で検索しておく
  useEffect(() => {
    if (ranInitial.current || !initialQuery) return;
    ranInitial.current = true;
    void search(initialQuery);
  }, [initialQuery]);

  return (
    <>
      {/* 地図の左端のタブ。開いているときはパネルの右肩に付いて「閉じる」になる */}
      <button
        ref={toggleRef}
        type="button"
        onClick={() => onOpenChange(!open)}
        aria-expanded={open}
        aria-controls="search-panel"
        className={`fixed z-30 flex items-center gap-1.5 bg-paper text-ink shadow-[var(--shadow)] transition-[left] duration-200 ease-out
          top-[max(12px,env(safe-area-inset-top))] rounded-r-md py-3 pl-2 pr-2 [writing-mode:vertical-rl]
          ${open ? 'max-sm:hidden sm:left-[360px]' : 'left-0'}`}
      >
        {open ? <IconClose className="size-4" /> : <IconSearch className="size-4" />}
        <span className="text-sm font-bold tracking-[0.2em]">{open ? '閉じる' : '場所を検索'}</span>
      </button>

      <section
        ref={panelRef}
        id="search-panel"
        aria-label="場所の検索"
        hidden={!open}
        className="fixed left-0 top-0 z-30 flex max-h-dvh w-full flex-col bg-paper text-ink shadow-[var(--shadow)]
          pt-[max(12px,env(safe-area-inset-top))] sm:w-[360px] sm:rounded-br-lg"
      >
        {/* 狭い画面ではパネルが全幅になるので、閉じるボタンはここに置く（地図のボタンと重ねない） */}
        <div className="flex items-center justify-between px-4 pb-2 sm:hidden">
          <h2 className="font-bold">場所を検索</h2>
          <button type="button" onClick={() => onOpenChange(false)} className="-mr-2 rounded-md p-2 hover:bg-paper-2" aria-label="検索を閉じる">
            <IconClose className="size-5" />
          </button>
        </div>
        <form
          role="search"
          className="flex gap-2 border-b border-rule px-4 pb-4 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            void search(query);
          }}
        >
          <label className="sr-only" htmlFor="place-query">地名やランドマーク</label>
          <input
            ref={inputRef}
            id="place-query"
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && onOpenChange(false)}
            placeholder="地名やランドマーク（例：姫路城）"
            className="min-w-0 flex-1 rounded-md border border-rule bg-white px-3 py-2.5 text-base text-ink placeholder:text-ink-2 focus:border-ink focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading}
            className="shrink-0 rounded-md bg-ink px-4 text-sm font-bold text-paper disabled:opacity-60"
          >
            {loading ? '検索中' : '検索'}
          </button>
        </form>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-live="polite">
          {error && <p className="px-4 py-4 text-sm text-danger">{error}</p>}
          {!error && !result && (
            <p className="px-4 py-4 text-sm leading-relaxed text-ink-2">
              探したい場所の名前を入れて、Enter か「検索」を押してください。空中写真があるのは日本国内です。
            </p>
          )}
          {result && result.places.length === 0 && (
            <p className="px-4 py-4 text-sm leading-relaxed text-ink-2">
              「{result.q}」に当たる場所は見つかりませんでした。正式な名前や、市区町村名を足して検索してみてください。
            </p>
          )}
          {result && result.places.length > 0 && (
            <>
              <p className="px-4 pb-1 pt-3 text-xs text-ink-2">
                「{result.q}」の検索結果 <span className="num">{result.places.length}</span> 件
              </p>
              <ul>
                {result.places.map((p) => {
                  const selected = p.id === selectedId;
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        onClick={() => onSelect(p)}
                        aria-current={selected || undefined}
                        className={`flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-paper-2 ${selected ? 'bg-paper-2' : ''}`}
                      >
                        <IconPin className={`mt-0.5 size-5 shrink-0 ${selected ? 'text-survey' : 'text-ink-2'}`} />
                        <span className="min-w-0">
                          <span className="flex flex-wrap items-baseline gap-x-2">
                            <span className="font-bold">{p.name}</span>
                            <span className="text-xs text-ink-2">{p.kind}</span>
                          </span>
                          {p.address && <span className="mt-0.5 block text-xs leading-relaxed text-ink-2">{p.address}</span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <p className="border-t border-rule px-4 py-3 text-[11px] text-ink-2">{result.attribution}</p>
            </>
          )}
        </div>
      </section>
    </>
  );
}
