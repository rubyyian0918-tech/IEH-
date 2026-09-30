// Facebook 粉專：讀取、回覆／隱藏／刪除、webhook 訂閱、品牌原生回覆、廣告留言。
import fs from 'node:fs';
import path from 'node:path';
import { config, requireConfig, DATA_DIR } from '../config.js';
import { get, post, del, getAll } from '../meta/graph.js';
import { fromFacebookApi } from '../meta/normalize.js';
import { CommentStore } from '../store.js';
import { STATUS, result, pageToken, fromGraphError, requireWrite } from './util.js';

const COMMENT_FIELDS = 'id,message,from{id,name},created_time,parent{id},is_hidden,comment_count,can_hide,can_remove';

// 讀一篇貼文的主留言與底下所有回覆，並存進留言庫（同時就是「補抓」）
async function readThread(postId, token, store) {
  const top = await getAll(`${postId}/comments`, {
    token, params: { fields: COMMENT_FIELDS, filter: 'toplevel', order: 'reverse_chronological', limit: 50 },
  }, 2);
  const out = [];
  for (const c of top) {
    const n = fromFacebookApi(c, { pageId: config.pageId, postId });
    out.push(n);
    store.upsert(n);
    if (c.comment_count > 0) {
      const replies = await getAll(`${c.id}/comments`, { token, params: { fields: COMMENT_FIELDS, limit: 50 } }, 2);
      for (const r of replies) {
        const rn = fromFacebookApi(r, { pageId: config.pageId, postId, parentId: c.id });
        out.push(rn);
        store.upsert(rn);
      }
    }
  }
  return out;
}

