// Graph API 呼叫：統一處理版本、appsecret_proof、錯誤判讀與用量標頭。
import crypto from 'node:crypto';
import { config } from '../config.js';

export class GraphError extends Error {
  constructor(status, body) {
    const e = body?.error || {};
    super(`Graph API 錯誤 ${status}：${e.message || JSON.stringify(body)}`);
    this.status = status;
    this.code = e.code;
    this.subcode = e.error_subcode;
    this.type = e.type;
    this.fbtraceId = e.fbtrace_id;
  }

  // code 190 = token 無效（過期、被撤銷、密碼變更、App 被移除等）
  get isTokenInvalid() {
    return this.code === 190;
  }

  // 常見的限流錯誤碼
  get isRateLimited() {
    return [4, 17, 32, 613, 80001, 80002, 80004, 80005, 80006].includes(this.code);
  }

  // 權限不足或功能不支援
  get isPermission() {
    return this.code === 10 || this.code === 200 || (this.code >= 200 && this.code < 300);
  }
}

// code 190 的子代碼 → 白話原因（依官方錯誤處理文件）
export const TOKEN_SUBCODES = {
  458: '使用者移除了 App',
  459: '帳號被 Facebook 安全檢查鎖定',
  460: '使用者變更了密碼',
  463: 'token 已過期',
  464: '使用者帳號未確認',
  467: 'token 無效（例如已登出）',
  492: '工作階段無效（常見於失去粉專管理角色）',
};

export function tokenInvalidReason(err) {
  return TOKEN_SUBCODES[err?.subcode] || 'token 無效';
}

export function appSecretProof(token, secret = config.appSecret) {
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

const base = () => `https://graph.facebook.com/${config.graphVersion}`;

// 最近一次呼叫的用量標頭，給限流觀察用
export const lastUsage = {};

export async function graph(method, pathname, { token, params = {}, body } = {}) {
  const url = new URL(pathname.startsWith('http') ? pathname : `${base()}/${pathname.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
  if (token) {
    url.searchParams.set('access_token', token);
    if (config.appSecret) url.searchParams.set('appsecret_proof', appSecretProof(token));
  }
  const init = { method };
  if (body) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  for (const h of ['x-app-usage', 'x-business-use-case-usage', 'x-page-usage', 'x-ad-account-usage']) {
    const v = res.headers.get(h);
    if (v) lastUsage[h] = v;
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new GraphError(res.status, json);
  return json;
}

export const get = (p, opts) => graph('GET', p, opts);
export const post = (p, opts) => graph('POST', p, opts);
export const del = (p, opts) => graph('DELETE', p, opts);

// 依 paging.next 自動翻頁，最多 maxPages 頁
export async function getAll(pathname, opts = {}, maxPages = 5) {
  const out = [];
  let page = await get(pathname, opts);
  for (let i = 0; ; i++) {
    out.push(...(page.data || []));
    if (!page.paging?.next || i + 1 >= maxPages) break;
    page = await get(page.paging.next, { token: undefined });
  }
  return out;
}
