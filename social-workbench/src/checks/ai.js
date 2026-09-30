// AI 品質測試：用 20 則留言測分類與回覆建議，輸出一份給人評分的表格。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, RESULTS_DIR } from '../config.js';
import { CommentStore } from '../store.js';
import { classify, suggest, shouldSuggest, PROMPT_VERSION } from '../ai/analyze.js';
import { STATUS, result } from './util.js';

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const cell = (s) => String(s ?? '').replace(/\|/g, '｜').replace(/\n/g, ' ');

// 真實留言：從 fb-read / ig-read 存下來的顧客主留言（不含品牌自己發的）
function realComments(limit) {
  return [...new CommentStore().byKey.values()]
    .filter((c) => !c.is_brand && c.text && !c.parent_comment_id)
    .slice(-limit)
    .map((c) => ({ id: c.key, platform: c.platform, text: c.text }));
}

export const aiChecks = {
  ai: {
    title: 'AI：用 20 則留言測試分類與回覆建議品質',
    usage: '[--source real]（預設用 fixtures 的示範留言；real＝用 fb-read/ig-read 抓到的真實留言）[--limit 20]',
    async run(args) {
      if (!process.env.ANTHROPIC_API_KEY) throw new Error('.env 缺少 ANTHROPIC_API_KEY');
      const limit = Number(args.limit || 20);
      const brand = readJson('fixtures/brand.json');
      const comments = args.source === 'real' ? realComments(limit) : readJson('fixtures/sample-comments.json').slice(0, limit);
      if (!comments.length) return result(STATUS.PENDING, '沒有可用的真實留言；請先執行 fb-read 或 ig-read');

      const rows = [];
      let cost = 0;
      for (const c of comments) {
        const row = { id: c.id, platform: c.platform, text: c.text };
        try {
          const { analysis, usage, refused } = await classify(c, brand);
          cost += usage.estimated_cost_usd || 0;
          row.analysis = analysis;
          row.refused = refused || false;
          if (analysis && shouldSuggest(analysis)) {
            const s = await suggest(c, brand, analysis);
            cost += s.usage.estimated_cost_usd || 0;
            row.suggestion = s.text;
          }
        } catch (err) {
          row.error = err.message;
        }
        rows.push(row);
        console.log(`  ${c.id} ${row.analysis ? `${row.analysis.category}／${row.analysis.priority}` : row.error || '被拒絕'}`);
      }

      // 給人評分的表格：最後兩欄由產品負責人或設計夥伴填
      const md = [
        `# AI 品質測試（提示版本 ${PROMPT_VERSION}）`,
        '',
        `來源：${args.source === 'real' ? '真實留言' : '示範留言（fixtures）'}，共 ${rows.length} 則，估算成本 US$${cost.toFixed(4)}。`,
        '',
        '| # | 平台 | 留言 | 分類 | 情緒 | 風險 | 優先級 | 信心 | 回覆建議 | 分類正確？ | 建議可用？ |',
        '|---|---|---|---|---|---|---|---|---|---|---|',
        ...rows.map((r, i) => `| ${i + 1} | ${r.platform} | ${cell(r.text)} | ${cell(r.analysis?.category ?? r.error ?? '拒絕')} | ${cell(r.analysis?.sentiment)} | ${cell(r.analysis?.risk)} | ${cell(r.analysis?.priority)} | ${r.analysis ? r.analysis.confidence.toFixed(2) : ''} | ${cell(r.suggestion ?? '（不產生）')} |  |  |`),
      ].join('\n');
      fs.mkdirSync(RESULTS_DIR, { recursive: true });
      fs.writeFileSync(path.join(RESULTS_DIR, 'ai-samples.md'), md + '\n');

      const errors = rows.filter((r) => r.error).length;
      return result(
        errors ? STATUS.CONDITIONAL : STATUS.CAN,
        `完成 ${rows.length - errors}/${rows.length} 則，估算成本 US$${cost.toFixed(4)}；請打開 results/ai-samples.md 逐則評分`,
        { rows, estimated_cost_usd: cost, prompt_version: PROMPT_VERSION },
      );
    },
  },
};
