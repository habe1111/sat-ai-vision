import type { Metadata, Viewport } from 'next';
import { BIZ_UDPGothic } from 'next/font/google';
import 'maplibre-gl/dist/maplibre-gl.css';
import './globals.css';

// 公文書や地図の注記にも使われるユニバーサルデザイン書体。数字の判読性が高い
const ui = BIZ_UDPGothic({
  weight: ['400', '700'],
  subsets: ['latin'],
  variable: '--font-ui',
  display: 'swap',
});

export const metadata: Metadata = {
  title: '空中写真 AI 判読 | sat_ai_vision',
  description: '地図で範囲を選ぶと、その範囲の空中写真を手元のサーバーで解析し、写っているものを AI が説明します。',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#14212B',
};

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="ja" className={ui.variable}>
      <body>{children}</body>
    </html>
  );
}
