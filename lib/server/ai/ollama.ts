/**
 * 手元の Ollama で動く VLM に判読させる。費用は掛からず、写真は外へ出ない。
 */
import { Ollama } from 'ollama';
import { REPORT_SCHEMA, type RawReport, normalizeReport } from './schema';

export const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
// 6 地点で判読の質と速さを比べて決めた（README の「AI の判読」）。
// gemma4:e4b は Mac だと MLX で動き、構造化出力（format）が使えないので量子化版（llama.cpp）を指名する。
export const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'gemma4:e4b-it-q4_K_M';

/** タグを省いた名前は Ollama では「:latest」として入る。比べる前にそろえる */
const withTag = (name: string) => (name.split('/').pop()!.includes(':') ? name : `${name}:latest`);

/** Ollama が起動していて、指定のモデルが入っているか */
export async function ollamaStatus(): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    const client = new Ollama({ host: OLLAMA_HOST });
    const { models } = await client.list();
    const want = withTag(OLLAMA_MODEL);
    const has = models.some((m) => withTag(m.name) === want || withTag(m.model ?? m.name) === want);
    if (!has) {
      return { ok: false, reason: `Ollama にモデル ${OLLAMA_MODEL} がありません。ターミナルで「ollama pull ${OLLAMA_MODEL}」を実行してください。` };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `Ollama（${OLLAMA_HOST}）に接続できませんでした。Ollama を起動してから、もう一度解析してください。` };
  }
}

export async function ollamaReport(system: string, user: string, jpeg: Buffer, signal?: AbortSignal): Promise<RawReport> {
  // 画面側の中断を fetch に直接渡す。ollama-js の abort() は応答が返り始める前（モデルの読み込み中など）には効かない
  const client = new Ollama({
    host: OLLAMA_HOST,
    fetch: (input, init) => fetch(input, {
      ...init,
      signal: signal && init?.signal ? AbortSignal.any([signal, init.signal]) : (signal ?? init?.signal),
    }),
  });
  // stream:false だと生成が終わるまで応答ヘッダが来ず、Node の fetch の待ち上限（300 秒）で失敗する。
  // 少しずつ受けて連結する
  const stream = await client.chat({
    model: OLLAMA_MODEL,
    stream: true,
    format: REPORT_SCHEMA as unknown as object,
    // 考えさせると 1 枚に数十秒〜十数分と読めず、採用した版は考えさせなくても質が同程度だった
    think: false,
    options: { temperature: 0.2, num_ctx: 16384 },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user, images: [jpeg.toString('base64')] },
    ],
  });
  let text = '';
  // 考えた内容（message.thinking）が混ざっても、答えの本文だけをつなぐ
  for await (const part of stream) text += part.message.content;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('AI の出力を JSON として読み取れませんでした。');
  }
  return normalizeReport(parsed);
}
