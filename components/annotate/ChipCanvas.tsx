'use client';
/**
 * 注釈ページの写真と注釈。写真の上に SVG を重ね、座標はチップの画素（0〜512）で扱う。
 *
 * 車：何も無い所をクリックで点を打つ。点はドラッグで動かす。
 * 船：何も無い所をドラッグで長辺を引く（船首から船尾へ）。選ぶと両端と側面に取っ手が出る。
 * どちらも Shift を押しながらドラッグで、囲んだものをまとめて選ぶ。
 * いまの種類でない注釈は薄く出すだけで、触れない。
 */
import { type PointerEvent, useRef, useState } from 'react';
import {
  type Annotation, CHIP_PX, type Chip, type ObjectKind, type ShipBox,
  clampShip, normalizeAngle, shipCorners, shipEnds, shipFromEnds,
} from '@/lib/annotate';

type Pt = [number, number];

type Props = {
  chip: Chip;
  mode: ObjectKind;
  zoom: number;
  showLandCover: boolean;
  hideMarks: boolean;
  selected: ReadonlySet<string>;
  onSelect: (ids: string[], additive: boolean) => void;
  /** 注釈を書き換える。record なら元に戻す点を積む */
  onEdit: (fn: (objects: Annotation[]) => Annotation[], record?: boolean) => void;
  /** 元に戻す点だけを積む（ドラッグの始め） */
  onCheckpoint: () => void;
  newId: () => string;
};

type Drag =
  | { type: 'car'; at: Pt; screen: Pt }
  | { type: 'new-ship'; a: Pt; b: Pt }
  | { type: 'move'; start: Pt; grabbed: string; orig: Map<string, Annotation>; moved: boolean }
  | { type: 'end'; id: string; fixed: Pt; width: number }
  | { type: 'width'; id: string }
  | { type: 'marquee'; a: Pt; b: Pt; additive: boolean };

/** クリックとドラッグを分ける動きの大きさ（画面の px） */
const CLICK_SLOP = 4;
const clamp = (v: number) => Math.min(CHIP_PX, Math.max(0, v));

const COLOR = {
  proposed: '#ffd400',
  accepted: '#3ee0ff',
  difficult: '#ff8a00',
  selected: '#ff3fb0',
};

function strokeOf(o: Annotation, selected: boolean) {
  if (selected) return { stroke: COLOR.selected, dash: undefined, width: 2.5 };
  if (o.difficult) return { stroke: COLOR.difficult, dash: '2 3', width: 1.75 };
  return o.status === 'accepted'
    ? { stroke: COLOR.accepted, dash: undefined, width: 1.75 }
    : { stroke: COLOR.proposed, dash: '4 3', width: 1.5 };
}

