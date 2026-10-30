'use client';
/**
 * 画面全体。開くといきなり地図（空中写真）が出る。
 *
 * - 左端のタブ：場所の検索
 * - 右上：ズーム・コンパス（回転を北に戻す）・現在地
 * - 下中央：範囲を選んで解析
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GeolocateControl,
  Map as MapLibreMap,
  Marker,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type FilterSpecification,
  type GeoJSONSource,
  type ImageSource,
  type StyleSpecification,
} from 'maplibre-gl';
import { type BBox, bboxFromPoints, bboxToPolygon } from '@/lib/geo';
import { GSI_TILE_URL, IMAGERY_BANDS, IMAGERY_MAX_ZOOM } from '@/lib/imagery';
import { chooseZoom } from '@/lib/selection';
import { regionBBox } from '@/lib/regions';
import type { Highlight, LandCoverClass, Place } from '@/lib/types';
import { useAnalysis } from '@/lib/client/useAnalysis';
import { useAreaSelect } from '@/lib/client/useAreaSelect';
import { useClassOverlay } from '@/lib/client/useClassOverlay';
import { SearchPanel } from '@/components/SearchPanel';
import { SelectionFrame } from '@/components/SelectionFrame';
import { SelectBar } from '@/components/SelectBar';
import { ReportPanel } from '@/components/ReportPanel';

/** URL に位置が無いときの初期表示：東京駅（ズーム 16） */
const INITIAL_VIEW = { center: [139.7671, 35.6812] as [number, number], zoom: 16 };

const STYLE: StyleSpecification = {
  version: 8,
  sources: Object.fromEntries(
    IMAGERY_BANDS.map((b) => [
      b.id,
      {
        type: 'raster',
        tiles: [GSI_TILE_URL],
        tileSize: 256,
        minzoom: b.minzoom,
        maxzoom: Math.min(b.maxzoom - 1, IMAGERY_MAX_ZOOM),
        attribution: b.attribution,
      },
    ]),
  ),
  layers: IMAGERY_BANDS.map((b) => ({
    id: `imagery-${b.id}`,
    type: 'raster',
    source: b.id,
    minzoom: b.minzoom,
    maxzoom: b.maxzoom,
    paint: { 'raster-fade-duration': 150 },
  })),
};

const LOCALE = {
  'NavigationControl.ZoomIn': '拡大',
  'NavigationControl.ZoomOut': '縮小',
  'NavigationControl.ResetBearing': '北を上にする',
  'GeolocateControl.FindMyLocation': '現在地を表示',
  'GeolocateControl.LocationNotAvailable': '現在地を取得できません',
  'AttributionControl.ToggleAttribution': '出典の表示を切り替え',
  'ScaleControl.Meters': 'm',
  'ScaleControl.Kilometers': 'km',
};

type Mode = 'idle' | 'selecting' | 'selected' | 'report';

const NO_HIGHLIGHT: Highlight = { classes: [], region: null, objects: null };
const NO_CLASSES: LandCoverClass[] = [];
const EMPTY = { type: 'FeatureCollection' as const, features: [] };
/** 地図の上の線の色。MapLibre は CSS 変数を読めないので、globals.css の --survey と同じ値を書く */
const SURVEY = '#d01c80';
/** 建物などの形の色。区画の枠（マゼンタ）や土地被覆の色と見分けられ、写真の上でも目立つ黄色 */
const OBJECT_COLOR = '#ffd400';

/** 横向きのスマホ。結果は下からのシートでなく右に出す（globals.css の land と同じ条件） */
const LANDSCAPE_PHONE = '(orientation: landscape) and (max-height: 540px) and (max-width: 1023.98px)';

type Padding = { top: number; bottom: number; left: number; right: number };

/**
 * fitBounds の余白が画面より大きいと地図が動けなくなるので、範囲を出す場所を 2 割は残す
 */
