/**
 * Claude（Anthropic API）に判読させる。手元のモデルより所見が詳しいが、写真が Anthropic へ送られ、
 * API の利用料が掛かる。ANTHROPIC_API_KEY を設定したときだけ使う。
 */
import Anthropic from '@anthropic-ai/sdk';
import { REPORT_SCHEMA, type RawReport, normalizeReport } from './schema';

export const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

export function anthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function anthropicReport(system: string, user: string, jpeg: Buffer, signal?: AbortSignal): Promise<RawReport> {
  return normalizeReport(await anthropicJson(system, user, [jpeg], REPORT_SCHEMA, signal));
}

/** 画像と指示を渡し、JSON Schema の形で答えさせる。読み取った値は呼んだ側で検める */
export async function anthropicJson(system: string, user: string, jpegs: Buffer[], schema: object, signal?: AbortSignal): Promise<unknown> {
  const client = new Anthropic();
  const msg = await client.messages.create(
    {
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system,
      output_config: { format: { type: 'json_schema', schema: schema as Record<string, unknown> } },
      messages: [
        {
          role: 'user',
          content: [
            ...jpegs.map((j) => ({ type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/jpeg' as const, data: j.toString('base64') } })),
            { type: 'text', text: user },
          ],
        },
      ],
    },
    { signal },
  );
  const text = msg.content.find((b) => b.type === 'text');
  if (!text || text.type !== 'text') throw new Error('Claude から答えが返りませんでした。');
  return JSON.parse(text.text);
}