export function ChipCanvas({ chip, mode, zoom, showLandCover, hideMarks, selected, onSelect, onEdit, onCheckpoint, newId }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  // 描いている途中の形（新しい船・囲み）。ドラッグのたびに描き直すため state にも持つ
  const [preview, setPreview] = useState<Drag | null>(null);
  const size = CHIP_PX * zoom;

  function toChip(e: PointerEvent): Pt {
    const svg = svgRef.current!;
    const r = svg.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * CHIP_PX, ((e.clientY - r.top) / r.height) * CHIP_PX];
  }

  function begin(e: PointerEvent<SVGSVGElement>) {
    if (e.button !== 0 || hideMarks) return;
    const p = toChip(e);
    const target = (e.target as Element).closest('[data-id]');
    const id = target?.getAttribute('data-id') ?? null;
    const handle = (e.target as Element).getAttribute('data-handle');
    const obj = id ? chip.objects.find((o) => o.id === id) : undefined;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.shiftKey && !obj) {
      drag.current = { type: 'marquee', a: p, b: p, additive: true };
    } else if (obj && handle && obj.kind === 'ship') {
      onCheckpoint();
      if (handle === 'width') {
        drag.current = { type: 'width', id: obj.id };
      } else {
        const ends = shipEnds(obj);
        drag.current = { type: 'end', id: obj.id, fixed: ends[handle === 'end0' ? 1 : 0], width: obj.width };
      }
    } else if (obj && obj.kind === mode) {
      if (e.shiftKey) {
        onSelect([obj.id], true);
        drag.current = null;
        return;
      }
      // 選んでいないものを掴んだら、それだけを選び直して動かす
      const ids = selected.has(obj.id) ? [...selected] : [obj.id];
      if (!selected.has(obj.id)) onSelect(ids, false);
      const orig = new Map(chip.objects.filter((o) => ids.includes(o.id)).map((o) => [o.id, o]));
      drag.current = { type: 'move', start: p, grabbed: obj.id, orig, moved: false };
    } else if (mode === 'car') {
      drag.current = { type: 'car', at: p, screen: [e.clientX, e.clientY] };
    } else {
      drag.current = { type: 'new-ship', a: p, b: p };
    }
    setPreview(drag.current);
  }

  function move(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    const p = toChip(e);
    if (d.type === 'marquee' || d.type === 'new-ship') {
      drag.current = { ...d, b: p };
      setPreview(drag.current);
    } else if (d.type === 'car') {
      // 点を打つつもりで少し動いただけなら、点のまま扱う
      if (Math.hypot(e.clientX - d.screen[0], e.clientY - d.screen[1]) > CLICK_SLOP) {
        drag.current = { type: 'marquee', a: d.at, b: p, additive: false };
        setPreview(drag.current);
      }
    } else if (d.type === 'move') {
      const dx = p[0] - d.start[0], dy = p[1] - d.start[1];
      if (!d.moved) {
        if (Math.hypot(dx, dy) * zoom < CLICK_SLOP) return;
        onCheckpoint();
        d.moved = true;
      }
      onEdit((objs) => objs.map((o) => {
        const was = d.orig.get(o.id);
        if (!was) return o;
        // 人が位置を直したものは、確かめたものとして確定する
        if (was.kind === 'car') return { ...was, x: clamp(was.x + dx), y: clamp(was.y + dy), status: 'accepted' };
        return clampShip({ ...was, cx: was.cx + dx, cy: was.cy + dy, status: 'accepted' as const });
      }), false);
    } else if (d.type === 'end') {
      onEdit((objs) => objs.map((o) => (o.id === d.id && o.kind === 'ship'
        ? clampShip({ ...o, ...shipFromEnds(d.fixed, p, d.width), status: 'accepted' as const })
        : o)), false);
    } else if (d.type === 'width') {
      onEdit((objs) => objs.map((o) => {
        if (o.id !== d.id || o.kind !== 'ship') return o;
        // 長辺の中心線からの距離の 2 倍が幅
        const dist = Math.abs(-(p[0] - o.cx) * Math.sin(o.angle) + (p[1] - o.cy) * Math.cos(o.angle));
        return clampShip({ ...o, width: dist * 2, status: 'accepted' as const });
      }), false);
    }
  }

  function end(e: PointerEvent<SVGSVGElement>) {
    const d = drag.current;
    drag.current = null;
    setPreview(null);
    if (!d) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (d.type === 'move' && !d.moved) {
      // 動かさずに離したら、掴んだもの 1 つだけを選び直す（全部を選んだまま Delete して全部消さないため）
      onSelect([d.grabbed], false);
    } else if (d.type === 'car') {
      const id = newId();
      onEdit((objs) => [...objs, { id, kind: 'car', status: 'accepted', source: 'human', x: clamp(d.at[0]), y: clamp(d.at[1]) }]);
      onSelect([id], false);
    } else if (d.type === 'new-ship') {
      const len = Math.hypot(d.b[0] - d.a[0], d.b[1] - d.a[1]);
      if (len * zoom < CLICK_SLOP * 2) {
        onSelect([], false);   // 何も無い所をクリックしただけ
        return;
      }
      const id = newId();
      const box = clampShip(shipFromEnds(d.a, d.b, Math.max(2, len * 0.28)));
      onEdit((objs) => [...objs, { id, kind: 'ship', status: 'accepted', source: 'human', ...box }]);
      onSelect([id], false);
    } else if (d.type === 'marquee') {
      const [x0, x1] = [Math.min(d.a[0], d.b[0]), Math.max(d.a[0], d.b[0])];
      const [y0, y1] = [Math.min(d.a[1], d.b[1]), Math.max(d.a[1], d.b[1])];
      const ids = chip.objects
        .filter((o) => o.kind === mode)
        .filter((o) => {
          const [x, y] = o.kind === 'car' ? [o.x, o.y] : [o.cx, o.cy];
          return x >= x0 && x <= x1 && y >= y0 && y <= y1;
        })
        .map((o) => o.id);
      onSelect(ids, d.additive);
    }
  }

  const active = chip.objects.filter((o) => o.kind === mode);
  const others = chip.objects.filter((o) => o.kind !== mode);
  const onlySelected = active.filter((o) => selected.has(o.id));
  const handleShip = onlySelected.length === 1 && onlySelected[0].kind === 'ship' ? onlySelected[0] : null;
  // 取っ手と点の大きさは画面の px でそろえる（拡大しても同じ大きさで掴める）
  const u = 1 / zoom;

  return (
    <div className="relative shrink-0 select-none" style={{ width: size, height: size }}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 開発用。画素をそのまま拡大して見たいので next/image を通さない */}
      <img
        src={`/api/dev/annotate/${chip.id}/photo.jpg`}
        alt={`チップ ${chip.id} の空中写真`}
        width={size}
        height={size}
        draggable={false}
        className="absolute inset-0 size-full"
        style={{ imageRendering: zoom >= 2 ? 'pixelated' : 'auto' }}
      />
      {showLandCover && (
        // eslint-disable-next-line @next/next/no-img-element -- 同上
        <img
          src={`/api/dev/annotate/${chip.id}/landcover.png`}
          alt=""
          width={size}
          height={size}
          draggable={false}
          className="absolute inset-0 size-full opacity-40"
          style={{ imageRendering: 'pixelated' }}
        />
      )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHIP_PX} ${CHIP_PX}`}
        className="absolute inset-0 size-full touch-none"
        style={{ cursor: mode === 'car' ? 'crosshair' : 'cell' }}
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={() => { drag.current = null; setPreview(null); }}
        role="application"
        aria-label={`${mode === 'car' ? '車' : '船'}の注釈。キー操作は右の一覧を参照`}
      >
        {!hideMarks && (
          <>
            <g opacity={0.35} pointerEvents="none">
              {others.map((o) => <Mark key={o.id} o={o} u={u} selected={false} />)}
            </g>
            <g>
              {active.map((o) => <Mark key={o.id} o={o} u={u} selected={selected.has(o.id)} />)}
            </g>
            {handleShip && <ShipHandles b={handleShip} u={u} />}
          </>
        )}
        {preview?.type === 'new-ship' && (
          <polygon
            points={shipCorners(shipFromEnds(preview.a, preview.b, Math.max(2, Math.hypot(preview.b[0] - preview.a[0], preview.b[1] - preview.a[1]) * 0.28))).join(' ')}
            fill="none" stroke={COLOR.selected} strokeWidth={2 * u} pointerEvents="none"
          />
        )}
        {preview?.type === 'marquee' && (
          <rect
            x={Math.min(preview.a[0], preview.b[0])}
            y={Math.min(preview.a[1], preview.b[1])}
            width={Math.abs(preview.b[0] - preview.a[0])}
            height={Math.abs(preview.b[1] - preview.a[1])}
            fill="rgb(255 63 176 / 0.12)" stroke={COLOR.selected} strokeWidth={1.5 * u} strokeDasharray={`${4 * u} ${3 * u}`}
            pointerEvents="none"
          />
        )}
      </svg>
    </div>
  );
}

function Mark({ o, u, selected }: { o: Annotation; u: number; selected: boolean }) {
  const s = strokeOf(o, selected);
  const dash = s.dash?.split(' ').map((v) => Number(v) * u).join(' ');
  if (o.kind === 'car') {
    return (
      <g data-id={o.id} style={{ cursor: 'move' }}>
        {/* 掴みやすいよう、見えない大きめの円を下に敷く */}
        <circle cx={o.x} cy={o.y} r={7 * u} fill="transparent" />
        <circle cx={o.x} cy={o.y} r={4.5 * u} fill="none" stroke="#000" strokeOpacity={0.55} strokeWidth={(s.width + 1.5) * u} />
        <circle cx={o.x} cy={o.y} r={4.5 * u} fill="none" stroke={s.stroke} strokeWidth={s.width * u} strokeDasharray={dash} />
        <circle cx={o.x} cy={o.y} r={1 * u} fill={s.stroke} />
      </g>
    );
  }
  const pts = shipCorners(o).join(' ');
  return (
    <g data-id={o.id} style={{ cursor: 'move' }}>
      <polygon points={pts} fill="transparent" stroke="#000" strokeOpacity={0.55} strokeWidth={(s.width + 1.5) * u} />
      <polygon points={pts} fill={selected ? 'rgb(255 63 176 / 0.1)' : 'transparent'} stroke={s.stroke} strokeWidth={s.width * u} strokeDasharray={dash} />
    </g>
  );
}

function ShipHandles({ b, u }: { b: ShipBox; u: number }) {
  const [e0, e1] = shipEnds(b);
  // 側面の取っ手：長辺の中ほどから、短辺の向きに幅の半分だけ出た所
  const side: Pt = [b.cx - Math.sin(b.angle) * (b.width / 2), b.cy + Math.cos(b.angle) * (b.width / 2)];
  const r = 5 * u;
  const handle = (p: Pt, name: string, title: string) => (
    <rect
      key={name}
      data-id={b.id}
      data-handle={name}
      x={p[0] - r} y={p[1] - r} width={r * 2} height={r * 2}
      fill="#fff" stroke={COLOR.selected} strokeWidth={1.5 * u}
      style={{ cursor: name === 'width' ? 'ew-resize' : 'grab' }}
      transform={`rotate(${(normalizeAngle(b.angle) * 180) / Math.PI} ${p[0]} ${p[1]})`}
    >
      <title>{title}</title>
    </rect>
  );
  return (
    <g>
      <line x1={e0[0]} y1={e0[1]} x2={e1[0]} y2={e1[1]} stroke={COLOR.selected} strokeWidth={1 * u} strokeDasharray={`${3 * u} ${3 * u}`} pointerEvents="none" />
      {handle(e0, 'end0', '端：ドラッグで長さと向きを変える')}
      {handle(e1, 'end1', '端：ドラッグで長さと向きを変える')}
      {handle(side, 'width', '側面：ドラッグで幅を変える')}
    </g>
  );
}
