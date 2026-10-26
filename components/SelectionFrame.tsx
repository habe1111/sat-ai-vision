'use client';
/**
 * 選んだ範囲の枠。地図の移動・回転に合わせて描き直す。
 *
 * 地図に傾き（ピッチ）は無いので、経緯度の矩形は画面上でも長方形になる（回転だけする）。
 * そこで北西の角を起点に、幅・高さ・角度を求めて 1 枚の div を回すだけで枠になる。
 * 座標のラベルだけは回さず、読める向きのまま角に添える。
 */
import { useEffect, useState } from 'react';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { type BBox, bboxSizeMeters, formatDms, formatLength } from '@/lib/geo';

type Geometry = {
  nw: { x: number; y: number };
  se: { x: number; y: number };
  width: number;
  height: number;
  angle: number;
};

function measure(map: MapLibreMap, bbox: BBox): Geometry {
  const [w, s, e, n] = bbox;
  const nw = map.project([w, n]);
  const ne = map.project([e, n]);
  const sw = map.project([w, s]);
  const se = map.project([e, s]);
  return {
    nw,
    se,
    width: Math.hypot(ne.x - nw.x, ne.y - nw.y),
    height: Math.hypot(sw.x - nw.x, sw.y - nw.y),
    angle: Math.atan2(ne.y - nw.y, ne.x - nw.x),
  };
}

export function SelectionFrame({ map, bbox, scanning }: { map: MapLibreMap; bbox: BBox; scanning: boolean }) {
  const [g, setG] = useState(() => measure(map, bbox));

  useEffect(() => {
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setG(measure(map, bbox)));
    };
    update();
    map.on('move', update);
    map.on('resize', update);
    return () => {
      cancelAnimationFrame(raf);
      map.off('move', update);
      map.off('resize', update);
    };
  }, [map, bbox]);

  const size = bboxSizeMeters(bbox);
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
      <div
        className="frame"
        style={{
          width: g.width,
          height: g.height,
          transform: `translate(${g.nw.x}px, ${g.nw.y}px) rotate(${g.angle}rad)`,
        }}
      >
        <span className="tick nw" />
        <span className="tick ne" />
        <span className="tick sw" />
        <span className="tick se" />
        {scanning && <div className="scan" />}
      </div>
      <span
        className="label-tag absolute"
        style={{ left: g.nw.x, top: g.nw.y, transform: 'translate(0, calc(-100% - 10px))' }}
      >
        {formatDms(bbox[3], 'lat')} {formatDms(bbox[0], 'lon')}
      </span>
      <span
        className="label-tag absolute"
        style={{ left: g.se.x, top: g.se.y, transform: 'translate(-100%, 10px)' }}
      >
        {formatLength(size.width)} × {formatLength(size.height)}
      </span>
    </div>
  );
}
