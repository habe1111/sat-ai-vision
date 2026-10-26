'use client';
/**
 * 解析 API（NDJSON のストリーム）を読んで、画面の状態にする。
 * 取得・土地被覆・AI の順に結果が届くので、届いたものから順に表示できる。
 */
import { useCallback, useRef, useState } from 'react';
import type { BBox } from '@/lib/geo';
import type { AiReport, AnalysisEvent, AnalysisMeta, LandCover } from '@/lib/types';

export type StageKey = 'imagery' | 'landcover' | 'ai';
export type StageState = { status: 'waiting' | 'running' | 'done' | 'skipped' | 'failed'; message: string; progress?: number; detail?: string; startedAt?: number };

export type AnalysisState = {
  status: 'idle' | 'running' | 'done' | 'error';
  bbox: BBox | null;
  stages: Record<StageKey, StageState>;
  meta: AnalysisMeta | null;
  landCover: LandCover | null;
  ai: AiReport | null;
  aiUnavailable: string | null;
  error: string | null;
  cached: boolean;
};

const STAGES_INITIAL: Record<StageKey, StageState> = {
  imagery: { status: 'waiting', message: '空中写真を取得' },
  landcover: { status: 'waiting', message: '土地被覆を判定' },
  ai: { status: 'waiting', message: 'AI が写真を判読' },
};

const INITIAL: AnalysisState = {
  status: 'idle', bbox: null, stages: STAGES_INITIAL, meta: null, landCover: null, ai: null,
  aiUnavailable: null, error: null, cached: false,
};

const ORDER: StageKey[] = ['imagery', 'landcover', 'ai'];

export function useAnalysis() {
  const [state, setState] = useState<AnalysisState>(INITIAL);
  const abortRef = useRef<AbortController | null>(null);

  const apply = useCallback((ev: AnalysisEvent) => {
    setState((s) => {
      switch (ev.type) {
        case 'stage': {
          // 新しい段に入ったら、それより前の段は終わったものとして扱う
          const stages = { ...s.stages };
          const idx = ORDER.indexOf(ev.stage);
          ORDER.forEach((k, i) => {
            if (i < idx && stages[k].status === 'running') stages[k] = { ...stages[k], status: 'done' };
          });
          // 同じ段の進み具合の更新では、始まった時刻を引き継ぐ
          const startedAt = s.stages[ev.stage].status === 'running' ? s.stages[ev.stage].startedAt : Date.now();
          stages[ev.stage] = { status: 'running', message: ev.message, progress: ev.progress, detail: ev.detail, startedAt };
          return { ...s, stages };
        }
        case 'meta':
          return { ...s, meta: ev.meta, stages: { ...s.stages, imagery: { status: 'done', message: '空中写真を取得' } } };
        case 'landcover':
          return { ...s, landCover: ev.landCover, stages: { ...s.stages, landcover: { status: 'done', message: '土地被覆を判定' } } };
        case 'ai':
          return { ...s, ai: ev.ai, stages: { ...s.stages, ai: { status: 'done', message: 'AI が写真を判読' } } };
        case 'ai-unavailable':
          return { ...s, aiUnavailable: ev.message, stages: { ...s.stages, ai: { status: 'skipped', message: 'AI の判読は行えませんでした' } } };
        case 'done':
          return { ...s, status: 'done', cached: ev.cached };
        case 'error': {
          const stages = { ...s.stages };
          for (const k of ORDER) if (stages[k].status === 'running') stages[k] = { ...stages[k], status: 'failed' };
          return { ...s, status: 'error', error: ev.message, stages };
        }
      }
    });
  }, []);

  const start = useCallback(async (bbox: BBox) => {
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setState({ ...INITIAL, status: 'running', bbox });
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bbox }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => null);
        apply({ type: 'error', message: body?.error ?? `解析を開始できませんでした（HTTP ${res.status}）。` });
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) apply(JSON.parse(line) as AnalysisEvent);
        }
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      apply({ type: 'error', message: `サーバーとの通信が切れました（${e instanceof Error ? e.message : String(e)}）。` });
    }
  }, [apply]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setState(INITIAL);
  }, []);

  return { state, start, reset };
}
