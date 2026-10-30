import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import Annotator from '@/components/annotate/Annotator';

export const metadata: Metadata = {
  title: '注釈（開発用） | sat_ai_vision',
  robots: { index: false },
};

/** 船・車の注釈ページ。公開した画面には出さない（API も next dev でしか答えない） */
export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return <Annotator />;
}
