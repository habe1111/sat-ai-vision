/**
 * 注釈の下ごしらえ：船・車の「候補」を、土地被覆と明るさだけで自動で出す（学習したモデルではない）。
 *
 * 人が一から点や枠を置くより、出てきた候補を消す・直すほうが速いので、取りこぼしを減らす側に寄せている。
 * 誤りは多い前提で、出したものはすべて proposed（未確認）として保存する。
 *
 * - 車：舗装地・裸地の中で、車ほどの大きさの明るい・暗い点（DoG の山と谷）。白線などの線は除く。
 * - 船：水域（とその縁）の中で、水面と違う色の塊。まわりの大半が水のもの（岸と一体でないもの）に絞る。
 */
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { type Annotation, CHIP_PX, normalizeAngle } from '@/lib/annotate';
import { FLAIR_GROUPS } from '@/lib/server/landcover/flair';

/** 重ね絵の色から区分の番号を戻す（重ね絵は区分ごとの単色・不透明で塗っている） */
function classMap(rgba: Buffer, n: number): Int8Array {
  const out = new Int8Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (rgba[i * 4 + 3] < 128) continue;
    const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
    for (let k = 0; k < FLAIR_GROUPS.length; k++) {
      const c = FLAIR_GROUPS[k].color;
      if (Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b) < 12) { out[i] = k; break; }
    }
  }
  return out;
}

/** 正方形の窓（半径 r）で、mask の画素だけの平均を取る（積分画像） */
function localMean(v: Float32Array, mask: Uint8Array | null, size: number, r: number): Float32Array {
  const S = size + 1;
  const sum = new Float64Array(S * S), cnt = new Float64Array(S * S);
  for (let y = 0; y < size; y++) {
    let rs = 0, rc = 0;
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!mask || mask[i]) { rs += v[i]; rc++; }
      sum[(y + 1) * S + x + 1] = sum[y * S + x + 1] + rs;
      cnt[(y + 1) * S + x + 1] = cnt[y * S + x + 1] + rc;
    }
  }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(size, y + r + 1);
    for (let x = 0; x < size; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(size, x + r + 1);
      const at = (yy: number, xx: number) => yy * S + xx;
      const c = cnt[at(y1, x1)] - cnt[at(y0, x1)] - cnt[at(y1, x0)] + cnt[at(y0, x0)];
      const s = sum[at(y1, x1)] - sum[at(y0, x1)] - sum[at(y1, x0)] + sum[at(y0, x0)];
      out[y * size + x] = c > 0 ? s / c : NaN;
    }
  }
  return out;
}

/** 正方形の窓（半径 r）で膨らませる */
function dilate(m: Uint8Array, size: number, r: number): Uint8Array {
  const tmp = new Uint8Array(size * size), out = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    let last = -Infinity;
    for (let x = 0; x < size; x++) { if (m[y * size + x]) last = x; if (x - last <= r) tmp[y * size + x] = 1; }
    last = Infinity;
    for (let x = size - 1; x >= 0; x--) { if (m[y * size + x]) last = x; if (last - x <= r) tmp[y * size + x] = 1; }
  }
  for (let x = 0; x < size; x++) {
    let last = -Infinity;
    for (let y = 0; y < size; y++) { if (tmp[y * size + x]) last = y; if (y - last <= r) out[y * size + x] = 1; }
    last = Infinity;
    for (let y = size - 1; y >= 0; y--) { if (tmp[y * size + x]) last = y; if (last - y <= r) out[y * size + x] = 1; }
  }
  return out;
}

/** ガウスぼかし（縦横に分けて掛ける。端は端の画素を伸ばす） */
function gaussian(v: Float32Array, size: number, sigma: number): Float32Array {
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(size * size), out = new Float32Array(size * size);
  const clamp = (a: number) => (a < 0 ? 0 : a >= size ? size - 1 : a);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += v[y * size + clamp(x + i)] * k[i + r];
      tmp[y * size + x] = acc;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += tmp[clamp(y + i) * size + x] * k[i + r];
      out[y * size + x] = acc;
    }
  }
  return out;
}

type Blob = { pixels: Int32Array; cx: number; cy: number; length: number; width: number; angle: number };

