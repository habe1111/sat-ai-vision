/**
 * 注釈ページ（/dev/annotate）の動作確認。next dev で動かしているときだけ使える。
 *
 *   BASE_URL=http://localhost:3000 npm run annotate:smoke
 *
 * 船・車の地点のチップで、点・枠を足す → 保存 → 元に戻す → 保存、などをなぞる。
 * 試す前に全チップの中身を控え、最後にそのまま書き戻す（注釈データは変えない）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT = process.env.OUT_DIR || 'e2e-out';
const CHIP_DIR = path.join(process.cwd(), 'data', 'annotations', 'chips');

const fail = (msg) => { throw new Error(msg); };
const readChip = async (id) => JSON.parse(await fs.readFile(path.join(CHIP_DIR, `${id}.json`), 'utf8'));

const list = await (await fetch(`${BASE}/api/dev/annotate`)).json();
const shipChip = list.chips.find((c) => list.sites.find((s) => s.id === c.site)?.focus === 'ship');
const carChip = list.chips.find((c) => list.sites.find((s) => s.id === c.site)?.focus === 'car');
if (!shipChip || !carChip) fail('船と車の地点のチップが要ります。先に npm run annotate:prepare を実行してください。');
// 試す前の中身。最後にこのまま書き戻す（Enter で次のチップへ移るので、全チップを控える）
const backups = new Map();
for (const f of (await fs.readdir(CHIP_DIR)).filter((n) => n.endsWith('.json'))) {
  backups.set(f, await fs.readFile(path.join(CHIP_DIR, f), 'utf8'));
}
// 壊れたファイルを知らせることの確認用（存在しないタイルの番号。最後に消す）
const BROKEN = '18-0-0.json';

await fs.mkdir(OUT, { recursive: true });
const browser = await puppeteer.launch({ executablePath: CHROME_PATH, headless: true, defaultViewport: { width: 1440, height: 900 } });
const errors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const saved = () => page.waitForFunction(() => document.body.innerText.includes('保存しました'), { timeout: 10_000 });
  const svgBox = async () => (await page.$('svg[role="application"]')).boundingBox();
  const photoLoaded = () => page.waitForFunction(() => {
    const img = document.querySelector('img[alt*="空中写真"]');
    return img && img.complete && img.naturalWidth > 0;
  }, { timeout: 90_000 });

  // 壊れたファイルは一覧から外して知らせる（上書きしない）
  await fs.writeFile(path.join(CHIP_DIR, BROKEN), '{ "id": "18-0-0", ');
  // --- 車 ---
  // next dev は HMR の接続を開いたままにするので、networkidle では待てない。写真が出るまでを待つ
  await page.goto(`${BASE}/dev/annotate#${carChip.id}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await photoLoaded();
  await page.keyboard.press('2');
  await page.screenshot({ path: `${OUT}/annotate-1-car.png` });
  if (!(await page.evaluate((f) => document.body.innerText.includes(f), BROKEN))) fail('壊れたチップのファイルを知らせていません');
  if ((await fs.readFile(path.join(CHIP_DIR, BROKEN), 'utf8')) !== '{ "id": "18-0-0", ') fail('壊れたファイルが書き換わりました');
  await fs.rm(path.join(CHIP_DIR, BROKEN));
  console.log('✓ 壊れたチップのファイルを、上書きせずに知らせた');
  const before = await readChip(carChip.id);
  let box = await svgBox();
  // 左上の隅（候補の無さそうな所）に点を打つ
  await page.mouse.click(box.x + 6, box.y + 6);
  await saved();
  let after = await readChip(carChip.id);
  const added = after.objects.filter((o) => !before.objects.some((b) => b.id === o.id));
  if (added.length !== 1 || added[0].kind !== 'car' || added[0].source !== 'human' || added[0].status !== 'accepted') {
    fail(`点を打っても、人の付けた確定の点が 1 つ増えませんでした：${JSON.stringify(added)}`);
  }
  console.log('✓ 車：クリックで点を打ち、保存された');

  // 元に戻す（⌘Z）
  await page.keyboard.down('Meta'); await page.keyboard.press('z'); await page.keyboard.up('Meta');
  await page.waitForFunction(() => document.body.innerText.includes('保存中') || document.body.innerText.includes('保存待ち'), { timeout: 3000 }).catch(() => {});
  await saved();
  after = await readChip(carChip.id);
  if (after.objects.length !== before.objects.length) fail('元に戻しても、点が残っています');
  console.log('✓ 車：元に戻すと点が消え、保存された');

  // Shift + ドラッグで囲んで選ぶ
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  const picked = await page.$eval('section[aria-label="選んでいる注釈"] h2', (h) => Number(h.textContent.replace(/\D/g, '')));
  const inside = before.objects.filter((o) => o.kind === 'car' && o.x >= 153.6 && o.x <= 358.4 && o.y >= 153.6 && o.y <= 358.4).length;
  if (Math.abs(picked - inside) > 2) fail(`囲んで選んだ数（${picked}）が、囲みの中の点の数（${inside}）と合いません`);
  await page.screenshot({ path: `${OUT}/annotate-2-marquee.png` });
  console.log(`✓ 車：Shift + ドラッグで ${picked} 件を選んだ`);
  await page.keyboard.press('Escape');

  // すべて選んでから 1 つをクリックすると、その 1 つだけの選択になる（全部を選んだまま消さない）
  const one = before.objects.find((o) => o.kind === 'car');
  if (one) {
    await page.keyboard.down('Shift'); await page.keyboard.press('KeyA'); await page.keyboard.up('Shift');
    await page.mouse.click(box.x + (one.x / 512) * box.width, box.y + (one.y / 512) * box.height);
    const n = await page.$eval('section[aria-label="選んでいる注釈"] h2', (h) => Number(h.textContent.replace(/\D/g, '')));
    if (n !== 1) fail(`すべて選んだ後に 1 つをクリックしても、選択が 1 件になりません（${n} 件）`);
    await page.keyboard.press('Escape');
    console.log('✓ 車：すべて選んだ後に 1 つをクリックすると、それだけを選んだ');
  }

  // --- 船 ---
  // 一覧から移る（# だけを変えても読み込み直さない）
  await page.click(`nav button[data-chip="${shipChip.id}"]`);
  await page.waitForFunction((id) => document.querySelector('img[alt*="空中写真"]')?.alt.includes(id), { timeout: 30_000 }, shipChip.id);
  await photoLoaded();
  await page.keyboard.press('1');
  const shipBefore = await readChip(shipChip.id);
  box = await svgBox();
  const zoom = box.width / 512;
  // 左上の隅に、右下へ 40 px の線を引いて枠を作る
  await page.mouse.move(box.x + 10 * zoom, box.y + 10 * zoom);
  await page.mouse.down();
  await page.mouse.move(box.x + 50 * zoom, box.y + 10 * zoom, { steps: 6 });
  await page.mouse.up();
  await saved();
  let ship = (await readChip(shipChip.id)).objects.find((o) => !shipBefore.objects.some((b) => b.id === o.id));
  if (!ship || ship.kind !== 'ship' || Math.abs(ship.length - 40) > 1.5 || Math.abs(ship.angle) > 0.05) {
    fail(`線を引いて作った枠が正しくありません：${JSON.stringify(ship)}`);
  }
  console.log('✓ 船：ドラッグで枠を作り、保存された');

  // 端の取っ手を下へ動かして、向きを変える
  const handle = await page.$('[data-handle="end0"]');
  const hb = await handle.boundingBox();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
  await page.mouse.down();
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2 + 40 * zoom, { steps: 6 });
  await page.mouse.up();
  await saved();
  ship = (await readChip(shipChip.id)).objects.find((o) => o.id === ship.id);
  if (!ship || Math.abs(ship.angle) < 0.5) fail(`取っ手を動かしても向きが変わりません：${JSON.stringify(ship)}`);
  await page.screenshot({ path: `${OUT}/annotate-3-ship.png` });
  console.log('✓ 船：端の取っ手で向きが変わった');

  // 端の取っ手を写真の外まで引いても、受け付ける範囲に収めて保存できる
  const h2 = await (await page.$('[data-handle="end0"]')).boundingBox();
  await page.mouse.move(h2.x + h2.width / 2, h2.y + h2.height / 2);
  await page.mouse.down();
  await page.mouse.move(h2.x + 2000, h2.y + 1500, { steps: 6 });
  await page.mouse.up();
  await saved();
  ship = (await readChip(shipChip.id)).objects.find((o) => o.id === ship.id);
  if (!ship || ship.length > 768) fail(`写真の外まで引いた枠が範囲に収まっていません：${JSON.stringify(ship)}`);
  console.log('✓ 船：写真の外まで引いても範囲に収めて保存した');

  // 選んだまま Delete で消す
  await page.keyboard.press('Delete');
  await saved();
  if ((await readChip(shipChip.id)).objects.some((o) => o.id === ship.id)) fail('Delete で枠が消えません');
  console.log('✓ 船：Delete で消え、保存された');

  // Enter を押し続けても、確認済みにして進むのは 1 枚だけ（キーリピートで見ていないチップを確認済みにしない）
  const reviewedBefore = new Set(list.chips.filter((c) => c.reviewed.ship).map((c) => c.id));
  await page.keyboard.down('Enter');
  for (let i = 0; i < 8; i++) await page.keyboard.down('Enter', { autoRepeat: true });  // 押し続けたときのキーリピート
  await page.keyboard.up('Enter');
  await page.waitForFunction((id) => !document.querySelector('img[alt*="空中写真"]')?.alt.includes(id), { timeout: 10_000 }, shipChip.id);
  await photoLoaded();
  await new Promise((r) => setTimeout(r, 1500));
  const after2 = await (await fetch(`${BASE}/api/dev/annotate`)).json();
  const newly = after2.chips.filter((c) => c.reviewed.ship && !reviewedBefore.has(c.id)).map((c) => c.id);
  if (newly.length !== 1 || newly[0] !== shipChip.id) fail(`Enter を押し続けたら、確認済みになったチップが ${newly.length} 枚でした（${newly.join(', ')}）`);
  console.log('✓ Enter を押し続けても、確認済みにして進むのは 1 枚だけ');
  // 元のチップへ戻って、次の確認を続ける
  await page.click(`nav button[data-chip="${shipChip.id}"]`);
  await page.waitForFunction((id) => document.querySelector('img[alt*="空中写真"]')?.alt.includes(id), { timeout: 30_000 }, shipChip.id);
  await photoLoaded();

  // 横からの書き換え（Claude の下付けなど）があれば、上書きせずに知らせる
  const raw = await readChip(shipChip.id);
  await fs.writeFile(path.join(CHIP_DIR, `${shipChip.id}.json`), JSON.stringify({ ...raw, updatedAt: new Date().toISOString() }));
  // 先ほど枠を作って消した左上の空いた所に、もう一度枠を作る（写真の下の方は画面の外になる）
  await page.mouse.move(box.x + 10 * zoom, box.y + 10 * zoom);
  await page.mouse.down();
  await page.mouse.move(box.x + 40 * zoom, box.y + 10 * zoom, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.body.innerText.includes('ほかの所で書き換わりました'), { timeout: 10_000 });
  console.log('✓ 横から書き換わっていたら、上書きせずに知らせた');

  // 409 は、横から書き換えた確認でわざと起こしたもの
  const unexpected = errors.filter((e) => !e.includes('409'));
  if (unexpected.length) fail(`ページでエラーが出ました：\n${unexpected.join('\n')}`);
} finally {
  await browser.close();
  for (const [f, text] of backups) await fs.writeFile(path.join(CHIP_DIR, f), text);
  await fs.rm(path.join(CHIP_DIR, BROKEN), { force: true });
}
console.log('注釈ページの確認を終えました（チップは元の中身に戻しました）');
