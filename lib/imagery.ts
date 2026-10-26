/**
 * 背景の写真（国土地理院「全国最新写真（シームレス）」）の定義。
 *
 * **このプロバイダを選んだ理由**：Google・Esri・Mapbox・MapTiler の高解像度画像は、どれも
 * 利用規約で「画像解析・AI による判読」と「表示以外の目的でのタイル取得・結合」を禁じている
 * （2026-10 に各社の一次資料で確認）。地理院タイルは公共データ利用規約（PDL1.0）で、
 * 出典を示せば加工・解析を含めて自由に使える。日本国内なら z18（約 0.5 m/px）まである。
 *
 * 同じ URL でもズームによって中身が変わり、出典の示し方もそれぞれ指定されている
 * （https://maps.gsi.go.jp/development/ichiran.html の「写真」）。そこで地図では
 * ズーム帯ごとにソースを分け、いま見えている画像の出典だけが出るようにしている。
 */

export const GSI_TILE_URL = 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg';
export const GSI_LIST_URL = 'https://maps.gsi.go.jp/development/ichiran.html';

/** 空中写真がある最大ズーム。z19 は 404 を返す */
export const IMAGERY_MAX_ZOOM = 18;
/** 解析に使う空中写真の最小ズーム。これより下は衛星モザイクで粗すぎる */
export const IMAGERY_PHOTO_MIN_ZOOM = 14;

const GSI = `<a href="${GSI_LIST_URL}" target="_blank" rel="noopener">国土地理院</a>`;

export const IMAGERY_BANDS = [
  {
    id: 'world',
    minzoom: 2,
    maxzoom: 9,
    attribution:
      `${GSI}（世界衛星モザイク画像：NASA LP DAAC / USGS EROS Center）`,
  },
  {
    id: 'landsat',
    minzoom: 9,
    maxzoom: 14,
    attribution:
      `${GSI}（Landsat8画像（GSI,TSIC,GEO Grid/AIST）, Landsat8画像（courtesy of the U.S. Geological Survey）, 海底地形（GEBCO））`,
  },
  {
    id: 'photo',
    minzoom: 14,
    maxzoom: IMAGERY_MAX_ZOOM + 1,
    attribution: `${GSI}（全国最新写真（シームレス））`,
  },
] as const;

/** 解析結果に添える出典。加工したものであることも示す（PDL1.0 の求め） */
export const ANALYSIS_CREDIT =
  '空中写真：国土地理院「全国最新写真（シームレス）」を加工して作成';

export function tileUrl(z: number, x: number, y: number): string {
  return GSI_TILE_URL.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}
