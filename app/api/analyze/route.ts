import { isValidBBox } from '@/lib/geo';
import type { AnalysisEvent } from '@/lib/types';
import { runAnalysis } from '@/lib/server/analysis';
import { SelectionError } from '@/lib/server/tiles';

/**
 * 範囲を受け取って解析し、進み具合と結果を NDJSON（1 行 1 イベント）で返す。
 * 写真の取得と AI の判読には数十秒かかるので、届いたものから画面に出せるようにしている。
 */
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const bbox = body?.bbox;
  if (!isValidBBox(bbox)) {
    return Response.json({ error: '解析する範囲が正しくありません。地図の上で範囲を選び直してください。' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (ev: AnalysisEvent) => {
        if (!request.signal.aborted) controller.enqueue(encoder.encode(`${JSON.stringify(ev)}\n`));
      };
      try {
        await runAnalysis(bbox, emit, request.signal);
      } catch (e) {
        const message = e instanceof SelectionError
          ? e.message
          : `解析に失敗しました（${e instanceof Error ? e.message : String(e)}）。`;
        if (!(e instanceof SelectionError)) console.error('[analyze]', e);
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
