'use client';
/**
 * 土地被覆の重ね絵から、選んだ区分の色だけを残した絵を作る（写真と地図の両方で使う）。
 *
 * 重ね絵は区分ごとに単色で塗った PNG なので、画素の色で区分が分かる。サーバーに問い合わせず、
 * 押したらすぐ切り替わるよう画面側で抜き出す。何も選んでいないときは元の重ね絵をそのまま使う。
 */
import { useEffect, useRef, useState } from 'react';
import type { LandCoverClass } from '@/lib/types';

/** 色の一致を見るときの許容差（各色 0〜255）。PNG の読み込みで色がわずかにずれても拾う */
const TOLERANCE = 6;

function parseRgb(css: string): [number, number, number] | null {
  const m = css.match(/\d+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
}

/** 重ね絵の画素を読む。URL ごとに 1 回だけ読み込む */
const pixelCache = new Map<string, Promise<ImageData>>();
function loadPixels(url: string): Promise<ImageData> {
  let p = pixelCache.get(url);
  if (!p) {
    p = (async () => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    })();
    p.catch(() => pixelCache.delete(url));
    // 1 枚で十数 MB になるので、いま使っている重ね絵の分だけ持つ
    pixelCache.clear();
    pixelCache.set(url, p);
  }
  return p;
}

async function filterPixels(src: ImageData, colors: [number, number, number][]): Promise<Blob | null> {
  const out = new ImageData(src.width, src.height);
  const s = src.data, d = out.data;
  for (let i = 0; i < s.length; i += 4) {
    if (s[i + 3] === 0) continue;
    for (const [r, g, b] of colors) {
      if (Math.abs(s[i] - r) <= TOLERANCE && Math.abs(s[i + 1] - g) <= TOLERANCE && Math.abs(s[i + 2] - b) <= TOLERANCE) {
        d[i] = s[i]; d[i + 1] = s[i + 1]; d[i + 2] = s[i + 2]; d[i + 3] = s[i + 3];
        break;
      }
    }
  }
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  canvas.getContext('2d')!.putImageData(out, 0, 0);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

/** 表示する重ね絵の URL を返す */
export function useClassOverlay(url: string | null, classes: LandCoverClass[], selected: string[]): string | null {
  const [made, setMade] = useState<{ key: string; url: string } | null>(null);
  // いま出している絵。次の絵に替わってから捨てる（捨てた URL を写真や地図が読みに行かないように）
  const currentRef = useRef<string | null>(null);
  const key = selected.length ? `${url}|${[...selected].sort().join(',')}` : null;

  useEffect(() => {
    if (!url || !key) {
      // 絞り込みをやめた・パネルを閉じた。地図が元の絵に替わるのを待ってから、作った絵を捨てる
      const prev = currentRef.current;
      currentRef.current = null;
      if (!url) pixelCache.clear();
      if (!prev) return;
      // 途中で別の区分を選び直しても止めない（止めると、この絵がどこからも捨てられなくなる）
      window.setTimeout(() => {
        // 捨てた絵を、次に絞り込んだとき「直前の絵」として出さないよう一緒に忘れる
        setMade((m) => (m?.url === prev ? null : m));
        URL.revokeObjectURL(prev);
      }, 5000);
      return;
    }
    const colors = classes
      .filter((c) => selected.includes(c.key))
      .map((c) => parseRgb(c.color))
      .filter((c): c is [number, number, number] => c !== null);
    let alive = true;
    loadPixels(url)
      .then((px) => filterPixels(px, colors))
      .then((blob) => {
        if (!alive || !blob) return;
        const prev = currentRef.current;
        currentRef.current = URL.createObjectURL(blob);
        setMade({ key, url: currentRef.current });
        // 地図は新しい絵を読み終えるまで前の絵を使うので、少し待ってから捨てる
        if (prev) window.setTimeout(() => URL.revokeObjectURL(prev), 5000);
      })
      .catch(() => { /* 読めなければ元の重ね絵のまま */ });
    return () => {
      alive = false;
    };
    // classes と selected は key に含まれる（中身が同じなら作り直さない）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, key]);

  useEffect(() => () => {
    if (currentRef.current) URL.revokeObjectURL(currentRef.current);
  }, []);

  if (!url) return null;
  if (!key) return url;
  // 絵ができるまでは、同じ重ね絵から作った直前の絵を出す（元の重ね絵に一瞬戻るとちらつくため）
  return made && made.key.startsWith(`${url}|`) ? made.url : url;
}
