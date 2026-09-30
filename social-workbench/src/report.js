// 把 results/*.json 整理成一份實測報告 results/REPORT.md。
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR } from './config.js';
import { CHECKS } from './checks/registry.js';

const cell = (s) => String(s ?? '').replace(/\|/g, '｜').replace(/\n/g, ' ');

const rows = Object.entries(CHECKS).map(([id, c]) => {
  const f = path.join(RESULTS_DIR, `${id}.json`);
  const r = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
  return `| ${id} | ${cell(c.title)} | ${r ? `**${r.status}**` : '尚未執行'} | ${cell(r?.summary)} | ${r ? r.ran_at.slice(0, 16).replace('T', ' ') : ''} |`;
});

const md = [
  '# 階段 0 實測結果',
  '',
  `產生時間：${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC。每一項的完整證據在 \`results/<項目>.json\`。`,
  '',
  '| 項目 | 驗證內容 | 結論 | 說明 | 執行時間 (UTC) |',
  '|---|---|---|---|---|',
  ...rows,
  '',
  '文件研究的「能做／不能做／有條件」總表見 `docs/capability-matrix.md`，兩者不一致時以實測為準，並回頭更新總表。',
].join('\n');

fs.mkdirSync(RESULTS_DIR, { recursive: true });
fs.writeFileSync(path.join(RESULTS_DIR, 'REPORT.md'), md + '\n');
console.log(`已產生 ${path.join('results', 'REPORT.md')}`);
