import { type Annotation, OBJECT_KINDS, type Chip, sanitizeAnnotation } from '@/lib/annotate';
import { DEV_ONLY, notFound } from '@/lib/server/annotate/devOnly';
import { BrokenChipError, readChip, withChipLock, writeChip } from '@/lib/server/annotate/store';

/** 1 枚のチップと注釈 */
export async function GET(_req: Request, ctx: RouteContext<'/api/dev/annotate/[chip]'>) {
  if (!DEV_ONLY) return notFound();
  try {
    const chip = await readChip((await ctx.params).chip);
    return chip ? Response.json(chip, { headers: { 'Cache-Control': 'no-store' } }) : notFound();
  } catch (e) {
    return broken(e);
  }
}

/** 壊れたファイルは上書きせず、そのことを返す */
function broken(e: unknown): Response {
  if (!(e instanceof BrokenChipError)) throw e;
  return Response.json({ error: e.message }, { status: 500 });
}

/**
 * 注釈を保存する。{ objects, reviewed, updatedAt }。
 * updatedAt は読んだときの値で、その後に別の所（Claude の下付けなど）から書き換わっていたら 409 で断る
 */
export async function PUT(request: Request, ctx: RouteContext<'/api/dev/annotate/[chip]'>) {
  if (!DEV_ONLY) return notFound();
  const id = (await ctx.params).chip;
  const body = await request.json().catch(() => null);
  return withChipLock(id, () => save(id, body)).catch(broken);
}

async function save(id: string, body: { objects?: unknown[]; reviewed?: Record<string, unknown>; updatedAt?: unknown } | null) {
  const chip = await readChip(id);
  if (!chip) return notFound();
  if (!body || !Array.isArray(body.objects) || body.objects.length > 2000) {
    return Response.json({ error: '注釈の形が正しくありません。' }, { status: 400 });
  }
  if (body.updatedAt !== chip.updatedAt) {
    return Response.json({ error: 'ほかの所で書き換わりました。読み込み直してください。', chip }, { status: 409 });
  }
  const parsed = body.objects.map(sanitizeAnnotation);
  const bad = parsed.findIndex((o) => o === null);
  if (bad >= 0) {
    return Response.json({ error: `${bad + 1} 件目の注釈の形が正しくありません（${JSON.stringify(body.objects[bad]).slice(0, 200)}）。` }, { status: 400 });
  }
  if (new Set(parsed.map((o) => o!.id)).size !== parsed.length) {
    return Response.json({ error: '注釈の id が重なっています。' }, { status: 400 });
  }
  const reviewed = { ...chip.reviewed };
  for (const k of OBJECT_KINDS) if (typeof body.reviewed?.[k] === 'boolean') reviewed[k] = body.reviewed[k];
  // 確認済みの種類に候補が残らないようにする（確認済みのチップは、残した候補も人が確かめた正解として学習に使う）
  const objects = (parsed as Annotation[]).map((o) => (reviewed[o.kind] && o.status === 'proposed' ? { ...o, status: 'accepted' as const } : o));
  const next: Chip = { ...chip, objects, reviewed, updatedAt: new Date().toISOString() };
  await writeChip(next);
  return Response.json(next);
}
