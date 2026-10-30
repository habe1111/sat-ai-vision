/**
 * 注釈の API は開発中（next dev）の手元でだけ使う。公開した画面からは、写真の取得や
 * ファイルの書き込みを起こせないようにする
 */
export const DEV_ONLY = process.env.NODE_ENV === 'development';

export function notFound(): Response {
  return new Response('Not found', { status: 404 });
}
