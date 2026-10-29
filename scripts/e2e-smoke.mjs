/**
 * 画面を実際に動かして確かめるスモークテスト（headless Chrome）。
 *
 *   npm run dev            # 別のターミナルで起動しておく
 *   npm run e2e            # BASE_URL・CHROME_PATH・OUT_DIR で上書きできる
 *   VIEWPORT=mobile / landscape でスマホの縦・横。REQUIRE_AI=1 で AI の所見が出なければ失敗にする
 *
 * 確かめること：地図が出る → 検索して結果を選ぶと URL が移動先を指す → 範囲をドラッグで選ぶ →
 * 解析の結果（写真・土地被覆、AI が使えれば所見）が出る → 土地被覆の区分を押すとその色だけになる →
 * AI に質問すると答えが出て、写真と地図に示される。各段のスクショを OUT_DIR に残す。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = process.env.OUT_DIR || 'e2e-out';
const VIEWPORTS = {
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1 },
  mobile: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  landscape: { width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};
const VIEWPORT = VIEWPORTS[process.env.VIEWPORT || 'desktop'];
const WAIT_AI = process.env.WAIT_AI !== '0';

fs.mkdirSync(OUT_DIR, { recursive: true });
const shot = (page, name) => page.screenshot({ path: path.join(OUT_DIR, `${process.env.VIEWPORT || 'desktop'}-${name}.png`) });
const fail = (msg) => { console.error(`✗ ${msg}`); process.exitCode = 1; };
const ok = (msg) => console.log(`✓ ${msg}`);

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__map?.loaded() && window.__map.areTilesLoaded(), { timeout: 30000 });
  ok('地図（空中写真）が表示された');
  await shot(page, '1-map');

  // 検索：タブを開いて姫路城を探し、結果を選ぶ
  await page.click('button[aria-controls="search-panel"]');
  await page.type('#place-query', '姫路城');
  await page.keyboard.press('Enter');
  await page.waitForSelector('#search-panel li button', { timeout: 20000 });
  await shot(page, '2-search');
  await page.click('#search-panel li button');
  await page.waitForFunction(() => /#map=1[67](\.\d+)?\/34\.8/.test(location.hash), { timeout: 15000 });
  ok(`検索結果を選ぶと URL が移動先を指した（${await page.evaluate(() => location.hash)}）`);
  if (!(await page.evaluate(() => new URL(location.href).searchParams.get('q')))) fail('検索語が URL に残っていない');
  await page.waitForFunction(() => window.__map.areTilesLoaded(), { timeout: 30000 });
  await new Promise((r) => setTimeout(r, 800));
  await shot(page, '3-place');

  // 範囲選択：画面中央付近をドラッグ
  if (await page.$('#search-panel:not([hidden])')) await page.click('button[aria-controls="search-panel"]');
  const btn = await page.waitForSelector('xpath/.//button[contains(., "範囲を選んで解析")]');
  await btn.click();
  const { width, height } = VIEWPORT;
  // スマホは画面が狭いので、一辺 60 m 以上になるよう幅いっぱいに近くなぞる
  const [fx0, fx1] = VIEWPORT.width < 600 ? [0.12, 0.88] : [0.38, 0.62];
  // 横向きのスマホは背が低いので、縦も広くなぞる
  const [fy0, fy1] = height < 600 ? [0.15, 0.7] : [0.3, 0.6];
  const x0 = width * fx0, y0 = height * fy0, x1 = width * fx1, y1 = height * fy1;
  if (VIEWPORT.hasTouch) {
    // スマホは指でなぞる（タッチの Pointer Events で選べることを確かめる）
    await page.touchscreen.touchStart(x0, y0);
    for (let i = 1; i <= 10; i++) await page.touchscreen.touchMove(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
    await page.touchscreen.touchEnd();
  } else {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 10, y0 + ((y1 - y0) * i) / 10);
    await page.mouse.up();
  }
  await page.waitForSelector('xpath/.//button[contains(., "この範囲を解析")]', { timeout: 5000 });
  ok('ドラッグで範囲を選べた');
  await shot(page, '4-selected');

  const analyze = await page.$('xpath/.//button[contains(., "この範囲を解析")]');
  await analyze.click();
  await page.waitForSelector('xpath/.//h3[contains(., "土地被覆の構成")]', { timeout: 120000 });
  await page.waitForFunction(
    () => [...document.querySelectorAll('aside img')].every((i) => i.complete && i.naturalWidth > 0),
    { timeout: 15000 },
  );
  ok('写真と土地被覆が出た');
  const hasLayer = await page.evaluate(() => Boolean(window.__map.getLayer('landcover')));
  if (hasLayer) ok('土地被覆を地図に重ねた');
  else fail('土地被覆のレイヤーが地図に無い');
  await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  await shot(page, '5-landcover');

  if (WAIT_AI) {
    await page.waitForSelector('xpath/.//h3[contains(., "AI の所見")]', { timeout: 300000 });
    const none = await page.$('xpath/.//h3[contains(., "AI の所見はありません")]');
    if (!none) ok('AI の所見が出た');
    else if (process.env.REQUIRE_AI === '1') fail('AI の所見が出なかった');
    else ok('AI の所見を出せない理由が表示された');
    await shot(page, '6-report');
    // 所見はパネルの下の方にあるので、見出しまでスクロールしてもう 1 枚
    await page.evaluate(() => {
      const h = [...document.querySelectorAll('aside h3')].find((e) => e.textContent.startsWith('AI の所見'));
      h?.scrollIntoView({ block: 'start' });
    });
    await new Promise((r) => setTimeout(r, 300));
    await shot(page, '7-ai');

    // 解析の流れ：3 段とも終わり、かかった時間が出ている。前の結果を使い回したときだけ「前回の結果」でよい
    const times = await page.$$eval('section[aria-labelledby="timeline-heading"] li', (lis) => lis.map((li) => li.textContent));
    const reused = await page.$('xpath/.//aside//p[contains(., "以前に解析した結果")]');
    const want = reused ? /\d 秒|前回の結果/ : /\d 秒/;
    // AI を使えないときは 3 段目が「行えず」になるので、時間を見るのは前の 2 段だけ
    const checked = none ? times.slice(0, 2) : times;
    if (times.length === 3 && checked.every((t) => want.test(t))) ok(`解析の流れに段ごとの時間が出た（${times.join(' / ')}）`);
    else fail(`解析の流れの表示が足りない: ${JSON.stringify(times)}`);

    // 土地被覆の区分を押すと、その色だけを残した絵に替わる。「すべての色を表示」で戻る
    const srcUrl = () => page.evaluate(() => window.__map.getSource('landcover')?.url ?? '');
    const firstClass = await page.$('section[aria-labelledby="landcover-heading"] button[aria-pressed]');
    await firstClass.evaluate((b) => b.scrollIntoView({ block: 'center' }));
    await firstClass.click();
    await page.waitForFunction(() => window.__map.getSource('landcover')?.url.startsWith('blob:'), { timeout: 10000 });
    if (await firstClass.evaluate((b) => b.getAttribute('aria-pressed') === 'true')) ok('区分を押すと、その色だけを写真と地図に出した');
    else fail('押した区分が選ばれた状態にならない');
    await page.waitForFunction(() => [...document.querySelectorAll('aside img')].every((i) => i.complete && i.naturalWidth > 0));
    await new Promise((r) => setTimeout(r, 400));
    await shot(page, '8-class');
    const all = await page.$('xpath/.//button[contains(., "すべての色を表示")]');
    await all.click();
    await page.waitForFunction(() => !window.__map.getSource('landcover')?.url.startsWith('blob:'), { timeout: 5000 });
    if (!(await srcUrl()).startsWith('blob:')) ok('「すべての色を表示」で元の重ね絵に戻った');

    // AI に質問する（例の質問を押す）。答えと、示す区分・区画が出る
    if (!none) {
      const sample = await page.waitForSelector('xpath/.//section[@aria-labelledby="ask-heading"]//button[contains(., "右下")]');
      await sample.evaluate((b) => b.scrollIntoView({ block: 'center' }));
      await sample.click();
      await page.waitForSelector('xpath/.//section[@aria-labelledby="ask-heading"]/ol/li[.//li[contains(., "確かめたこと")] or .//*[@role="alert"]]', { timeout: 300000 });
      const err = await page.$('section[aria-labelledby="ask-heading"] [role="alert"]');
      if (err) fail(`質問に答えられなかった：${await err.evaluate((e) => e.textContent)}`);
      else ok('AI が質問に答えた');
      const focus = await page.evaluate(async () => (await window.__map.getSource('focus')?.getData())?.features?.length ?? 0);
      if (focus) ok('答えの区画を地図に枠で示した');
      else fail('答えの区画が地図に出ていない');
      await page.evaluate(() => document.querySelector('section[aria-labelledby="ask-heading"] li:last-child')?.scrollIntoView({ block: 'end' }));
      await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), { timeout: 15000 });
      await new Promise((r) => setTimeout(r, 500));
      await shot(page, '9-ask');
      // 写真（と区画の枠）の位置まで戻してもう 1 枚
      await page.evaluate(() => document.querySelector('aside figure')?.scrollIntoView({ block: 'start' }));
      await new Promise((r) => setTimeout(r, 300));
      await shot(page, '10-ask-photo');
    }
  }
  if (errors.length) fail(`ブラウザのエラー:\n  ${errors.join('\n  ')}`);
} catch (e) {
  fail(e.message);
} finally {
  await browser.close();
}
