import { Suspense } from 'react';
import MapApp from '@/components/MapApp';

/**
 * URL の ?q=（検索語）は要求ごとに変わるので、読む部分だけを Suspense で囲む。
 * こうすると画面の外枠は事前に作られ、地図の読み込みを待たせない。
 */
export default function Page({ searchParams }: PageProps<'/'>) {
  return (
    <Suspense fallback={null}>
      <MapWithQuery searchParams={searchParams} />
    </Suspense>
  );
}

async function MapWithQuery({ searchParams }: Pick<PageProps<'/'>, 'searchParams'>) {
  // ?q=姫路城 のようなリンクで開いたら、その語で検索した状態から始める
  const { q } = await searchParams;
  return <MapApp initialQuery={typeof q === 'string' ? q.slice(0, 100) : ''} />;
}
