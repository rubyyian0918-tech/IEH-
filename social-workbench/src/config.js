// 讀取環境設定。所有帳號、金鑰、網址都從 .env 來，不寫死在程式裡。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
export const RESULTS_DIR = path.join(ROOT, 'results');

const env = (name, fallback = '') => (process.env[name] ?? fallback).trim();

export const config = {
  appId: env('META_APP_ID'),
  appSecret: env('META_APP_SECRET'),
  graphVersion: env('META_GRAPH_VERSION', 'v24.0'),
  verifyToken: env('WEBHOOK_VERIFY_TOKEN'),
  publicBaseUrl: env('PUBLIC_BASE_URL').replace(/\/$/, ''),
  port: Number(env('PORT', '3000')),
  pageId: env('FB_PAGE_ID'),
  igUserId: env('IG_USER_ID'),
  adAccountId: env('AD_ACCOUNT_ID').replace(/^act_/, ''),
  tokenEncKey: env('TOKEN_ENC_KEY'),
  allowWrite: env('ALLOW_WRITE') === 'true',
  classifyModel: env('AI_CLASSIFY_MODEL', 'claude-haiku-4-5'),
  suggestModel: env('AI_SUGGEST_MODEL', 'claude-opus-5-5'),
};

// 缺少設定時，用白話告訴使用者要補哪一項
export function requireConfig(...keys) {
  const missing = keys.filter((k) => !config[k]);
  if (missing.length) {
    const names = {
      appId: 'META_APP_ID', appSecret: 'META_APP_SECRET', verifyToken: 'WEBHOOK_VERIFY_TOKEN',
      publicBaseUrl: 'PUBLIC_BASE_URL', pageId: 'FB_PAGE_ID', igUserId: 'IG_USER_ID',
      adAccountId: 'AD_ACCOUNT_ID', tokenEncKey: 'TOKEN_ENC_KEY',
    };
    throw new Error(`.env 缺少設定：${missing.map((k) => names[k] || k).join('、')}`);
  }
}
