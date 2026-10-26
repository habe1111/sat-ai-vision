/**
 * どの AI で判読するかを決めて呼ぶ。
 *
 * AI_PROVIDER（.env.local）:
 * - auto（既定）… ANTHROPIC_API_KEY があれば Claude、無ければ手元の Ollama
 * - ollama / anthropic … 指定のものだけを使う
 * - none … AI の判読をしない（土地被覆の数値だけ出す）
 */
import sharp from 'sharp';
import type { AiReport } from '@/lib/types';
import { SYSTEM_PROMPT, buildUserPrompt, type PromptInput } from './prompt';
import { OLLAMA_MODEL, ollamaReport, ollamaStatus } from './ollama';
import { ANTHROPIC_MODEL, anthropicConfigured, anthropicReport } from './anthropic';

type Provider = 'ollama' | 'anthropic';

/** モデルへ送る画像の長辺（px）。Claude は 2576px まで細部を読む。手元の VLM は重くなりすぎない大きさに */
const SEND_SIZE: Record<Provider, number> = { anthropic: 2576, ollama: 1536 };

export type AiPlan = { provider: Provider; label: string } | { provider: null; reason: string };

export async function planAi(): Promise<AiPlan> {
  const pref = (process.env.AI_PROVIDER || 'auto').toLowerCase();
  if (pref === 'none') return { provider: null, reason: 'AI の判読は設定で止めています（AI_PROVIDER=none）。' };
  if (pref === 'anthropic' || (pref === 'auto' && anthropicConfigured())) {
    if (!anthropicConfigured()) return { provider: null, reason: 'ANTHROPIC_API_KEY が設定されていません。.env.local に追加してください。' };
    return { provider: 'anthropic', label: `Claude ${ANTHROPIC_MODEL}（Anthropic API）` };
  }
  const st = await ollamaStatus();
  if (!st.ok) return { provider: null, reason: st.reason };
  return { provider: 'ollama', label: `Ollama ${OLLAMA_MODEL}（このパソコンで実行）` };
}

export async function runAi(
  plan: Extract<AiPlan, { provider: Provider }>,
  jpeg: Buffer,
  input: PromptInput,
  signal?: AbortSignal,
): Promise<AiReport> {
  // 長辺を揃え、28 の倍数にする（Claude の画像パッチの大きさ。縮み方が予測できるように）
  const meta = await sharp(jpeg).metadata();
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  const target = Math.min(SEND_SIZE[plan.provider], longest);
  const scale = target / longest;
  const w = Math.max(28, Math.round(((meta.width ?? 0) * scale) / 28) * 28);
  const h = Math.max(28, Math.round(((meta.height ?? 0) * scale) / 28) * 28);
  const img = await sharp(jpeg).resize(w, h, { fit: 'fill' }).jpeg({ quality: 88 }).toBuffer();

  const t0 = performance.now();
  const user = buildUserPrompt(input);
  const raw = plan.provider === 'anthropic'
    ? await anthropicReport(SYSTEM_PROMPT, user, img, signal)
    : await ollamaReport(SYSTEM_PROMPT, user, img, signal);
  return { engine: plan.label, seconds: (performance.now() - t0) / 1000, ...raw };
}