export const facebookChecks = {
  'fb-read': {
    title: 'Facebook：讀取粉專貼文與留言（含主留言與底下回覆）',
    async run() {
      requireConfig('pageId');
      const token = pageToken();
      try {
        const posts = await get(`${config.pageId}/published_posts`, {
          token, params: { fields: 'id,message,created_time,permalink_url', limit: 10 },
        });
        const store = new CommentStore();
        const all = [];
        for (const p of posts.data || []) all.push(...(await readThread(p.id, token, store)));
        const top = all.filter((c) => !c.parent_comment_id);
        const withFrom = all.filter((c) => c.author_id).length;
        const ev = {
          posts: posts.data?.length || 0,
          comments_total: all.length,
          top_level: top.length,
          replies: all.length - top.length,
          brand_authored: all.filter((c) => c.is_brand).length,
          comments_with_author: withFrom,
          sample: all.slice(0, 3).map(({ raw, ...c }) => c),
        };
        if (!all.length) return result(STATUS.PENDING, '讀取成功但沒有留言；請先用測試帳號在粉專貼文下留言（含回覆），再執行一次', ev);
        if (withFrom < all.length) {
          return result(STATUS.CONDITIONAL, `可讀取 ${all.length} 則留言，但有 ${all.length - withFrom} 則沒有留言者資訊（開發模式下通常只看得到 App 角色成員，需進階權限）`, ev);
        }
        return result(STATUS.CAN, `可讀取 ${ev.posts} 篇貼文、${ev.top_level} 則主留言、${ev.replies} 則回覆`, ev);
      } catch (err) {
        return fromGraphError(err, '讀取粉專留言');
      }
    },
  },

  'fb-subscribe': {
    title: 'Facebook：讓 App 訂閱粉專的 webhook（feed）',
    async run() {
      requireConfig('pageId');
      const token = pageToken();
      try {
        await post(`${config.pageId}/subscribed_apps`, { token, params: { subscribed_fields: 'feed' } });
        const now = await get(`${config.pageId}/subscribed_apps`, { token });
        return result(STATUS.CAN, '已訂閱 feed。接著在粉專留言，伺服器畫面應在數秒內顯示「新留言」；再執行 webhook-stats 看延遲', { subscribed_apps: now.data });
      } catch (err) {
        return fromGraphError(err, '訂閱粉專 webhook');
      }
    },
  },

  'fb-write': {
    title: 'Facebook：以程式回覆、隱藏、取消隱藏、刪除留言',
    usage: '--comment <留言ID> [--delete-original]（只能用在測試粉專；需 ALLOW_WRITE=true）',
    async run(args) {
      requireConfig('pageId');
      requireWrite();
      if (!args.comment) throw new Error('請指定要測試的留言：npm run check -- fb-write --comment <留言ID>');
      const token = pageToken();
      const steps = [];
      const step = async (name, fn) => {
        try {
          const out = await fn();
          steps.push({ step: name, ok: true, out });
          return out;
        } catch (err) {
          steps.push({ step: name, ok: false, error: err.message, code: err.code });
          return null;
        }
      };
      const target = await step('讀取留言', () => get(args.comment, { token, params: { fields: `${COMMENT_FIELDS},permalink_url` } }));
      if (!target) return result(STATUS.ERROR, '讀不到這則留言，請確認留言 ID 與粉專', { steps });
      if (String(target.from?.id) === config.pageId) {
        return result(STATUS.ERROR, '這則是粉專自己的留言；請改用測試帳號（顧客身分）留的言', { steps });
      }
      const reply = await step('回覆', () => post(`${args.comment}/comments`, {
        token, params: { message: `[技術驗證] 自動回覆測試 ${new Date().toISOString()}` },
      }));
      await step('隱藏', () => post(args.comment, { token, params: { is_hidden: true } }));
      await step('確認已隱藏', () => get(args.comment, { token, params: { fields: 'is_hidden' } }));
      await step('取消隱藏', () => post(args.comment, { token, params: { is_hidden: false } }));
      if (reply?.id) await step('刪除自己的回覆', () => del(reply.id, { token }));
      if (args['delete-original']) await step('刪除顧客留言', () => del(args.comment, { token }));
      const failed = steps.filter((s) => !s.ok);
      return result(
        failed.length ? STATUS.CONDITIONAL : STATUS.CAN,
        failed.length ? `失敗的步驟：${failed.map((s) => s.step).join('、')}` : '回覆、隱藏、取消隱藏、刪除都成功',
        { steps, can_hide: target.can_hide, can_remove: target.can_remove },
      );
    },
  },

  'fb-native-reply': {
    title: 'Facebook：偵測品牌在 FB App 原生發的回覆',
    usage: '先用粉專身分在 FB App 回覆一則測試留言，再執行',
    async run() {
      requireConfig('pageId');
      const token = pageToken();
      try {
        const posts = await get(`${config.pageId}/published_posts`, { token, params: { fields: 'id', limit: 5 } });
        const store = new CommentStore();
        const all = [];
        for (const p of posts.data || []) all.push(...(await readThread(p.id, token, store)));
        const brandReplies = all.filter((c) => c.is_brand && c.parent_comment_id);
        // 從 webhook 進來的留言，raw 是 webhook 的 change（有 field: 'feed'）
        const viaWebhook = [...store.byKey.values()].filter((c) => c.is_brand && c.raw?.field === 'feed');
        const ev = {
          brand_replies_via_api: brandReplies.map(({ raw, ...c }) => c).slice(0, 5),
          brand_events_via_webhook: viaWebhook.length,
        };
        if (!brandReplies.length) return result(STATUS.PENDING, '還沒找到粉專自己發的回覆；請先用粉專身分在 FB App 回覆一則留言', ev);
        return result(
          viaWebhook.length ? STATUS.CAN : STATUS.CONDITIONAL,
          viaWebhook.length
            ? `API 與 webhook 都能辨識品牌回覆（from.id＝粉專 ID），共 ${brandReplies.length} 則`
            : `API 補抓可辨識 ${brandReplies.length} 則品牌回覆；webhook 還沒收到品牌回覆事件（確認伺服器有開、已訂閱 feed）`,
          ev,
        );
      } catch (err) {
        return fromGraphError(err, '偵測品牌原生回覆');
      }
    },
  },

  'fb-ads': {
    title: '廣告留言：查出廣告與貼文的對應，並讀取廣告貼文留言',
    usage: '需要 AD_ACCOUNT_ID，且廣告帳號裡至少有一則投放中的廣告',
    async run() {
      requireConfig('adAccountId', 'pageId');
      const token = pageToken();
      try {
        const ads = await getAll(`act_${config.adAccountId}/ads`, {
          token,
          params: {
            fields: 'id,name,effective_status,creative{id,effective_object_story_id,object_story_id,effective_instagram_media_id,instagram_permalink_url,asset_feed_spec}',
            limit: 50,
          },
        }, 3);
        const map = ads.map((a) => ({
          ad_id: a.id,
          name: a.name,
          status: a.effective_status,
          fb_story_id: a.creative?.effective_object_story_id || a.creative?.object_story_id || null,
          ig_media_id: a.creative?.effective_instagram_media_id || null,
          dynamic_creative: Boolean(a.creative?.asset_feed_spec),
        }));
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(path.join(DATA_DIR, 'ad_map.json'), JSON.stringify(map, null, 2));
        const counts = [];
        for (const m of map.filter((x) => x.fb_story_id).slice(0, 10)) {
          try {
            const c = await get(`${m.fb_story_id}/comments`, { token, params: { summary: 'true', limit: 1, filter: 'stream' } });
            counts.push({ ad_id: m.ad_id, fb_story_id: m.fb_story_id, comments: c.summary?.total_count ?? null });
          } catch (err) {
            counts.push({ ad_id: m.ad_id, fb_story_id: m.fb_story_id, error: err.message });
          }
        }
        const ev = { ads: map.length, with_fb_story: map.filter((m) => m.fb_story_id).length, with_ig_media: map.filter((m) => m.ig_media_id).length, dynamic_creative: map.filter((m) => m.dynamic_creative).length, comment_counts: counts };
        if (!map.length) return result(STATUS.PENDING, '廣告帳號裡沒有廣告；需要至少一則廣告（可用極小預算）才能驗證', ev);
        const note = ev.dynamic_creative ? `；其中 ${ev.dynamic_creative} 則是動態素材，可能對應多篇貼文，需另外確認` : '';
        return result(STATUS.CONDITIONAL, `可從廣告查到對應貼文（${ev.with_fb_story}/${ev.ads}）並讀取留言；需要 ads_read 權限${note}。廣告留言是否會進 webhook，請看 webhook-stats`, ev);
      } catch (err) {
        return fromGraphError(err, '讀取廣告與對應貼文');
      }
    },
  },
};
