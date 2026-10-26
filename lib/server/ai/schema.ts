/**
 * AI に返させる所見の形。Ollama（format）と Claude（output_config.format）の両方に同じ
 * JSON Schema を渡し、どちらでも同じ型で受け取る。
 */
import type { Finding } from '@/lib/types';

export const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'この範囲が全体としてどんな場所かを 2〜3 文で' },
    findings: {
      type: 'array',
      description: '写真から読み取れる目立つ地物。重要なものから最大 8 件',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '地物の種類（例：鉄道駅のホーム、水田、送電線の鉄塔）' },
          where: { type: 'string', description: '写真の中の位置（例：左上、中央やや右、下端に沿って）' },
          detail: { type: 'string', description: '何からそう判断したか、規模や数の目安' },
          confidence: { type: 'string', enum: ['高', '中', '低'] },
        },
        required: ['name', 'where', 'detail', 'confidence'],
        additionalProperties: false,
      },
    },
    caveats: {
      type: 'array',
      description: 'この写真からは判断できないこと・誤りやすい点',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'findings', 'caveats'],
  additionalProperties: false,
} as const;

export type RawReport = { summary: string; findings: Finding[]; caveats: string[] };

/** モデルの出力を検めて、画面に出せる形に整える。形が崩れていれば例外にする */
export function normalizeReport(v: unknown): RawReport {
  const o = v as Partial<RawReport> | null;
  if (!o || typeof o.summary !== 'string' || !Array.isArray(o.findings)) {
    throw new Error('AI の出力を読み取れませんでした。');
  }
  const conf = (c: unknown): Finding['confidence'] => (c === '高' || c === '中' || c === '低' ? c : '低');
  return {
    summary: o.summary.trim(),
    findings: o.findings
      .filter((f) => f && typeof f.name === 'string' && f.name.trim())
      .slice(0, 8)
      .map((f) => ({
        name: String(f.name).trim(),
        where: String(f.where ?? '').trim(),
        detail: String(f.detail ?? '').trim(),
        confidence: conf(f.confidence),
      })),
    caveats: (Array.isArray(o.caveats) ? o.caveats : []).map(String).map((s) => s.trim()).filter(Boolean).slice(0, 6),
  };
}