function fitPadding(p: Padding, width: number, height: number): Padding {
  const sx = Math.min(1, (width * 0.8) / (p.left + p.right));
  const sy = Math.min(1, (height * 0.8) / (p.top + p.bottom));
  return {
    top: Math.round(p.top * sy),
    bottom: Math.round(p.bottom * sy),
    left: Math.round(p.left * sx),
    right: Math.round(p.right * sx),
  };
}

/** 区画の枠と、範囲のうち区画の外（暗くする部分。区画を穴にした多角形） */
function focusFeatures(outer: BBox, inner: BBox): GeoJSON.FeatureCollection {
  const ring = ([w, s, e, n]: BBox) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { part: 'mask' }, geometry: { type: 'Polygon', coordinates: [ring(outer), ring(inner).reverse()] } },
      { type: 'Feature', properties: { part: 'outline' }, geometry: { type: 'Polygon', coordinates: [ring(inner)] } },
    ],
  };
}

/** 検索結果の場所へ地図を移し、印を置く */
function showPlace(map: MapLibreMap, p: Place, markerRef: { current: Marker | null }) {
  const el = document.createElement('div');
  el.className = 'size-4 rounded-full border-[3px] border-white bg-[var(--survey)] shadow-[var(--shadow)]';
  markerRef.current?.remove();
  markerRef.current = new Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  // 広い場所（市町村など）は範囲が収まるように、施設は写真の細部が見えるズームで。
  // essential を付けないので、OS で動きを減らす設定にしている端末ではアニメーションせずに移る
  const small = !p.bbox || (p.bbox[2] - p.bbox[0] < 0.01 && p.bbox[3] - p.bbox[1] < 0.01);
  if (small) map.flyTo({ center: [p.lon, p.lat], zoom: 17, bearing: 0 });
  else map.fitBounds(p.bbox!, { padding: 48, maxZoom: 17, bearing: 0 });
}

