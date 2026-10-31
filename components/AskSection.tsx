'use client';
/**
 * 解析が終わった後の追加の質問。AI は解析結果（と必要なら追加の解析）をもとに文章で答え、
 * 関係する土地被覆の区分と区画を返す。届いた答えは写真と地図にすぐ示し、前の答えも押せば示し直せる。
 *
 * 解析ごとに作り直す（MapApp で key に解析の id を渡す）ので、前の範囲のやり取りは残らない。
 */
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { REGION_LABEL } from '@/lib/regions';
import type { AskAnswer, Highlight, LandCoverClass } from '@/lib/types';
import { useAsk } from '@/lib/client/useAsk';
import { Elapsed } from '@/components/StageTimeline';
import { IconAlert } from '@/components/icons';

type Props = {
  analysisId: string;
  classes: LandCoverClass[];
  /** いま写真と地図に示しているもの（答えのボタンを「表示中」にするため） */
  highlight: Highlight;
  onShow: (h: Highlight) => void;
};

const MAX_QUESTION = 300;

/** 何を聞けばよいか迷わないための例。押すとそのまま質問する */
function suggestions(classes: LandCoverClass[]): string[] {
  const has = (k: string) => classes.some((c) => c.key === k);
  const list = ['建物が多いのはどのあたりですか？'];
  if (has('water')) list.push('水辺はどこにありますか？');
  else if (has('forest') || has('grass') || has('vegetation')) list.push('緑が多いのはどこですか？');
  list.push('右下には何がありますか？');
  return list;
}

const sameHighlight = (a: Highlight, b: Highlight) =>
  a.region === b.region && a.objects === b.objects
  && a.classes.length === b.classes.length && a.classes.every((k) => b.classes.includes(k));

function AnswerBody({ answer, classes, highlight, onShow }: {
  answer: AskAnswer;
  classes: LandCoverClass[];
  highlight: Highlight;
  onShow: (h: Highlight) => void;
}) {
  const own: Highlight = { classes: answer.classes, region: answer.region, objects: answer.objects };
  const showable = own.classes.length > 0 || own.region !== null || own.objects !== null;
  const shown = showable && sameHighlight(own, highlight);
  const byKey = new Map(classes.map((c) => [c.key, c]));
  return (
    <div className="mt-2">
      <p className="leading-relaxed">{answer.text}</p>
      {showable && (
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {own.classes.map((k) => {
            const c = byKey.get(k);
            return c ? (
              <span key={k} className="inline-flex items-center gap-1.5 rounded-full border border-rule bg-white px-2 py-0.5 text-xs">
                <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: c.color }} />
                {c.label}
              </span>
            ) : null;
          })}
          {own.objects && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#b38f00]/60 bg-white px-2 py-0.5 text-xs">
              <span aria-hidden className="size-2.5 rounded-[2px] border-[1.5px] border-[#b38f00] bg-[#ffd400]/50" />
              <span className="num">{own.objects.label} {own.objects.count.toLocaleString('ja-JP')} {own.objects.unit}（{own.objects.scope}）</span>
            </span>
          )}
          {own.region && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-survey/50 bg-white px-2 py-0.5 text-xs text-survey-ink">
              <span aria-hidden className="size-2.5 rounded-[2px] border-[1.5px] border-survey" />
              {REGION_LABEL[own.region]}
            </span>
          )}
          {/* 押した後も消したり disabled にしたりしない（キーボードのフォーカスを失わないため）。表示中は aria-pressed で示す */}
          <button
            type="button"
            onClick={() => onShow(own)}
            aria-pressed={shown}
            className={`ml-auto min-h-8 rounded-md px-2 py-1.5 text-xs font-bold hover:bg-paper-2
              ${shown ? 'text-ink-2' : 'text-survey-ink underline underline-offset-4'}`}
          >
            {shown ? '写真と地図に表示中' : '写真と地図に表示'}
          </button>
        </div>
      )}
      {answer.objects && (
        <p className="mt-2 text-xs leading-relaxed text-ink-2">
          {answer.objects.summary && <span className="num block font-bold text-ink">{answer.objects.summary}</span>}
          {answer.objects.breakdown.length > 0 && `${answer.objects.breakdown.map((t) => `${t.label} ${t.count}`).join('・')}。`}
          {answer.objects.note}
          <span className="block">出典：{answer.objects.source}</span>
        </p>
      )}
      {answer.checks.length > 0 && (
        <ul className="mt-2.5 space-y-0.5 text-xs leading-relaxed text-ink-2">
          {answer.checks.map((c) => <li key={c}>確かめたこと：{c}</li>)}
        </ul>
      )}
      <p className="num mt-1 text-xs text-ink-2">{answer.engine}（{answer.seconds.toFixed(1)} 秒）</p>
    </div>
  );
}

