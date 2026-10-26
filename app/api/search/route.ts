import type { NextRequest } from 'next/server';
import { SEARCH_ATTRIBUTION, searchPlaces } from '@/lib/server/search';
import type { SearchResponse } from '@/lib/types';

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? '';
  if (!q) return Response.json({ error: '地名やランドマークを入力してください。' } satisfies SearchResponse, { status: 400 });
  if (q.length > 100) return Response.json({ error: '検索語は 100 文字以内で入力してください。' } satisfies SearchResponse, { status: 400 });
  try {
    const places = await searchPlaces(q);
    return Response.json({ places, attribution: SEARCH_ATTRIBUTION } satisfies SearchResponse);
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) } satisfies SearchResponse, { status: 502 });
  }
}