export default function MapApp({ initialQuery }: { initialQuery: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  // ?q= 付きで開いたときは検索結果が見えるように、パネルを開いておく
  const [searchOpen, setSearchOpen] = useState(Boolean(initialQuery));
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const markerRef = useRef<Marker | null>(null);
  // 地図の読み込み（'load'）より先に選ばれた場所。読み込めたらそこへ移る
  const pendingPlaceRef = useRef<Place | null>(null);

  const [mode, setMode] = useState<Mode>('idle');
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [overlayOn, setOverlayOn] = useState(true);
  // 写真と地図に示している区分・区画（区分の一覧を押したとき・AI が答えたときに変わる）
  const [highlight, setHighlight] = useState<Highlight>(NO_HIGHLIGHT);
  // 建物の形を描くために土地被覆を自動で消したか。形を消すときに元へ戻すため
  const hidOverlayRef = useRef(false);
  const { state: analysis, start, reset } = useAnalysis();

  // ---- 地図の用意 ---------------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    setWorkerUrl('/maplibre/maplibre-gl-worker.mjs');
    const m = new MapLibreMap({
      container: containerRef.current,
      style: STYLE,
      center: INITIAL_VIEW.center,
      zoom: INITIAL_VIEW.zoom,
      minZoom: 4,
      maxZoom: 19,           // 写真は z18 まで。z19 はそれを拡大して見せる
      maxPitch: 0,           // 3D（傾き）は使わない
      hash: 'map',           // #map=ズーム/緯度/経度/方位 で今の位置がそのままリンクになる
      renderWorldCopies: false,
      attributionControl: { compact: true },
      locale: LOCALE,
    });
    m.touchPitch.disable();
    m.addControl(new NavigationControl({ showZoom: true, showCompass: true, visualizePitch: false }), 'top-right');
    m.addControl(
      new GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
        trackUserLocation: false,
        showAccuracyCircle: true,
        fitBoundsOptions: { maxZoom: 17 },
      }),
      'top-right',
    );
    m.addControl(new ScaleControl({ unit: 'metric', maxWidth: 120 }), 'bottom-left');
    m.on('load', () => setMap(m));
    // 動作確認（E2E テスト）から地図に触れるように、開発中だけ window に出す
    if (process.env.NODE_ENV !== 'production') (window as unknown as { __map?: MapLibreMap }).__map = m;
    return () => {
      setMap(null);
      // m.remove() は URL の #map= を消す。開発中は React が地図を作り直すので、
      // 消えたままだと共有リンクの位置が初期位置で上書きされる
      const { hash } = window.location;
      m.remove();
      if (hash && !window.location.hash) history.replaceState(history.state, '', hash);
    };
  }, []);

  // ---- 検索結果を選んだとき ---------------------------------------------------------
  const onSelectPlace = useCallback(
    (p: Place) => {
      setSelectedPlace(p);
      if (map) showPlace(map, p, markerRef);
      else pendingPlaceRef.current = p;
      // 画面の狭い端末では、地図が見えるようにパネルを閉じる
      if (window.matchMedia('(max-width: 639px)').matches) setSearchOpen(false);
    },
    [map],
  );
  useEffect(() => {
    if (!map || !pendingPlaceRef.current) return;
    showPlace(map, pendingPlaceRef.current, markerRef);
    pendingPlaceRef.current = null;
  }, [map]);

  // ---- 範囲選択 -------------------------------------------------------------------
  const onSelectChange = useCallback((b: BBox) => setBbox(b), []);
  const onSelectDone = useCallback((b: BBox | null) => {
    // ドラッグせずに離した・OS に操作を取られた。途中まで描いた枠は消して、選び直してもらう
    if (!b) {
      setBbox(null);
      return;
    }
    setBbox(b);
    setMode('selected');
  }, []);
  useAreaSelect(map, mode === 'selecting', onSelectChange, onSelectDone);

  // キーボードでも選べるように、いま表示している範囲（パネルやボタンのかかる縁は除く）を選ぶ
  const selectView = useCallback(() => {
    if (!map) return;
    const { width, height } = map.getContainer().getBoundingClientRect();
    const left = Math.max(56, width * 0.15);
    const right = width - Math.max(72, width * 0.15);
    const top = Math.max(72, height * 0.15);
    const bottom = height - Math.max(140, height * 0.2);
    if (right <= left || bottom <= top) return;
    // 地図が回転していても、見えている四隅を含む経緯度の矩形にする
    const corners = [
      map.unproject([left, top]),
      map.unproject([right, top]),
      map.unproject([right, bottom]),
      map.unproject([left, bottom]),
    ];
    const lons = corners.map((c) => c.lng);
    const lats = corners.map((c) => c.lat);
    onSelectDone(bboxFromPoints([Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]));
  }, [map, onSelectDone]);

  const beginSelect = useCallback(() => {
    reset();
    setHighlight(NO_HIGHLIGHT);
    hidOverlayRef.current = false;
    setBbox(null);
    setSearchOpen(false);
    setMode('selecting');
  }, [reset]);

  const cancelSelect = useCallback(() => {
    reset();
    setHighlight(NO_HIGHLIGHT);
    hidOverlayRef.current = false;
    setBbox(null);
    setMode('idle');
  }, [reset]);

  const runAnalysis = useCallback(() => {
    if (!bbox || !map) return;
    const wide = window.matchMedia('(min-width: 1024px)').matches;
    const landscape = window.matchMedia(LANDSCAPE_PHONE).matches;
    // PC 以外では結果のパネルが検索パネルと重なるので、検索は閉じて結果を見せる
    if (!wide) setSearchOpen(false);
    setMode('report');
    setOverlayOn(true);
    setHighlight(NO_HIGHLIGHT);
    hidOverlayRef.current = false;
    void start(bbox);
    // 結果のパネル（PC と横向きのスマホは右、縦向きのスマホは下のシート）に隠れない位置へ、
    // 選んだ範囲を寄せる。余白には、枠の外に付く座標・寸法のラベルと、検索タブ・地図の操作ボタンの分も含める
    const { innerWidth: w, innerHeight: h } = window;
    const padding = wide
      ? { top: 72, bottom: 120, left: searchOpen ? 360 + 64 : 64, right: 440 + 64 }
      : landscape
        ? { top: 48, bottom: 72, left: 56, right: Math.min(360, w * 0.46) + 24 + 64 }
        : { top: 96, bottom: Math.round(h * 0.62) + 56, left: 56, right: 72 };
    map.fitBounds(bbox, { padding: fitPadding(padding, w, h), maxZoom: 18, bearing: map.getBearing(), duration: 600 });
  }, [bbox, map, start, searchOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (mode === 'selecting' || mode === 'selected')) cancelSelect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, cancelSelect]);

  // ---- 土地被覆を地図に重ねる ----------------------------------------------------------
  const overlayUrl = analysis.landCover?.overlayUrl ?? null;
  // 区分を選んでいれば、その色だけを残した絵（写真と地図で同じものを使う）
  const overlaySrc = useClassOverlay(overlayUrl, analysis.landCover?.classes ?? NO_CLASSES, highlight.classes);
  const filtering = highlight.classes.length > 0;
  useEffect(() => {
    if (!map || !overlayUrl || !analysis.bbox) return;
    const [w, s, e, n] = analysis.bbox;
    map.addSource('landcover', {
      type: 'image',
      url: overlayUrl,
      coordinates: [[w, n], [e, n], [e, s], [w, s]],
    });
    // 区画の枠より下に置く
    map.addLayer(
      { id: 'landcover', type: 'raster', source: 'landcover', paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0 } },
      map.getLayer('objects-fill') ? 'objects-fill' : undefined,
    );
    return () => {
      if (map.getLayer('landcover')) map.removeLayer('landcover');
      if (map.getSource('landcover')) map.removeSource('landcover');
    };
  }, [map, overlayUrl, analysis.bbox]);

  useEffect(() => {
    const src = map?.getSource('landcover') as ImageSource | undefined;
    if (src && overlaySrc && src.url !== overlaySrc) src.updateImage({ url: overlaySrc });
  }, [map, overlaySrc, overlayUrl]);

  useEffect(() => {
    if (!map?.getLayer('landcover')) return;
    map.setLayoutProperty('landcover', 'visibility', overlayOn ? 'visible' : 'none');
    // 色を絞ったときは、残した色が写真に埋もれないよう濃くする
    map.setPaintProperty('landcover', 'raster-opacity', filtering ? 0.8 : 0.55);
  }, [map, overlayOn, overlayUrl, filtering]);

  // AI が答えの中心に挙げた区画を、地図の上で枠で囲み、範囲の残りを暗くする（写真の側と同じ見せ方）
  useEffect(() => {
    if (!map) return;
    const data = highlight.region && analysis.bbox ? focusFeatures(analysis.bbox, regionBBox(analysis.bbox, highlight.region)) : EMPTY;
    const src = map.getSource('focus') as GeoJSONSource | undefined;
    if (src) {
      src.setData(data);
      return;
    }
    map.addSource('focus', { type: 'geojson', data });
    // 建物などの形（AI の答えで示すもの）。土地被覆の上、暗くする部分の下に置く（写真の側と同じ重なり）
    map.addSource('objects', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'objects-fill', type: 'fill', source: 'objects', paint: { 'fill-color': OBJECT_COLOR, 'fill-opacity': 0.3 } });
    map.addLayer({ id: 'objects-line', type: 'line', source: 'objects', paint: { 'line-color': OBJECT_COLOR, 'line-width': 1.25 } });
    map.addLayer({
      id: 'focus-mask', type: 'fill', source: 'focus', filter: ['==', ['get', 'part'], 'mask'],
      paint: { 'fill-color': '#0d1418', 'fill-opacity': 0.45 },
    });
    // 写真の上でも見えるよう、白い縁の上に色の線を引く
    const outline: FilterSpecification = ['==', ['get', 'part'], 'outline'];
    map.addLayer({ id: 'focus-halo', type: 'line', source: 'focus', filter: outline, paint: { 'line-color': '#fff', 'line-width': 5, 'line-opacity': 0.85 } });
    map.addLayer({ id: 'focus-line', type: 'line', source: 'focus', filter: outline, paint: { 'line-color': SURVEY, 'line-width': 2.5 } });
  }, [map, highlight.region, analysis.bbox]);

  useEffect(() => {
    (map?.getSource('objects') as GeoJSONSource | undefined)?.setData(highlight.objects?.geojson ?? EMPTY);
  }, [map, highlight.objects]);

  const onClassesChange = useCallback((classes: string[]) => {
    setHighlight((h) => ({ ...h, classes }));
    if (classes.length) setOverlayOn(true);
  }, []);
  const onShowHighlight = useCallback((h: Highlight) => {
    setHighlight(h);
    if (h.classes.length) {
      hidOverlayRef.current = false;
      setOverlayOn(true);
    } else if (h.objects) {
      // 建物の形を描くときは、土地被覆の色を消して形を見やすくする（「重ねる」に印を付ければ戻せる）
      setOverlayOn((on) => {
        if (on) hidOverlayRef.current = true;
        return false;
      });
    } else if (hidOverlayRef.current) {
      hidOverlayRef.current = false;
      setOverlayOn(true);
    }
  }, []);
  const onClearHighlight = useCallback(() => {
    setHighlight(NO_HIGHLIGHT);
    if (hidOverlayRef.current) {
      hidOverlayRef.current = false;
      setOverlayOn(true);
    }
  }, []);
  // 重ね絵を消したら、色の絞り込みもやめる（見えない色を「表示しています」と言わないため）
  const onOverlayChange = useCallback((on: boolean) => {
    // 利用者が自分で切り替えたら、自動で消した記録は捨てる
    hidOverlayRef.current = false;
    setOverlayOn(on);
    if (!on) setHighlight((h) => ({ ...h, classes: [] }));
  }, []);

  // 選んだ範囲を GeoJSON でも持っておく（地図の当たり判定やテストに使う）
  useEffect(() => {
    if (!map) return;
    const data = bbox ? bboxToPolygon(bbox) : EMPTY;
    const src = map.getSource('selection') as GeoJSONSource | undefined;
    if (src) src.setData(data);
    else map.addSource('selection', { type: 'geojson', data });
  }, [map, bbox]);

  const choice = bbox ? chooseZoom(bbox) : null;
  const reportOpen = mode === 'report';

  return (
    <main className={`fixed inset-0 ${reportOpen ? 'has-report' : ''} ${searchOpen ? 'search-open' : ''}`}>
      <h1 className="sr-only">空中写真 AI 判読</h1>
      {/* MapLibre の CSS（.maplibregl-map { position: relative }）はレイヤー外なので、Tailwind の
          absolute より強い。高さが 0 にならないよう、位置は style で直接与える */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />

      {map && bbox && (
        <SelectionFrame map={map} bbox={bbox} scanning={analysis.status === 'running'} />
      )}

      <SearchPanel
        open={searchOpen}
        onOpenChange={setSearchOpen}
        onSelect={onSelectPlace}
        selectedId={selectedPlace?.id ?? null}
        initialQuery={initialQuery}
      />

      <SelectBar
        mode={mode}
        choice={choice}
        disabled={!map}
        hiddenOnMobile={reportOpen}
        searchOpen={searchOpen}
        onBegin={beginSelect}
        onSelectView={selectView}
        onCancel={cancelSelect}
        onAnalyze={runAnalysis}
      />

      {reportOpen && (
        <ReportPanel
          state={analysis}
          overlayOn={overlayOn}
          onOverlayChange={onOverlayChange}
          overlaySrc={overlaySrc}
          highlight={highlight}
          onClassesChange={onClassesChange}
          onShowHighlight={onShowHighlight}
          onClearHighlight={onClearHighlight}
          onClose={cancelSelect}
          onRetry={runAnalysis}
          concealOnMobile={searchOpen}
        />
      )}
    </main>
  );
}
