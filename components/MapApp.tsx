'use client';
/**
 * 画面全体。開くといきなり地図（空中写真）が出る。ログインは無い。
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
  type GeoJSONSource,
  type StyleSpecification,
} from 'maplibre-gl';
import { type BBox, bboxToPolygon } from '@/lib/geo';
import { GSI_TILE_URL, IMAGERY_BANDS, IMAGERY_MAX_ZOOM } from '@/lib/imagery';
import { chooseZoom } from '@/lib/selection';
import type { Place } from '@/lib/types';
import { useAnalysis } from '@/lib/client/useAnalysis';
import { useAreaSelect } from '@/lib/client/useAreaSelect';
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

export default function MapApp({ initialQuery }: { initialQuery: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<MapLibreMap | null>(null);
  // ?q= 付きで開いたときは検索結果が見えるように、パネルを開いておく
  const [searchOpen, setSearchOpen] = useState(Boolean(initialQuery));
  const [selectedPlace, setSelectedPlace] = useState<Place | null>(null);
  const markerRef = useRef<Marker | null>(null);

  const [mode, setMode] = useState<Mode>('idle');
  const [bbox, setBbox] = useState<BBox | null>(null);
  const [overlayOn, setOverlayOn] = useState(true);
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
      m.remove();
    };
  }, []);

  // ---- 検索結果を選んだとき ---------------------------------------------------------
  const onSelectPlace = useCallback(
    (p: Place) => {
      if (!map) return;
      setSelectedPlace(p);
      const el = document.createElement('div');
      el.className = 'size-4 rounded-full border-[3px] border-white bg-[var(--survey)] shadow-[var(--shadow)]';
      markerRef.current?.remove();
      markerRef.current = new Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
      // 広い場所（市町村など）は範囲が収まるように、施設は写真の細部が見えるズームで
      const small = !p.bbox || (p.bbox[2] - p.bbox[0] < 0.01 && p.bbox[3] - p.bbox[1] < 0.01);
      if (small) map.flyTo({ center: [p.lon, p.lat], zoom: 17, bearing: 0, essential: true });
      else map.fitBounds(p.bbox!, { padding: 48, maxZoom: 17, bearing: 0, essential: true });
      // 画面の狭い端末では、地図が見えるようにパネルを閉じる
      if (window.matchMedia('(max-width: 639px)').matches) setSearchOpen(false);
    },
    [map],
  );

  // ---- 範囲選択 -------------------------------------------------------------------
  const onSelectChange = useCallback((b: BBox) => setBbox(b), []);
  const onSelectDone = useCallback((b: BBox | null) => {
    if (!b) return;          // ドラッグせずに離した
    setBbox(b);
    setMode('selected');
  }, []);
  useAreaSelect(map, mode === 'selecting', onSelectChange, onSelectDone);

  const beginSelect = useCallback(() => {
    reset();
    setBbox(null);
    setSearchOpen(false);
    setMode('selecting');
  }, [reset]);

  const cancelSelect = useCallback(() => {
    reset();
    setBbox(null);
    setMode('idle');
  }, [reset]);

  const runAnalysis = useCallback(() => {
    if (!bbox || !map) return;
    setMode('report');
    setOverlayOn(true);
    void start(bbox);
    // 結果のパネル（PC は右、スマホは下のシート）に隠れない位置へ、選んだ範囲を寄せる。
    // 余白には、枠の外に付く座標・寸法のラベルと、検索タブ・地図の操作ボタンの分も含める
    const wide = window.matchMedia('(min-width: 1024px)').matches;
    const padding = wide
      ? { top: 72, bottom: 120, left: 64, right: 440 + 64 }
      : { top: 96, bottom: Math.round(window.innerHeight * 0.62) + 56, left: 56, right: 72 };
    map.fitBounds(bbox, { padding, maxZoom: 18, bearing: map.getBearing(), duration: 600 });
  }, [bbox, map, start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && (mode === 'selecting' || mode === 'selected')) cancelSelect();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, cancelSelect]);

  // ---- 土地被覆を地図に重ねる ----------------------------------------------------------
  const overlayUrl = analysis.landCover?.overlayUrl ?? null;
  useEffect(() => {
    if (!map || !overlayUrl || !analysis.bbox) return;
    const [w, s, e, n] = analysis.bbox;
    map.addSource('landcover', {
      type: 'image',
      url: overlayUrl,
      coordinates: [[w, n], [e, n], [e, s], [w, s]],
    });
    map.addLayer({ id: 'landcover', type: 'raster', source: 'landcover', paint: { 'raster-opacity': 0.55, 'raster-fade-duration': 0 } });
    return () => {
      if (map.getLayer('landcover')) map.removeLayer('landcover');
      if (map.getSource('landcover')) map.removeSource('landcover');
    };
  }, [map, overlayUrl, analysis.bbox]);

  useEffect(() => {
    if (map?.getLayer('landcover')) map.setLayoutProperty('landcover', 'visibility', overlayOn ? 'visible' : 'none');
  }, [map, overlayOn, overlayUrl]);

  // 選んだ範囲を GeoJSON でも持っておく（地図の当たり判定やテストに使う）
  useEffect(() => {
    if (!map) return;
    const data = bbox ? bboxToPolygon(bbox) : { type: 'FeatureCollection' as const, features: [] };
    const src = map.getSource('selection') as GeoJSONSource | undefined;
    if (src) src.setData(data);
    else map.addSource('selection', { type: 'geojson', data });
  }, [map, bbox]);

  const choice = bbox ? chooseZoom(bbox) : null;
  const reportOpen = mode === 'report';

  return (
    <main className={`fixed inset-0 ${reportOpen ? 'has-report' : ''}`}>
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
        onBegin={beginSelect}
        onCancel={cancelSelect}
        onAnalyze={runAnalysis}
      />

      {reportOpen && (
        <ReportPanel
          state={analysis}
          overlayOn={overlayOn}
          onOverlayChange={setOverlayOn}
          onClose={cancelSelect}
          onRetry={runAnalysis}
        />
      )}
    </main>
  );
}
