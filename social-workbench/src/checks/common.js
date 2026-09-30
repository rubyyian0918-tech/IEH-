// 共通驗證：授權、token 健康檢查、webhook 統計、去重自我測試。
import fs from 'node:fs';
import path from 'node:path';
import { config, requireConfig, DATA_DIR } from '../config.js';
import { get } from '../meta/graph.js';
import { grantedScopes } from '../meta/auth.js';
import { loadTokens, readAll, CommentStore } from '../store.js';
import { mask } from '../crypto.js';
import { sign } from '../webhook/signature.js';
import { createServer, createProcessor } from '../webhook/server.js';
import { STATUS, result, fromGraphError } from './util.js';

const percentile = (arr, p) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

export const commonChecks = {
  pages: {
    title: '授權：Facebook 登入後取得並安全儲存粉專 token',
    async run() {
      const t = loadTokens();
      let scopes = [];
      try {
        scopes = await grantedScopes(t.user.access_token);
      } catch (err) {
        return fromGraphError(err, '讀取已授予權限');
      }
      const ev = {
        user: t.user.name,
        user_token: mask(t.user.access_token),
        obtained_at: t.obtained_at,
        pages: t.pages.map((p) => ({ id: p.id, name: p.name, token: mask(p.access_token), instagram: p.instagram })),
        granted_scopes: scopes,
      };
      const declined = scopes.filter((s) => !s.endsWith(':granted'));
      if (!t.pages.length) return result(STATUS.CONDITIONAL, '登入成功但沒有任何粉專；授權時要勾選測試粉專', ev);
      return result(
        declined.length ? STATUS.CONDITIONAL : STATUS.CAN,
        `取得 ${t.pages.length} 個粉專的 token，已加密儲存${declined.length ? `；未授予：${declined.join('、')}` : ''}`,
        ev,
      );
    },
  },

  'token-health': {
    title: '授權失效偵測：token 過期或被撤銷時能否偵測',
    usage: '先執行一次（正常狀態），再到 Facebook 設定 → 商業整合 移除這個 App 後再執行一次',
    async run() {
      requireConfig('appId', 'appSecret');
      const t = loadTokens();
      const appToken = `${config.appId}|${config.appSecret}`;
      const inspect = async (label, token) => {
        try {
          const d = (await get('debug_token', { params: { input_token: token, access_token: appToken } })).data;
          return {
            label, is_valid: d.is_valid, type: d.type,
            expires_at: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : '不會過期',
            data_access_expires_at: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : null,
            scopes: d.scopes, error: d.error || null,
          };
        } catch (err) {
          return { label, is_valid: false, error: err.message, code: err.code };
        }
      };
      const checks = [await inspect('使用者 token', t.user.access_token)];
      for (const p of t.pages) checks.push(await inspect(`粉專 ${p.name}`, p.access_token));
      const invalid = checks.filter((c) => !c.is_valid);
      return result(
        STATUS.CAN,
        invalid.length
          ? `偵測到 ${invalid.length} 個失效的 token（${invalid.map((c) => c.label).join('、')}）——失效偵測有效，正式系統要在這時通知組織管理員`
          : '所有 token 都有效。請移除 App 授權後再執行一次，確認能偵測到失效',
        { tokens: checks },
      );
    },
  },

  'webhook-stats': {
    title: 'Webhook：即時通知是否穩定、延遲多久、是否包含品牌回覆與廣告留言',
    async run() {
      const lat = readAll('webhook_latency.jsonl');
      const events = readAll('webhook_events.jsonl');
      if (!events.length) return result(STATUS.PENDING, '還沒收到任何 webhook 事件；確認伺服器有開、PUBLIC_BASE_URL 可從外部連到，並已執行 fb-subscribe');
      const adMapFile = path.join(DATA_DIR, 'ad_map.json');
      const adMap = fs.existsSync(adMapFile) ? JSON.parse(fs.readFileSync(adMapFile, 'utf8')) : [];
      const adFbPosts = new Set(adMap.map((m) => m.fb_story_id).filter(Boolean));
      const adIgMedia = new Set(adMap.map((m) => m.ig_media_id).filter(Boolean));
      const store = new CommentStore();
      const fromWebhook = [...store.byKey.values()].filter((c) => c.raw?.field);
      const by = (platform) => {
        const rows = lat.filter((r) => r.platform === platform && !r.duplicate && r.latency_seconds != null);
        const secs = rows.map((r) => r.latency_seconds);
        return { events: lat.filter((r) => r.platform === platform).length, p50_seconds: percentile(secs, 50), p95_seconds: percentile(secs, 95), max_seconds: secs.length ? Math.max(...secs) : null };
      };
      const ev = {
        raw_events: events.length,
        facebook: by('facebook'),
        instagram: by('instagram'),
        duplicates_seen: lat.filter((r) => r.duplicate).length,
        brand_events: lat.filter((r) => r.is_brand).length,
        fb_ad_comment_events: fromWebhook.filter((c) => c.platform === 'facebook' && adFbPosts.has(c.content_id)).length,
        ig_ad_comment_events: fromWebhook.filter((c) => c.platform === 'instagram' && adIgMedia.has(c.content_id)).length,
        rejected_bad_signature: readAll('webhook_rejected.jsonl').length,
      };
      return result(STATUS.CAN, `收到 ${ev.raw_events} 筆事件；FB 延遲中位數 ${ev.facebook.p50_seconds ?? '-'} 秒，IG ${ev.instagram.p50_seconds ?? '-'} 秒；廣告留言事件 FB ${ev.fb_ad_comment_events}、IG ${ev.ig_ad_comment_events}`, ev);
    },
  },

  dedupe: {
    title: '去重：同一則留言重複推送時，只存一筆',
    async run() {
      // 自我測試：在本機開一個臨時伺服器，送同一個已簽章的事件兩次，再送一個簽章錯誤的事件
      const secret = config.appSecret || 'selftest-secret';
      const prevSecret = config.appSecret;
      config.appSecret = secret;
      const prefix = `selftest-${Date.now()}-`;
      const store = new CommentStore(`${prefix}comments.jsonl`);
      const server = createServer({ prefix, processEvent: createProcessor(store, { prefix }) });
      await new Promise((r) => server.listen(0, r));
      const url = `http://127.0.0.1:${server.address().port}/webhook`;
      const body = JSON.stringify({
        object: 'page',
        entry: [{ id: '111', time: Math.floor(Date.now() / 1000), changes: [{ field: 'feed', value: {
          item: 'comment', verb: 'add', comment_id: '111_222_333', post_id: '111_222', parent_id: '111_222',
          from: { id: '999', name: '測試顧客' }, message: '請問有貨嗎？', created_time: Math.floor(Date.now() / 1000),
        } }] }],
      });
      const postIt = (sig) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
      try {
        const r1 = await postIt(sign(body, secret));
        const r2 = await postIt(sign(body, secret));
        const r3 = await postIt('sha256=bad');
        await new Promise((r) => setTimeout(r, 100));
        const ev = { first: r1.status, resend: r2.status, bad_signature: r3.status, stored: store.count() };
        const ok = r1.status === 200 && r2.status === 200 && r3.status === 401 && store.count() === 1;
        // 同時統計真實 webhook 裡看到的重送次數
        ev.real_duplicates_seen = readAll('webhook_latency.jsonl').filter((r) => r.duplicate).length;
        return result(ok ? STATUS.CAN : STATUS.ERROR, ok ? '重送兩次只存一筆，簽章錯誤的事件被拒絕' : '去重或簽章驗證不如預期', ev);
      } finally {
        server.close();
        config.appSecret = prevSecret;
        for (const f of fs.readdirSync(DATA_DIR)) if (f.startsWith(prefix)) fs.rmSync(path.join(DATA_DIR, f));
      }
    },
  },
};
