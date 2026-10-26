/**
 * AI への指示。写真の条件（場所・向き・縮尺）と、土地被覆の数値を根拠として渡す。
 *
 * 数値は CV 側を正とする。VLM は面積比や個数の推定が苦手で（GEOBench-VLM など）、
 * 自由に言わせると数字がぶれるため。VLM には「何が写っているか」の言語化を任せる。
 */
import { formatDms, formatLength } from '@/lib/geo';

export type PromptInput = {
  centerLon: number;
  centerLat: number;
  widthM: number;
  heightM: number;
  metersPerPixel: number;
  landCoverLines: string[];   // 例「植生 42.1%」
  landCoverMethod: string;
};

export const SYSTEM_PROMPT = `あなたは空中写真判読の専門家です。日本の空中写真（オルソ画像）を見て、写っているものを日本語で説明します。

守ること:
- 写真から読み取れることだけを書く。地名・施設名は、写真に文字が読めるときを除いて推測で書かない。
- 位置は写真の中の場所（左上・中央・右下など）で示す。写真は北が上。
- 面積の割合は、与えられた土地被覆の数値を正とし、独自の割合は書かない。
- 個数や規模は「約」「数十棟」のように目安で書く。
- 確信が持てないものは確度を「低」にし、判断できないことは caveats に書く。
- です・ます調で、簡潔に。`;

export function buildUserPrompt(p: PromptInput): string {
  return [
    `この空中写真を判読してください。`,
    ``,
    `写真の条件:`,
    `- 中心：${formatDms(p.centerLat, 'lat')} ${formatDms(p.centerLon, 'lon')}（日本）`,
    `- 範囲：東西 ${formatLength(p.widthM)} × 南北 ${formatLength(p.heightM)}、北が上`,
    `- 解像度：約 ${p.metersPerPixel.toFixed(2)} m/px（元の写真）`,
    ``,
    `土地被覆の数値（${p.landCoverMethod}）:`,
    ...p.landCoverLines.map((l) => `- ${l}`),
  ].join('\n');
}
