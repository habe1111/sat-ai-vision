'use client';
/**
 * 地図の上をドラッグして、解析する範囲（経緯度の矩形）を選ぶ。
 *
 * Pointer Events を使うのでマウスとタッチの両方で同じに動く。選んでいる間は地図の移動・回転を
 * 止め、指の動きがすべて範囲選択になるようにする。
 * 地図が回転していても、範囲は経緯度の軸に沿った矩形として扱う（画面では傾いて見える）。
 * こうすると「見えている枠」と「解析する範囲」が必ず一致する。
 */
import { useEffect } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { type BBox, bboxFromPoints } from '@/lib/geo';

/** これより短い動き（タップ中の指のぶれ・クリック中のマウスのずれ）は、ドラッグとみなさない */
const MIN_DRAG_PX = 8;

export function useAreaSelect(
  map: MapLibreMap | null,
  active: boolean,
  onChange: (bbox: BBox) => void,
  onDone: (bbox: BBox | null) => void,
) {
  useEffect(() => {
    if (!map || !active) return;
    const el = map.getCanvasContainer();
    const handlers = [map.dragPan, map.dragRotate, map.touchZoomRotate, map.doubleClickZoom, map.boxZoom];
    const wasEnabled = handlers.map((h) => h.isEnabled());
    handlers.forEach((h) => h.disable());
    el.style.cursor = 'crosshair';
    el.style.touchAction = 'none';

    let start: [number, number] | null = null;
    let startPx: [number, number] | null = null;
    let pointerId: number | null = null;
    let last: BBox | null = null;

    const lngLatAt = (e: PointerEvent): [number, number] => {
      const rect = el.getBoundingClientRect();
      const ll = map.unproject([e.clientX - rect.left, e.clientY - rect.top]);
      return [ll.lng, ll.lat];
    };
    const down = (e: PointerEvent) => {
      if (pointerId !== null || (e.pointerType === 'mouse' && e.button !== 0)) return;
      pointerId = e.pointerId;
      el.setPointerCapture(e.pointerId);
      start = lngLatAt(e);
      startPx = [e.clientX, e.clientY];
      last = null;
      e.preventDefault();
    };
    const move = (e: PointerEvent) => {
      if (e.pointerId !== pointerId || !start || !startPx) return;
      if (!last && Math.hypot(e.clientX - startPx[0], e.clientY - startPx[1]) < MIN_DRAG_PX) return;
      last = bboxFromPoints(start, lngLatAt(e));
      onChange(last);
    };
    const up = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      start = null;
      startPx = null;
      onDone(last);
    };
    // OS がジェスチャーを横取りしたとき（iOS の端からのスワイプなど）は、途中の範囲を確定させずに捨てる
    const cancel = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      start = null;
      startPx = null;
      last = null;
      onDone(null);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', cancel);
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', cancel);
      handlers.forEach((h, i) => wasEnabled[i] && h.enable());
      el.style.cursor = '';
      el.style.touchAction = '';
    };
  }, [map, active, onChange, onDone]);
}
