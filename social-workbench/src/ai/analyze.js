// AI 呼叫集中在這個模組：記錄模型、提示版本、用量、估算成本，並歸屬到組織與品牌。
// 只送必要資料：留言內文與貼文摘要，不送留言者姓名或 ID。
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { config } from '../config.js';
import { append } from '../store.js';

export const PROMPT_VERSION = 'phase0-2026-09-30';

// 每百萬 token 的美元價格（輸入, 輸出）；以官方價目表為準，變動時更新這裡
const PRICES = {
  'claude-haiku-4-5': [1, 5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
};

// 這些模型支援伺服器端 fallbacks：被安全機制拒絕時自動改用其他模型重跑
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export const CATEGORIES = ['產品詢問', '訂單與物流', '客訴', '售後服務', '讚美與支持', '負面評論', '活動與抽獎', '合作邀約', '垃圾訊息', '無需回覆', '其他'];

export const AnalysisSchema = z.object({
  category: z.enum(CATEGORIES),
  tags: z.array(z.string()).describe('輔助標籤，例如：價格、尺寸、退換貨、到貨時間'),
  sentiment: z.enum(['正面', '中性', '負面']),
  risk: z.enum(['低', '中', '高']).describe('高＝客訴、重大負面、可能擴散成社群事件'),
  priority: z.enum(['P1', 'P2', 'P3', 'P4']).describe('P1 最急'),
  needs_reply: z.boolean(),
  confidence: z.number().describe('0 到 1 之間，對這次判斷的信心'),
  reason: z.string().describe('一句話說明判斷理由'),
});

let client;
const anthropic = () => (client ??= new Anthropic());

function logUsage({ brand, purpose, model, usage, stopReason }) {
  const [inPrice, outPrice] = PRICES[model] || [null, null];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const cost = inPrice == null ? null : (input * inPrice + (usage.output_tokens || 0) * outPrice) / 1e6;
  const rec = {
    at: new Date().toISOString(),
    organization_id: brand.organization_id,
    brand_id: brand.id,
    purpose,
    model,
    prompt_version: PROMPT_VERSION,
    input_tokens: input,
    output_tokens: usage.output_tokens || 0,
    estimated_cost_usd: cost,
    stop_reason: stopReason,
  };
  append('ai_usage.jsonl', rec);
  return rec;
}

const commentBlock = (c) => [
  c.content_text ? `【原貼文摘要】${c.content_text.slice(0, 300)}` : null,
  c.parent_text ? `【上一則留言】${c.parent_text}` : null,
  `【平台】${c.platform === 'instagram' ? 'Instagram' : 'Facebook'}`,
  `【顧客留言】${c.text}`,
].filter(Boolean).join('\n');

export async function classify(comment, brand) {
  const model = config.classifyModel;
  const res = await anthropic().messages.parse({
    model,
    max_tokens: 1024,
    system: `你是品牌「${brand.name}」的社群客服分析員。判斷一則公開留言的分類、情緒、風險與優先級。
規則：
- 客訴、揚言退貨或檢舉、公開指控、可能被大量轉傳的負面內容 → 風險「高」、P1。
- 詢問價格、庫存、出貨進度等需要品牌回覆的問題 → 至少 P2。
- 純表情、標記朋友、抽獎留言「+1」等 → 無需回覆，P4。
- 廣告、詐騙連結、與品牌無關的推銷 → 垃圾訊息，P4。`,
    messages: [{ role: 'user', content: commentBlock(comment) }],
    output_config: { format: zodOutputFormat(AnalysisSchema) },
  });
  const usage = logUsage({ brand, purpose: 'classify', model, usage: res.usage, stopReason: res.stop_reason });
  if (res.stop_reason === 'refusal') return { analysis: null, usage, refused: true };
  return { analysis: res.parsed_output, usage };
}

export async function suggest(comment, brand, analysis, { style = '預設' } = {}) {
  const model = config.suggestModel;
  const params = {
    model,
    max_tokens: 2048,
    output_config: { effort: 'low' },
    system: `你是品牌「${brand.name}」的社群小編，替顧客的公開留言草擬一則回覆建議，由真人確認後才會送出。
品牌風格：${brand.voice}
品牌知識（只能根據這些資料回答，資料沒有的就請顧客私訊或說會再確認）：
${brand.knowledge}
禁止：${brand.forbidden}
輸出：只輸出回覆內文，繁體中文，不加引號或說明。風格：${style}。`,
    messages: [{ role: 'user', content: `${commentBlock(comment)}\n【AI 判斷】${analysis.category}／${analysis.sentiment}／風險${analysis.risk}` }],
  };
  const useFallbacks = FALLBACK_MODELS.has(model);
  const res = useFallbacks
    ? await anthropic().beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
    : await anthropic().messages.create(params);
  const usage = logUsage({ brand, purpose: 'suggest', model, usage: res.usage, stopReason: res.stop_reason });
  if (res.stop_reason === 'refusal') return { text: null, usage, refused: true };
  const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { text, usage };
}

// 分類後，只有需要回覆、不是垃圾訊息的留言才產生建議（控制成本）
export function shouldSuggest(analysis) {
  return Boolean(analysis?.needs_reply) && !['垃圾訊息', '無需回覆'].includes(analysis.category);
}
