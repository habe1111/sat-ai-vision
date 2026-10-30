/**
 * 注釈データの読み書き（開発用の注釈ページのサーバー側）。
 *
 * 注釈は data/annotations/chips/<id>.json に 1 チップ 1 ファイルで置き、Git で管理する（CC BY 4.0 で公開する）。
 * 写真と土地被覆の重ね絵は .cache/annotate/ に置くだけで、Git には入れない（タイル座標から取り直せる）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp, { type OverlayOptions } from 'sharp';
import {
  type Annotation, CHIP_PX, CHIP_TILES, CHIP_ZOOM, type Chip, type ChipSummary, type ObjectKind, type Site,
  chipId, chipMpp, parseChipId, siteChips, summarize,
} from '@/lib/annotate';
import { TILE_SIZE } from '@/lib/geo';
import { fetchTile, writeAtomic } from '@/lib/server/tiles';
import { flairAvailable, runFlair } from '@/lib/server/landcover/flair';
import { proposeCandidates } from './candidates';

export const ANNOTATION_DIR = path.join(process.cwd(), 'data', 'annotations');
const CHIP_DIR = path.join(ANNOTATION_DIR, 'chips');
const IMAGE_DIR = path.join(process.cwd(), '.cache', 'annotate');

export async function readSites(): Promise<Site[]> {
  return JSON.parse(await fs.readFile(path.join(ANNOTATION_DIR, 'sites.json'), 'utf8')) as Site[];
}

/** ファイルはあるが読めない（JSON が壊れている）チップ。上書きすると注釈を失うので、書かずに止める */
export class BrokenChipError extends Error {
  constructor(readonly id: string, cause: unknown) {
    super(`チップ ${id} のファイルが壊れています（${cause instanceof Error ? cause.message : String(cause)}）。手で直してください。`);
  }
}

