/**
 * 注釈のチップを作り、自動の候補を出す。開発サーバー（next dev）の API を呼ぶ。
 *
 *   BASE_URL=http://localhost:3000 npm run annotate:prepare              # sites.json の全地点
 *   BASE_URL=http://localhost:3000 npm run annotate:prepare -- yaizu     # 地点を選ぶ
 *   REDO=1 …                                                              # 人が手を付けていない種類だけ、自動の候補を出し直す
 *
 * すでにあるチップの注釈は消さない（人が付けた・確定したものがある種類には、REDO でも候補を足さない）。写真は地理院のタイルを取るので、1 地点（9 枚）ずつ順に進める。
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const redo = process.env.REDO === '1';

const list = await fetch(`${BASE}/api/dev/annotate`);
if (!list.ok) {
  console.error(`一覧を取れませんでした（${list.status}）。next dev で動かしているか確かめてください。`);
  process.exit(1);
}
const { sites } = await list.json();
const wanted = process.argv.slice(2);
const targets = wanted.length ? sites.filter((s) => wanted.includes(s.id)) : sites;
const unknown = wanted.filter((w) => !sites.some((s) => s.id === w));
if (unknown.length) {
  console.error(`地点が見つかりません：${unknown.join(', ')}`);
  process.exit(1);
}

for (const site of targets) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/dev/annotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ site: site.id, redo }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error(`${site.name}：失敗しました（${body.error ?? res.status}）`);
    process.exitCode = 1;
    continue;
  }
  const made = body.results.filter((r) => !r.skipped);
  const candidates = made.reduce((n, r) => n + r.candidates, 0);
  const skipped = body.results.filter((r) => r.skipped).map((r) => `${r.id}（${r.skipped}）`);
  console.log(`${site.name}：${made.length} 枚・候補 ${candidates} 件（${((performance.now() - t0) / 1000).toFixed(1)} 秒）`
    + (skipped.length ? `　飛ばした：${skipped.join('、')}` : ''));
}