/** 4 近傍でつながった塊を取り出し、主軸に沿った矩形（長さ・幅・向き）を測る */
function blobs(m: Uint8Array, size: number, minPx: number, maxPx: number): Blob[] {
  const seen = new Uint8Array(size * size);
  const stack = new Int32Array(size * size);
  const out: Blob[] = [];
  for (let start = 0; start < size * size; start++) {
    if (!m[start] || seen[start]) continue;
    let top = 0, n = 0;
    stack[top++] = start;
    seen[start] = 1;
    const px: number[] = [];
    while (top) {
      const i = stack[--top];
      px.push(i);
      n++;
      const x = i % size, y = (i / size) | 0;
      if (x > 0 && m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[top++] = i - 1; }
      if (x < size - 1 && m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[top++] = i + 1; }
      if (y > 0 && m[i - size] && !seen[i - size]) { seen[i - size] = 1; stack[top++] = i - size; }
      if (y < size - 1 && m[i + size] && !seen[i + size]) { seen[i + size] = 1; stack[top++] = i + size; }
    }
    if (n < minPx || n > maxPx) continue;
    let sx = 0, sy = 0;
    for (const i of px) { sx += i % size; sy += (i / size) | 0; }
    const mx = sx / n, my = sy / n;
    let cxx = 0, cyy = 0, cxy = 0;
    for (const i of px) {
      const dx = (i % size) - mx, dy = ((i / size) | 0) - my;
      cxx += dx * dx; cyy += dy * dy; cxy += dx * dy;
    }
    const angle = 0.5 * Math.atan2(2 * cxy, cxx - cyy);
    const ux = Math.cos(angle), uy = Math.sin(angle);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const i of px) {
      const dx = (i % size) - mx, dy = ((i / size) | 0) - my;
      const u = dx * ux + dy * uy, v = -dx * uy + dy * ux;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    // 画素の中心どうしの幅に、画素 1 つぶんを足す
    const length = u1 - u0 + 1, width = v1 - v0 + 1;
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    out.push({
      pixels: Int32Array.from(px),
      // 画素 (x, y) の中心は x + 0.5
      cx: mx + uc * ux - vc * uy + 0.5,
      cy: my + uc * uy + vc * ux + 0.5,
      length,
      width,
      angle: normalizeAngle(angle),
    });
  }
  return out;
}

/** 車の幅の半分ほど（m）。DoG の細かいほうのぼかしの強さにする */
const CAR_SIGMA_M = 0.7;
/** DoG の山（谷）の高さ（明るさ 0〜255 の差）がこれ以上のものを車の候補にする */
const CAR_DOG = 16;
/** ヘッセ行列の固有値の比がこれより大きいものは、点でなく線（白線・縁）とみなす */
const CAR_LINE_RATIO = 3;
/**
 * 船の形（m）。小舟と波のきらめきは拾わない。細長すぎるもの（岸に沿った帯・防波堤）や、
 * 枠の中を塊が埋めていないもの（入り組んだ岸）は船ではない
 */
const SHIP = { minLength: 5, maxLength: 400, minWidth: 1.5, minArea: 12, minAspect: 1.3, maxAspect: 9, minFill: 0.45 };
/** 水面との明るさの差。低いと波のきらめきを拾う */
const SHIP_CONTRAST = 40;
/** 1 枚のチップに出す候補の上限。大きな駐車場では 1 枚（約 250 m 四方）に数百台ある */
const MAX_CARS = 400;
const MAX_SHIPS = 80;

/**
 * jpeg（CHIP_PX 四方の写真）と overlay（同じ範囲の土地被覆の重ね絵）から候補を出す。
 * mpp は 1 画素の地上距離（m）
 */