/** チップを読む。ファイルが無ければ null、あるのに読めなければ BrokenChipError */
export async function readChip(id: string): Promise<Chip | null> {
  if (!parseChipId(id)) return null;
  let text: string;
  try {
    text = await fs.readFile(path.join(CHIP_DIR, `${id}.json`), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(text) as Chip;
  } catch (e) {
    throw new BrokenChipError(id, e);
  }
}

/** 差分を読みやすくするため、注釈は 1 件 1 行で書く */
function format(chip: Chip): string {
  const { objects, ...head } = chip;
  const lines = JSON.stringify(head, null, 2).split('\n');
  lines.pop();   // 最後の }
  lines[lines.length - 1] += ',';
  lines.push(objects.length ? `  "objects": [\n${objects.map((o) => `    ${JSON.stringify(o)}`).join(',\n')}\n  ]` : '  "objects": []');
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

export async function writeChip(chip: Chip): Promise<void> {
  await writeAtomic(path.join(CHIP_DIR, `${chip.id}.json`), format(chip));
}

/**
 * 同じチップの「読んで・確かめて・書く」を 1 本ずつ順に行う。画面の保存と候補の出し直しが重なっても、
 * 片方の書き込みを黙って失わないため（next dev は 1 プロセスなので、プロセス内の順番待ちで足りる）
 */
const chipLocks = new Map<string, Promise<unknown>>();
export function withChipLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const run = (chipLocks.get(id) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  chipLocks.set(id, tail);
  void tail.then(() => { if (chipLocks.get(id) === tail) chipLocks.delete(id); });
  return run;
}

/** チップの一覧。壊れたファイルは一覧から黙って消さず、broken に名前を返す（画面で知らせる） */
export async function listChips(): Promise<{ chips: ChipSummary[]; broken: string[] }> {
  let files: string[];
  try {
    files = await fs.readdir(CHIP_DIR);
  } catch {
    return { chips: [], broken: [] };
  }
  const chips: ChipSummary[] = [];
  const broken: string[] = [];
  for (const f of files.filter((name) => name.endsWith('.json'))) {
    try {
      const c = await readChip(f.slice(0, -5));
      if (c) chips.push(summarize(c));
    } catch (e) {
      console.error('[annotate]', e);
      broken.push(f);
    }
  }
  return { chips, broken };
}

/** チップの写真（CHIP_PX 四方の JPEG）。タイルが 1 枚も無ければ null */
export async function chipPhoto(id: string, signal: AbortSignal): Promise<Buffer | null> {
  const p = parseChipId(id);
  if (!p) return null;
  const file = path.join(IMAGE_DIR, `${id}.jpg`);
  try {
    return await fs.readFile(file);
  } catch {
    // 作っていなければタイルから作る
  }
  const parts: OverlayOptions[] = [];
  for (let dy = 0; dy < CHIP_TILES; dy++) {
    for (let dx = 0; dx < CHIP_TILES; dx++) {
      const buf = await fetchTile(CHIP_ZOOM, p.x + dx, p.y + dy, signal);
      if (buf) parts.push({ input: buf, left: dx * TILE_SIZE, top: dy * TILE_SIZE });
    }
  }
  if (!parts.length) return null;
  const jpeg = await sharp({ create: { width: CHIP_PX, height: CHIP_PX, channels: 3, background: '#000000' } })
    .composite(parts)
    .jpeg({ quality: 92 })
    .toBuffer();
  await writeAtomic(file, jpeg);
  return jpeg;
}

/** チップの土地被覆の重ね絵（PNG）。FLAIR が無ければ null */
export async function chipLandCover(id: string, signal: AbortSignal): Promise<Buffer | null> {
  const p = parseChipId(id);
  if (!p || !flairAvailable()) return null;
  const file = path.join(IMAGE_DIR, `${id}-landcover.png`);
  try {
    return await fs.readFile(file);
  } catch {
    // 作っていなければ推論する
  }
  const photo = await chipPhoto(id, signal);
  if (!photo) return null;
  const r = await runFlair(photo, chipMpp(p.y), signal);
  await writeAtomic(file, r.overlay);
  return r.overlay;
}

export type PrepareResult = { id: string; created: boolean; candidates: number; skipped?: string };

/**
 * 地点のまわりのチップを作り、候補を出して保存する。すでにあるチップは注釈を残したまま触らない。
 * redo なら、人がまだ手を付けていない種類だけ、自動の候補（auto かつ proposed）を出し直す
 */
export async function prepareSite(site: Site, redo: boolean, signal: AbortSignal): Promise<PrepareResult[]> {
  if (!flairAvailable()) throw new Error('土地被覆モデルがありません。npm run setup で入れてください。');
  const out: PrepareResult[] = [];
  for (const { x, y } of siteChips(site)) {
    signal.throwIfAborted();
    const id = chipId(x, y);
    let existing: Chip | null;
    try {
      existing = await readChip(id);
    } catch (e) {
      // 壊れたファイルは上書きしない（人の注釈が入っているかもしれない）
      out.push({ id, created: false, candidates: 0, skipped: e instanceof Error ? e.message : String(e) });
      continue;
    }
    if (existing && !redo) {
      out.push({ id, created: false, candidates: 0, skipped: 'すでにあります' });
      continue;
    }
    const photo = await chipPhoto(id, signal);
    if (!photo) {
      out.push({ id, created: false, candidates: 0, skipped: '写真がありません' });
      continue;
    }
    const overlay = await chipLandCover(id, signal);
    const mpp = chipMpp(y);
    const candidates = await proposeCandidates(photo, overlay!, mpp);
    try {
      out.push(await withChipLock(id, () => saveCandidates(id, x, y, site, mpp, candidates, redo)));
    } catch (e) {
      if (!(e instanceof BrokenChipError)) throw e;
      out.push({ id, created: false, candidates: 0, skipped: e.message });
    }
  }
  return out;
}

/** 候補を書き込む。推論の間に画面で直された注釈を消さないよう、書く直前に読み直す */
async function saveCandidates(
  id: string, x: number, y: number, site: Site, mpp: number, candidates: Annotation[], redo: boolean,
): Promise<PrepareResult> {
  const existing = await readChip(id);
  // 推論している間に、別の準備が先に作っていた
  if (existing && !redo) return { id, created: false, candidates: 0, skipped: 'すでにあります' };
  const kept = existing ? existing.objects.filter((o) => !(o.source === 'auto' && o.status === 'proposed')) : [];
  // 人が手を付けた種類（確認済み、または人が付けた・確定した注釈がある）には、新しい候補を足さない。
  // 人が消した候補は記録していないので、足すと「違う」と判断して消したものが戻ってしまう
  const touched = (k: ObjectKind) =>
    existing !== null && (existing.reviewed[k] || existing.objects.some((o) => o.kind === k && (o.source === 'human' || o.status === 'accepted')));
  const fresh = candidates.filter((c) => !touched(c.kind));
  const chip: Chip = {
    id,
    z: CHIP_ZOOM,
    x,
    y,
    site: existing?.site ?? site.id,
    mpp: Math.round(mpp * 1000) / 1000,
    reviewed: existing?.reviewed ?? { ship: false, car: false },
    objects: [...kept, ...fresh],
    updatedAt: new Date().toISOString(),
  };
  await writeChip(chip);
  return { id, created: !existing, candidates: fresh.length };
}
