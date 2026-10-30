import { DEV_ONLY, notFound } from '@/lib/server/annotate/devOnly';
import { listChips, prepareSite, readSites } from '@/lib/server/annotate/store';

/** 地点とチップの一覧 */
export async function GET() {
  if (!DEV_ONLY) return notFound();
  const [sites, { chips, broken }] = await Promise.all([readSites(), listChips()]);
  return Response.json({ sites, chips, broken }, { headers: { 'Cache-Control': 'no-store' } });
}

/**
 * 地点のまわりのチップを作り、自動の候補を出す（scripts/annotate-prepare.mjs から呼ぶ）。
 * { site, redo } … redo なら、人が手を付けていない種類だけ、自動の候補を出し直す
 */
export async function POST(request: Request) {
  if (!DEV_ONLY) return notFound();
  const body = await request.json().catch(() => null);
  const site = (await readSites()).find((s) => s.id === body?.site);
  if (!site) return Response.json({ error: '地点が見つかりません。' }, { status: 400 });
  try {
    const results = await prepareSite(site, body?.redo === true, request.signal);
    return Response.json({ results });
  } catch (e) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error('[annotate]', e);
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
