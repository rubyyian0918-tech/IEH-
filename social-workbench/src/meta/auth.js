// Facebook 登入授權：取得長效使用者 token，再換成各粉專的 token，加密存檔。
import crypto from 'node:crypto';
import { config, requireConfig } from '../config.js';
import { get } from './graph.js';
import { saveTokens } from '../store.js';

// 技術驗證要測的權限。實際要申請審查的清單以驗證結果為準。
export const SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_read_user_content',
  'pages_manage_engagement',
  'pages_manage_metadata',
  'business_management',
  'ads_read',
  'instagram_basic',
  'instagram_manage_comments',
];

export const redirectUri = () => `${config.publicBaseUrl || `http://localhost:${config.port}`}/callback`;

const pendingStates = new Set();

export function loginUrl() {
  requireConfig('appId');
  const state = crypto.randomBytes(16).toString('hex');
  pendingStates.add(state);
  const u = new URL(`https://www.facebook.com/${config.graphVersion}/dialog/oauth`);
  u.searchParams.set('client_id', config.appId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('state', state);
  u.searchParams.set('scope', [...SCOPES, ...config.extraScopes].join(','));
  return u.toString();
}

export async function handleCallback({ code, state }) {
  requireConfig('appId', 'appSecret', 'tokenEncKey');
  if (!pendingStates.delete(state)) throw new Error('登入狀態不符（state），請重新從 /login 開始');

  const short = await get('oauth/access_token', {
    params: { client_id: config.appId, client_secret: config.appSecret, redirect_uri: redirectUri(), code },
  });
  const long = await get('oauth/access_token', {
    params: {
      grant_type: 'fb_exchange_token',
      client_id: config.appId,
      client_secret: config.appSecret,
      fb_exchange_token: short.access_token,
    },
  });
  const userToken = long.access_token;
  const me = await get('me', { token: userToken, params: { fields: 'id,name' } });
  const accounts = await get('me/accounts', {
    token: userToken,
    params: { fields: 'id,name,access_token,tasks,instagram_business_account{id,username}', limit: 100 },
  });
  const pages = (accounts.data || []).map((p) => ({
    id: p.id,
    name: p.name,
    tasks: p.tasks,
    access_token: p.access_token,
    instagram: p.instagram_business_account || null,
  }));
  saveTokens({
    obtained_at: new Date().toISOString(),
    user: { id: me.id, name: me.name, access_token: userToken, expires_in: long.expires_in ?? null },
    pages,
  });
  // 回傳給畫面的資料不含 token
  return {
    user: me.name,
    granted_scopes: await grantedScopes(userToken),
    pages: pages.map(({ access_token, ...rest }) => rest),
  };
}

export async function grantedScopes(userToken) {
  const res = await get('me/permissions', { token: userToken });
  return (res.data || []).map((p) => `${p.permission}:${p.status}`);
}