export async function proposeCandidates(jpeg: Buffer, overlay: Buffer, mpp: number): Promise<Annotation[]> {
  const size = CHIP_PX;
  const n = size * size;
  const [{ data: rgb }, { data: ov }] = await Promise.all([
    sharp(jpeg).resize(size, size, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(overlay).resize(size, size, { fit: 'fill', kernel: 'nearest' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const cls = classMap(ov, n);
  const gray = new Float32Array(n);
  let photo = 0;
  for (let i = 0; i < n; i++) {
    const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    if (r > 2 || g > 2 || b > 2) photo++;
  }
  if (photo < n * 0.05) return [];   // 写真の無いチップ（海上など）
  const keyIndex = (k: string) => FLAIR_GROUPS.findIndex((g) => g.key === k);
  const BUILDING = keyIndex('building'), PAVED = keyIndex('paved'), BARE = keyIndex('bare'), WATER = keyIndex('water');
  const px = (m: number) => Math.max(1, Math.round(m / mpp));
  const out: Annotation[] = [];
  // 出し直したときに、前に出して人が残した候補と id がぶつからないよう、回ごとの印を付ける
  const run = randomUUID().slice(0, 6);

  // --- 車 ---
  // 車は 1 台ずつが「車ほどの大きさの、まわりより明るい（暗い）点」になる。塊を切り出すと、
  // 並んで停まった車がつながって 1 つになるので、ぼかしの差（DoG）の山と谷で 1 台ずつ拾う
  const s1 = Math.max(0.8, CAR_SIGMA_M / mpp);
  const g1 = gaussian(gray, size, s1);
  const g2 = gaussian(gray, size, s1 * 2.5);
  const dog = new Float32Array(n);
  for (let i = 0; i < n; i++) dog[i] = g1[i] - g2[i];
  // 車が停まる所（舗装・裸地。砂利の駐車場は裸地と判定される）。芝生は公園の木陰や人を拾うので除く。
  // 建物の縁の影も除く
  const building = new Uint8Array(n);
  const ground = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    building[i] = cls[i] === BUILDING ? 1 : 0;
    ground[i] = cls[i] === PAVED || cls[i] === BARE ? 1 : 0;
  }
  const nearBuilding = dilate(building, size, px(0.8));
  const peakR = px(1.2);
  const cars: { x: number; y: number; score: number }[] = [];
  for (let y = peakR + 1; y < size - peakR - 1; y++) {
    for (let x = peakR + 1; x < size - peakR - 1; x++) {
      const i = y * size + x;
      const d = dog[i];
      if (!ground[i] || nearBuilding[i] || Math.abs(d) < CAR_DOG) continue;
      // 同じ向き（山なら山）の中で、近くでいちばん強いところだけ
      let top = true;
      for (let dy = -peakR; dy <= peakR && top; dy++) {
        for (let dx = -peakR; dx <= peakR; dx++) {
          const j = i + dy * size + dx;
          if (j !== i && Math.sign(dog[j]) === Math.sign(d) && Math.abs(dog[j]) > Math.abs(d)) { top = false; break; }
        }
      }
      if (!top) continue;
      // 白線や建物の縁のような「線」は、ヘッセ行列の 2 つの固有値の差が大きいので除く
      const dxx = g1[i - 1] + g1[i + 1] - 2 * g1[i];
      const dyy = g1[i - size] + g1[i + size] - 2 * g1[i];
      const dxy = (g1[i + size + 1] - g1[i + size - 1] - g1[i - size + 1] + g1[i - size - 1]) / 4;
      const tr = dxx + dyy, det = dxx * dyy - dxy * dxy;
      const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det));
      const l1 = tr / 2 + disc, l2 = tr / 2 - disc;
      const big = Math.max(Math.abs(l1), Math.abs(l2)), small = Math.min(Math.abs(l1), Math.abs(l2));
      // 明るい点なら両方とも負、暗い点なら両方とも正（鞍点は車ではない）
      if (det <= 0 || Math.sign(tr) === Math.sign(d) || big > CAR_LINE_RATIO * small) continue;
      cars.push({ x: x + 0.5, y: y + 0.5, score: Math.abs(d) });
    }
  }
  // 車の影や、明るい屋根と暗い窓が別の点になったものは 1 台にまとめる（強いほうを残す）
  cars.sort((a, b) => b.score - a.score);
  const keptCars: typeof cars = [];
  const near = px(1.8);
  for (const c of cars) {
    if (keptCars.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < near)) continue;
    keptCars.push(c);
    if (keptCars.length >= MAX_CARS) break;
  }
  keptCars.forEach((c, i) => out.push({ id: `auto-${run}-car-${i}`, kind: 'car', status: 'proposed', source: 'auto', x: round(c.x), y: round(c.y) }));

  // --- 船 ---
  const water = new Uint8Array(n);
  let waterCount = 0;
  for (let i = 0; i < n; i++) if (cls[i] === WATER) { water[i] = 1; waterCount++; }
  if (waterCount > n * 0.01) {
    const nearWater = dilate(water, size, px(8));
    const waterBg = localMean(gray, water, size, px(25));
    const m = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (!nearWater[i]) continue;
      // 水と判定されなかった画素か、まわりの水面と色の違う画素
      const diff = Number.isNaN(waterBg[i]) ? 0 : Math.abs(gray[i] - waterBg[i]);
      m[i] = !water[i] || diff > SHIP_CONTRAST ? 1 : 0;
    }
    const ring = px(3);
    const ships: Blob[] = [];
    for (const b of blobs(m, size, Math.ceil(SHIP.minArea / (mpp * mpp)), n)) {
      const L = b.length * mpp, W = b.width * mpp, aspect = b.length / b.width;
      if (L < SHIP.minLength || L > SHIP.maxLength || W < SHIP.minWidth) continue;
      if (aspect < SHIP.minAspect || aspect > SHIP.maxAspect || b.pixels.length / (b.length * b.width) < SHIP.minFill) continue;
      // 塊を囲む矩形（ring 画素ぶん広げる）のうち、塊でない画素の水の割合。岸壁や陸とつながった塊は低くなる
      const own = new Set(b.pixels);
      let wet = 0, all = 0;
      let x0 = size, x1 = 0, y0 = size, y1 = 0;
      for (const i of b.pixels) {
        const x = i % size, y = (i / size) | 0;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      x0 = Math.max(0, x0 - ring); x1 = Math.min(size - 1, x1 + ring);
      y0 = Math.max(0, y0 - ring); y1 = Math.min(size - 1, y1 + ring);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * size + x;
          if (own.has(i)) continue;
          all++;
          if (water[i]) wet++;
        }
      }
      if (!all || wet / all < 0.5) continue;
      ships.push(b);
    }
    ships.sort((a, b) => b.pixels.length - a.pixels.length);
    ships.slice(0, MAX_SHIPS).forEach((b, i) => out.push({
      id: `auto-${run}-ship-${i}`,
      kind: 'ship',
      status: 'proposed',
      source: 'auto',
      cx: round(b.cx),
      cy: round(b.cy),
      length: round(b.length),
      width: round(b.width),
      angle: Math.round(b.angle * 100) / 100,
    }));
  }
  return out;
}

const round = (v: number) => Math.round(v * 10) / 10;
