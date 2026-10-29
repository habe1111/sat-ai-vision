'use client';
/**
 * 解析した範囲についての追加の質問。質問 API（NDJSON）を読んで、やり取りの一覧にする。
 * 一度に聞けるのは 1 つだけ（手元の VLM は 1 つずつしか答えられないため）。
 * 解析ごとに作り直す前提（呼ぶ側が key に解析の id を渡す）なので、解析が変わっても中身は消さない。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AskAnswer, AskEvent, AskTurn } from '@/lib/types';
import { readNdjson } from '@/lib/client/ndjson';

export type AskItem = {
  id: number;
  question: string;
  status: 'running' | 'done' | 'error';
  /** いま行っている段（追加の解析・AI の答え） */
  step: string | null;
  startedAt: number;
  answer: AskAnswer | null;
  error: string | null;
};

export function useAsk(analysisId: string, onAnswer: (a: AskAnswer) => void) {
  const [items, setItems] = useState<AskItem[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  // 答えが届いたときに呼ぶ関数は、最新のものを使う（呼び出し中に作り直されても古いものを呼ばない）
  const onAnswerRef = useRef(onAnswer);
  useEffect(() => {
    onAnswerRef.current = onAnswer;
  }, [onAnswer]);

  // パネルを閉じたら、答えを待っている質問も止める
  useEffect(() => () => abortRef.current?.abort(), []);

  const update = useCallback((id: number, patch: Partial<AskItem>) => {
    setItems((list) => list.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  }, []);

  const busy = items.some((it) => it.status === 'running');

  const ask = useCallback(async (question: string) => {
    const q = question.trim();
    if (!analysisId || !q || busy) return;
    const ac = new AbortController();
    abortRef.current = ac;
    const id = nextId.current++;
    // 前の答えを文脈として渡す（失敗したものは渡さない）
    const history: AskTurn[] = items
      .filter((it) => it.answer)
      .map((it) => ({ question: it.question, answer: it.answer!.text }));
    setItems((list) => [...list, { id, question: q, status: 'running', step: null, startedAt: Date.now(), answer: null, error: null }]);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: analysisId, question: q, history }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        update(id, { status: 'error', error: body?.error ?? `質問を送れませんでした（HTTP ${res.status}）。` });
        return;
      }
      let answered = false;
      await readNdjson<AskEvent>(res.body, (ev) => {
        if (ev.type === 'step') update(id, { step: ev.message });
        else if (ev.type === 'answer') {
          answered = true;
          update(id, { status: 'done', step: null, answer: ev.answer });
          onAnswerRef.current(ev.answer);
        } else {
          answered = true;
          update(id, { status: 'error', step: null, error: ev.message });
        }
      });
      if (!answered) update(id, { status: 'error', step: null, error: '答えが届きませんでした。もう一度質問してください。' });
    } catch (e) {
      if (ac.signal.aborted) return;
      update(id, { status: 'error', step: null, error: `サーバーとの通信が切れました（${e instanceof Error ? e.message : String(e)}）。` });
    }
  }, [analysisId, busy, items, update]);

  return { items, busy, ask };
}
