// 驗證項目共用工具：每個驗證都回傳統一格式，存到 results/ 給報告使用。
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, config } from '../config.js';
import { loadTokens } from '../store.js';
import { GraphError } from '../meta/graph.js';

// 報告的三種結論 + 還沒有結論的狀態
export const STATUS = {
  CAN: '可做',
  CANNOT: '不可做',
  CONDITIONAL: '有條件',
  PENDING: '待實測', // 需要人工操作或資料不足，還不能下結論
  ERROR: '執行錯誤',
};

export function result(status, summary, evidence = {}) {
  return { status, summary, evidence };
}

export function saveResult(id, title, r) {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const record = { id, title, ran_at: new Date().toISOString(), graph_version: config.graphVersion, ...r };
  fs.writeFileSync(path.join(RESULTS_DIR, `${id}.json`), JSON.stringify(record, null, 2));
  return record;
}

export function pageToken(pageId = config.pageId) {
  const tokens = loadTokens();
  const p = tokens.pages.find((x) => x.id === pageId);
  if (!p) throw new Error(`token 裡找不到粉專 ${pageId}。請確認 FB_PAGE_ID，或重新 /login 授權並勾選這個粉專。`);
  return p.access_token;
}

export function userToken() {
  return loadTokens().user.access_token;
}

// 把 Graph API 錯誤轉成白話結論
export function fromGraphError(err, what) {
  if (!(err instanceof GraphError)) return result(STATUS.ERROR, `${what}：${err.message}`);
  const ev = { code: err.code, subcode: err.subcode, message: err.message, fbtrace_id: err.fbtraceId };
  if (err.isTokenInvalid) return result(STATUS.ERROR, `${what}：token 已失效（code 190），請重新 /login`, ev);
  if (err.isPermission) return result(STATUS.CONDITIONAL, `${what}：權限不足或需要審查（code ${err.code}）`, ev);
  if (err.isRateLimited) return result(STATUS.ERROR, `${what}：被限流（code ${err.code}），稍後再試`, ev);
  return result(STATUS.ERROR, `${what}：${err.message}`, ev);
}

export function requireWrite() {
  if (!config.allowWrite) {
    throw new Error('這個驗證會真的在平台上回覆／隱藏／刪除。確認只對「測試粉專」操作後，把 .env 的 ALLOW_WRITE 改成 true 再執行。');
  }
}
