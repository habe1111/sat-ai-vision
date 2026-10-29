/**
 * README の説明動画を撮る（headless Chrome で操作して録画し、ffmpeg で仕上げる）。
 *
 *   npm run dev && ollama serve   # 別のターミナルで起動しておく
 *   npm run demo                  # BASE_URL・CHROME_PATH・OUT_DIR で上書きできる
 *
 * 流れ：場所を絞り込んで検索 → 解析する範囲を選ぶ → 解析中 → 結果を確かめる → 区分ごとに表示 → AI に質問する。
 * 解析は実際の速さのまま写す。出力は OUT_DIR の demo.mp4 と、README に埋め込む demo.gif（GIF_FPS でコマ数を変えられる）。
 * 同じ範囲の解析結果が残っていると「解析中」が写らないので、前回撮った範囲のキャッシュだけは消してから撮る。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const CHROME_PATH = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const OUT_DIR = process.env.OUT_DIR || 'docs/media';
const VIEWPORT = { width: 1280, height: 800, deviceScaleFactor: 1 };
const GIF_FPS = Number(process.env.GIF_FPS || 12);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-demo-'));
const raw = path.join(work, 'raw.webm');
const LAST_ID = '.cache/demo-analysis-id';
if (fs.existsSync(LAST_ID)) {
  const id = fs.readFileSync(LAST_ID, 'utf8').trim();
  if (/^[0-9a-f]+$/.test(id)) fs.rmSync(path.join('.cache/analyses', id), { recursive: true, force: true });
}

/** 字幕と疑似カーソル（headless の録画にはマウスが写らないため）。地図の操作は邪魔しない */
function installOverlay() {
  const style = document.createElement('style');
  style.textContent = `
    #demo-cursor { position: fixed; z-index: 9999; left: 0; top: 0; width: 22px; height: 22px; pointer-events: none;
      transform: translate(-3px, -2px); transition: transform 80ms; }
    #demo-cursor.down { transform: translate(-3px, -2px) scale(0.85); }
    #demo-caption { position: fixed; z-index: 9998; top: 14px; pointer-events: none; max-width: 460px;
      padding: 8px 14px; border-radius: 8px; background: rgb(17 24 39 / 0.86); color: #fff;
      font: 600 19px/1.45 system-ui, sans-serif; box-shadow: 0 2px 8px rgb(0 0 0 / 0.3); transition: opacity 200ms; }
    #demo-caption small { display: block; font-weight: 400; font-size: 15px; opacity: 0.85; }`;
  document.head.append(style);
  const cursor = document.createElement('div');
  cursor.id = 'demo-cursor';
  cursor.innerHTML = '<svg viewBox="0 0 22 22" width="22" height="22"><path d="M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10 13 L16 13 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  const caption = document.createElement('div');
  caption.id = 'demo-caption';
  caption.style.opacity = '0';
  document.body.append(cursor, caption);
  const move = (e) => { cursor.style.left = `${e.clientX}px`; cursor.style.top = `${e.clientY}px`; };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerdown', (e) => { move(e); cursor.classList.add('down'); }, true);
  window.addEventListener('pointerup', () => cursor.classList.remove('down'), true);
  window.__caption = (title, sub, left) => {
    // 消すときは文字を残したまま薄くする（先に文字を消すと空の枠が一瞬写る）
    if (title) caption.innerHTML = `${title}${sub ? `<small>${sub}</small>` : ''}`;
    caption.style.opacity = title ? '1' : '0';
    caption.style.left = `${left}px`;
  };
}

