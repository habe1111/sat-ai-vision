import type { AskEvent, AskTurn } from '@/lib/types';
import { AskError, answerQuestion } from '@/lib/server/ask';

/** 質問の長さの上限（文字） */
const MAX_QUESTION = 300;

function isTurn(v: unknown): v is AskTurn {
  const t = v as Partial<AskTurn> | null;
  return typeof t?.question === 'string' && typeof t.answer === 'string';
}

/**
 * 解析した範囲についての追加の質問に答える。追加の解析（区画ごとの集計・拡大）と AI の答えを
 * NDJSON（1 行 1 イベント）で返す。手元の VLM は答えに数十秒かかるので、何をしているかを先に出す。
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const id = body?.id;
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (typeof id !== 'string' || !/^[0-9a-f]{20}$/.test(id)) {
    return Response.json({ error: '質問する解析が正しくありません。範囲を解析し直してください。' }, { status: 400 });
  }
  if (!question || question.length > MAX_QUESTION) {
    return Response.json({ error: `質問は 1〜${MAX_QUESTION} 文字で入力してください。` }, { status: 400 });
  }
  const history: AskTurn[] = Array.isArray(body?.history) ? body.history.filter(isTurn).slice(-8) : [];

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: AskEvent) => {
        if (!request.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
      };
      try {
        await answerQuestion(id, question, history, emit, request.signal);
      } catch (e) {
        // 画面側が中止した（閉じる・範囲の選び直し）ときは失敗として扱わない
        if (request.signal.aborted) return;
        const message = e instanceof AskError
          ? e.message
          : `答えを作れませんでした（${e instanceof Error ? e.message : String(e)}）。`;
        if (!(e instanceof AskError)) console.error('[ask]', e);
        emit({ type: 'error', message });
      } finally {
        try { controller.close(); } catch { /* 画面側が先に切断した */ }
      }
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