export function AskSection({ analysisId, classes, highlight, onShow }: Props) {
  // 示すものがある答えのときだけ写真と地図を替える（無関係な質問で、利用者の絞り込みを消さない）
  const { items, busy, ask } = useAsk(analysisId, (a) => {
    if (a.classes.length || a.region || a.objects) onShow({ classes: a.classes, region: a.region, objects: a.objects });
  });
  const [text, setText] = useState('');
  const listRef = useRef<HTMLOListElement>(null);

  // 質問を送ったとき・答えが届いたときに、その項目が見えるようにする
  const lastStatus = items.length ? `${items.length}:${items[items.length - 1].status}` : '';
  useEffect(() => {
    if (!lastStatus) return;
    listRef.current?.lastElementChild?.scrollIntoView({ block: 'nearest' });
  }, [lastStatus]);

  // 入力欄から送ったときだけ欄を空にする（例のボタンでは、書きかけの質問を消さない）
  const sendInput = () => {
    if (busy || !text.trim()) return;
    void ask(text);
    setText('');
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    sendInput();
  };
  // 変換の確定（IME の Enter）では送らない
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    sendInput();
  };

  const last = items[items.length - 1];
  const announce = !last ? '' : last.status === 'running' ? '質問を送りました。答えを作っています。'
    : last.status === 'done' ? '答えが届きました。' : '';

  return (
    <section className="mt-6 border-t border-rule pt-5" aria-labelledby="ask-heading">
      {/* スマホで検索を開くとパネルごと隠れるので、読み上げはパネルの外（body）に置く */}
      {createPortal(<p role="status" className="sr-only">{announce}</p>, document.body)}
      <h3 id="ask-heading" className="font-bold">AI に質問する</h3>
      <p className="mt-0.5 text-xs leading-relaxed text-ink-2">
        解析の結果をもとに答え、関係する区分や区画を写真と地図に示します。
      </p>

      {items.length > 0 && (
        <ol ref={listRef} className="mt-4 space-y-5">
          {items.map((it) => (
            <li key={it.id} className="scroll-mb-4 text-sm">
              <p className="ml-auto w-fit max-w-[85%] rounded-lg rounded-br-sm bg-ink px-3 py-2 text-paper">
                <span className="sr-only">質問：</span>{it.question}
              </p>
              {it.status === 'running' && (
                <p className="mt-2 flex items-center gap-2 text-ink-2">
                  <span aria-hidden className="size-3.5 shrink-0 rounded-full border-2 border-rule border-t-survey motion-safe:animate-spin" />
                  <span className="min-w-0">{it.step ?? '質問を送っています'}</span>
                  <Elapsed since={it.startedAt} />
                </p>
              )}
              {it.status === 'error' && (
                <p role="alert" className="mt-2 flex gap-2 rounded-md border border-danger/40 bg-white px-3 py-2">
                  <IconAlert className="mt-0.5 size-4 shrink-0 text-danger" />
                  <span>{it.error}</span>
                </p>
              )}
              {it.answer && <AnswerBody answer={it.answer} classes={classes} highlight={highlight} onShow={onShow} />}
            </li>
          ))}
        </ol>
      )}

      {items.length === 0 && (
        <div className="mt-3 flex flex-wrap gap-2">
          {suggestions(classes).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => void ask(s)}
              disabled={busy}
              className="rounded-full border border-rule bg-white px-3 py-1.5 text-left text-xs hover:border-ink-2"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4 flex items-end gap-2">
        <label htmlFor="ask-input" className="sr-only">質問</label>
        <textarea
          id="ask-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          enterKeyHint="send"
          maxLength={MAX_QUESTION}
          placeholder="例：駐車場はどこにありますか？"
          className="min-h-11 min-w-0 flex-1 resize-none rounded-md border border-rule bg-white px-3 py-2 text-base leading-snug
            placeholder:text-ink-2/70 focus:border-ink-2 lg:text-sm"
        />
        <button
          type="submit"
          disabled={busy || !text.trim()}
          className="min-h-11 shrink-0 rounded-md bg-survey px-4 text-sm font-bold text-white hover:bg-survey-ink
            disabled:cursor-not-allowed disabled:bg-rule disabled:text-ink-2"
        >
          {busy ? '回答中' : '質問'}
        </button>
      </form>
      {/* ソフトキーボードには Shift + Enter が無いので、案内は PC だけに出す */}
      <p className="mt-1.5 hidden text-[11px] text-ink-2 lg:block">Enter で送信、Shift + Enter で改行</p>
    </section>
  );
}