const browser = await puppeteer.launch({
  executablePath: CHROME_PATH,
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'],
});
let recorder;
try {
  const page = await browser.newPage();
  await page.setViewport(VIEWPORT);
  // 撮り直しても同じ絵になるよう、福岡市の博多駅あたりから始める
  await page.goto(`${BASE_URL}/#map=16/33.5900/130.4207`, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__map?.loaded() && window.__map.areTilesLoaded(), { timeout: 30000 });
  // 検索で飛ぶ途中は一度縮小する。その写真を読み込んでいないと黒く写るので、録画の前に先読みしておく
  for (const zoom of [12, 13, 14]) {
    await page.evaluate((z) => window.__map.jumpTo({ center: [130.387, 33.592], zoom: z }), zoom);
    await page.waitForFunction(() => window.__map.areTilesLoaded(), { timeout: 30000 });
  }
  await page.evaluate(() => window.__map.jumpTo({ center: [130.4207, 33.59], zoom: 16 }));
  await page.waitForFunction(() => window.__map.areTilesLoaded(), { timeout: 30000 });
  await page.evaluate(installOverlay);
  const caption = (title, sub = '', left = 72) => page.evaluate((a, b, c) => window.__caption(a, b, c), title, sub, left);

  // マウスを人の速さで動かす（疑似カーソルが滑らかに動くように）
  let pos = { x: 640, y: 400 };
  const moveTo = async (x, y, steps = 18) => {
    await page.mouse.move(x, y, { steps });
    pos = { x, y };
  };
  const center = async (handle) => {
    const b = await handle.boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2];
  };
  const clickEl = async (handle) => {
    const [x, y] = await center(handle);
    await moveTo(x, y);
    await sleep(250);
    await page.mouse.down();
    await sleep(90);
    await page.mouse.up();
  };
  const clickText = async (text) => clickEl(await page.waitForSelector(`xpath/.//button[contains(., "${text}")]`));

  await moveTo(pos.x, pos.y, 1);
  recorder = await page.screencast({ path: raw, fps: 30, quality: 18 });
  await sleep(1200);

  // ① 絞り込み検索：広い語で探し、語を足して絞り込み、候補から選ぶ
  await caption('① 場所を検索', '地名やランドマークで探します');
  await clickEl(await page.$('button[aria-controls="search-panel"]'));
  await sleep(700);
  await caption('① 場所を検索', '「タワー」だと全国の候補が出ます', 400);
  await page.type('#place-query', 'タワー', { delay: 140 });
  await sleep(300);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#search-panel li button', { timeout: 20000 });
  await sleep(2200);
  await caption('① 語を足して絞り込む', '「福岡タワー」にすると候補が絞られます', 400);
  await clickEl(await page.$('#place-query'));
  await page.keyboard.press('Home');
  await page.type('#place-query', '福岡', { delay: 160 });
  await sleep(300);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#search-panel li button')?.textContent.includes('福岡タワー'), { timeout: 20000 });
  await sleep(1800);
  await caption('① 候補から選ぶ', '地図がその場所へ移ります', 400);
  await clickEl(await page.$('#search-panel li button'));
  await page.waitForFunction(() => /#map=1[5-8](\.\d+)?\/33\.59/.test(location.hash), { timeout: 15000 });
  await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), { timeout: 20000 });
  await sleep(1200);
  if (await page.$('#search-panel:not([hidden])')) await clickEl(await page.$('button[aria-controls="search-panel"]'));
  // 広め（一辺 1.5 km ほど）の範囲を選べるよう縮小する（MapLibre のズーム 15 で約 2 m/px）
  while (await page.evaluate(() => window.__map.getZoom() > 15.2)) {
    await clickEl(await page.$('.maplibregl-ctrl-zoom-out'));
    await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), { timeout: 20000 });
    await sleep(500);
  }
  await sleep(500);

  // ② 解析する範囲を選ぶ
  await caption('② 解析する範囲を選ぶ', '地図をドラッグして囲みます（スマホは指でなぞる）');
  await clickText('範囲を選んで解析');
  await sleep(900);
  const [x0, y0, x1, y1] = [250, 190, 1030, 610];
  await moveTo(x0, y0);
  await sleep(300);
  await page.mouse.down();
  await page.mouse.move(x1, y1, { steps: 45 });
  await page.mouse.up();
  await sleep(1300);
  await caption('② 解析する範囲を選ぶ', '大きさを確かめて「この範囲を解析」');
  await sleep(900);
  await clickText('この範囲を解析');

  // ③ 解析中：写真の取得 → 土地被覆 → AI の判読
  await caption('③ 解析中', '写真の取得 → 土地被覆 → AI の判読を、タイムラインで表示');
  await sleep(2500);
  await caption('③ 解析中', '手元のパソコンで処理しています');
  await page.waitForSelector('xpath/.//h3[contains(., "土地被覆の構成")]', { timeout: 300000 });
  await page.waitForSelector('xpath/.//h3[contains(., "AI の所見")]', { timeout: 300000 });
  await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), { timeout: 20000 });
  await sleep(600);

  // ④ 結果を確かめる：構成比 → 重ね絵の切り替え → AI の所見
  await caption('④ 結果を確かめる', '土地被覆が地図と写真に重なります');
  await sleep(2500);
  const scroller = await page.$('aside .overflow-y-auto');
  const [sx, sy] = await center(scroller);
  await moveTo(sx, sy);
  await page.evaluate(() => {
    const h = [...document.querySelectorAll('aside h3')].find((e) => e.textContent.startsWith('土地被覆の構成'));
    h?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  await caption('④ 土地被覆の構成', '7 区分の割合と面積');
  await sleep(3200);
  const toggle = await page.waitForSelector('xpath/.//label[contains(., "土地被覆を写真と地図に重ねる")]');
  await caption('④ 重ね絵の切り替え', '元の空中写真と見比べられます');
  await clickEl(toggle);
  await sleep(1800);
  await clickEl(toggle);
  await sleep(1400);
  await moveTo(sx, sy);
  await caption('④ AI の所見', '写っているものを、写真の中の位置と確度つきで説明します');
  // 所見を読めるよう、少しずつ送る
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel({ deltaY: 120 });
    await sleep(650);
  }
  await sleep(1500);

  // ⑤ 区分ごとに表示：押した区分の色だけを写真と地図に残す
  const classRow = (label) => page.waitForSelector(
    `xpath/.//section[@aria-labelledby="landcover-heading"]//button[@aria-pressed][contains(., "${label}")]`);
  await page.evaluate(() => document.getElementById('landcover-heading')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  await sleep(900);
  await caption('⑤ 区分ごとに表示', '押した区分の色だけを、写真と地図に残します');
  await clickEl(await classRow('建物'));
  await sleep(2600);
  await caption('⑤ 区分ごとに表示', '複数選べます（建物＋水域）');
  await clickEl(await classRow('水域'));
  await sleep(2600);
  await caption('⑤ 区分ごとに表示', '「すべての色を表示」で元に戻ります');
  await sleep(600);
  await clickText('すべての色を表示');
  await sleep(1200);

  // ⑥ AI に質問：区画ごとの集計から「どこに多いか」を答え、その区分の色と区画を地図に示す
  await page.evaluate(() => document.getElementById('ask-heading')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  await sleep(900);
  await caption('⑥ AI に質問する', '解析の結果をもとに答えます');
  await clickEl(await page.$('#ask-input'));
  await page.type('#ask-input', '駐車場が多い場所はどこですか？', { delay: 130 });
  await sleep(500);
  await page.keyboard.press('Enter');
  await caption('⑥ AI に質問する', '写真を 3×3 の区画に分けて集計し、答えます');
  await page.waitForSelector('xpath/.//section[@aria-labelledby="ask-heading"]/ol/li[.//li[contains(., "確かめたこと")] or .//*[@role="alert"]]', { timeout: 300000 });
  await page.waitForFunction(() => !window.__map.isMoving() && window.__map.areTilesLoaded(), { timeout: 20000 });
  await page.evaluate(() => document.querySelector('section[aria-labelledby="ask-heading"] ol > li:last-child')?.scrollIntoView({ block: 'end', behavior: 'smooth' }));
  await caption('⑥ 答えを地図に示す', '関係する区分の色と、いちばん多い区画を表示します');
  await sleep(6000);
  await caption('');
  await sleep(600);
  await recorder.stop();
  recorder = undefined;
  const src = await page.$eval('aside img', (i) => i.getAttribute('src'));
  const id = src?.match(/\/api\/analyses\/([0-9a-f]+)\//)?.[1];
  if (id) fs.writeFileSync(LAST_ID, id);
} catch (e) {
  // 録画を止めてから閉じる（止めずに閉じると、元の例外が録画側のエラーに隠れる）
  await recorder?.stop().catch(() => {});
  await browser.close();
  throw e;
}
await browser.close();

// 仕上げ：mp4（GitHub にアップロードして README で再生する）と gif（README に埋め込む）を作る
fs.mkdirSync(OUT_DIR, { recursive: true });
const mp4 = path.join(OUT_DIR, 'demo.mp4');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', raw,
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '24', '-preset', 'slow', '-movflags', '+faststart', '-r', '30', mp4]);
const gif = path.join(OUT_DIR, 'demo.gif');
execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-filter_complex',
  // 空中写真は細かく GIF が重くなるので、幅 800・96 色に抑える
  `fps=${GIF_FPS},scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=96:stats_mode=diff[p];[s1][p]paletteuse=dither=none:diff_mode=rectangle`,
  '-loop', '0', gif]);
fs.rmSync(work, { recursive: true, force: true });
const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1);
console.log(`✓ ${mp4}（${mb(mp4)} MB）・${gif}（${mb(gif)} MB、${GIF_FPS} コマ/秒）`);
