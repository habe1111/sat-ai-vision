/**
 * 初回のセットアップ（npm run setup）。
 *
 * 1. 土地被覆モデル（models/flair_rgb15.onnx、約 98 MB）を GitHub Releases から取り、
 *    SHA-256 を照合する。取れないときは、公式の重みから作る手順を案内する。
 * 2. AI の判読に使う Ollama が動いているか、モデルが入っているかを確かめる。
 *
 * どちらも無くてもアプリは動く（土地被覆は色の簡易推定、AI の所見は出ない）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MODEL = path.join(process.cwd(), 'models', 'flair_rgb15.onnx');
const MODEL_URL = process.env.FLAIR_MODEL_URL
  || 'https://github.com/habe1111/sat-ai-vision/releases/download/models-v1/flair_rgb15.onnx';
const MODEL_SHA256 = '6deb785d299b5d060fdd85399cc5e52c150695683b9e221dc08983879ec2f7f0';
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen3-vl:8b';

const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function setupModel() {
  if (fs.existsSync(MODEL)) {
    if (sha256(MODEL) === MODEL_SHA256) {
      console.log('✓ 土地被覆モデルは入っています');
      return;
    }
    console.log('! 土地被覆モデルの中身が想定と違います。取り直します');
  }
  console.log(`… 土地被覆モデルを取得しています（約 98 MB）\n  ${MODEL_URL}`);
  try {
    const res = await fetch(MODEL_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const got = createHash('sha256').update(buf).digest('hex');
    if (got !== MODEL_SHA256) throw new Error(`SHA-256 が一致しません（${got}）`);
    fs.mkdirSync(path.dirname(MODEL), { recursive: true });
    fs.writeFileSync(MODEL, buf);
    console.log('✓ 土地被覆モデルを入れました');
  } catch (e) {
    console.log(`✗ 土地被覆モデルを取得できませんでした（${e.message}）。
  公式の重みから作ることもできます（Python 3.10 以上）：
    cd tools/flair-export && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/python export_flair.py
  モデルが無くても、色の指標による簡易推定で動きます。`);
  }
}

async function checkOllama() {
  if ((process.env.AI_PROVIDER || 'auto') === 'anthropic') return;
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`);
    const { models } = await res.json();
    if (models.some((m) => m.name === OLLAMA_MODEL || m.model === OLLAMA_MODEL)) {
      console.log(`✓ Ollama に ${OLLAMA_MODEL} が入っています`);
    } else {
      console.log(`! Ollama は動いていますが ${OLLAMA_MODEL} がありません。次を実行してください：\n    ollama pull ${OLLAMA_MODEL}`);
    }
  } catch {
    console.log(`! Ollama（${OLLAMA_HOST}）に接続できません。AI の所見を出すには：
    1. https://ollama.com/download から入れる（Mac は brew install ollama でも可）
    2. ollama serve で起動する
    3. ollama pull ${OLLAMA_MODEL}
  または .env.local に ANTHROPIC_API_KEY を設定すると Claude で判読します。`);
  }
}

await setupModel();
await checkOllama();
