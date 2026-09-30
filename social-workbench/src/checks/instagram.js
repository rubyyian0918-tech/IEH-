// Instagram 商業帳號：讀取貼文與 Reels 留言、回覆、隱藏、刪除；按讚／封鎖；廣告留言。
import fs from 'node:fs';
import path from 'node:path';
import { config, requireConfig, DATA_DIR } from '../config.js';
import { get, post, del, getAll } from '../meta/graph.js';
import { fromInstagramApi } from '../meta/normalize.js';
import { CommentStore } from '../store.js';
import { STATUS, result, pageToken, fromGraphError, requireWrite } from './util.js';

const IG_COMMENT_FIELDS = 'id,text,timestamp,from{id,username},username,hidden,like_count,parent_id';

async function readMediaComments(mediaId, token, store) {
  const out = [];
  const top = await getAll(`${mediaId}/comments`, {
    token, params: { fields: `${IG_COMMENT_FIELDS},replies{${IG_COMMENT_FIELDS}}`, limit: 50 },
  }, 2);
  for (const c of top) {
    const n = fromInstagramApi(c, { igUserId: config.igUserId, mediaId });
    out.push(n);
    store.upsert(n);
    for (const r of c.replies?.data || []) {
      const rn = fromInstagramApi(r, { igUserId: config.igUserId, mediaId, parentId: c.id });
      out.push(rn);
      store.upsert(rn);
    }
  }
  return out;
}

export const instagramChecks = {
  'ig-read': {
    title: 'Instagram：讀取貼文與 Reels 留言（含回覆）',
    async run() {
      requireConfig('igUserId', 'pageId');
      const token = pageToken();
      try {
        const media = await get(`${config.igUserId}/media`, {
          token, params: { fields: 'id,caption,media_type,media_product_type,timestamp,comments_count,permalink', limit: 15 },
        });
        const store = new CommentStore();
        const all = [];
        for (const m of media.data || []) {
          if (m.comments_count > 0) all.push(...(await readMediaComments(m.id, token, store)));
        }
        const types = [...new Set((media.data || []).map((m) => m.media_product_type))];
        const ev = {
          media: media.data?.length || 0,
          media_types: types,
          reels_with_comments: (media.data || []).filter((m) => m.media_product_type === 'REELS' && m.comments_count > 0).length,
          comments_total: all.length,
          replies: all.filter((c) => c.parent_comment_id).length,
          brand_authored: all.filter((c) => c.is_brand).length,
          with_author_id: all.filter((c) => c.author_id).length,
          sample: all.slice(0, 3).map(({ raw, ...c }) => c),
        };
        if (!all.length) return result(STATUS.PENDING, '讀取成功但沒有留言；請在一般貼文和 Reels 各留一則言（含回覆）再執行', ev);
        const note = ev.reels_with_comments ? '' : '（還沒測到 Reels 留言）';
        return result(STATUS.CAN, `可讀取 ${ev.media} 則貼文、${ev.comments_total} 則留言${note}`, ev);
      } catch (err) {
        return fromGraphError(err, '讀取 Instagram 留言');
      }
    },
  },

  'ig-write': {
    title: 'Instagram：以程式回覆、隱藏、取消隱藏、刪除留言',
    usage: '--comment <IG留言ID> [--delete-original]（只能用在測試帳號；需 ALLOW_WRITE=true）',
    async run(args) {
      requireConfig('igUserId', 'pageId');
      requireWrite();
      if (!args.comment) throw new Error('請指定要測試的留言：npm run check -- ig-write --comment <IG留言ID>');
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
      const target = await step('讀取留言', () => get(args.comment, { token, params: { fields: IG_COMMENT_FIELDS } }));
      if (!target) return result(STATUS.ERROR, '讀不到這則留言，請確認留言 ID', { steps });
      const reply = await step('回覆', () => post(`${args.comment}/replies`, {
        token, params: { message: `[技術驗證] 自動回覆測試 ${new Date().toISOString()}` },
      }));
      await step('隱藏', () => post(args.comment, { token, params: { hide: true } }));
      await step('取消隱藏', () => post(args.comment, { token, params: { hide: false } }));
      if (reply?.id) await step('刪除自己的回覆', () => del(reply.id, { token }));
      if (args['delete-original']) await step('刪除顧客留言', () => del(args.comment, { token }));
      const failed = steps.filter((s) => !s.ok);
      return result(
        failed.length ? STATUS.CONDITIONAL : STATUS.CAN,
        failed.length ? `失敗的步驟：${failed.map((s) => s.step).join('、')}` : '回覆、隱藏、取消隱藏、刪除都成功',
        { steps },
      );
    },
  },

  'ig-like-block': {
    title: 'Instagram：對留言按讚、封鎖用戶',
    usage: '--comment <IG留言ID>（只會嘗試按讚，不會封鎖任何人；需 ALLOW_WRITE=true）',
    async run(args) {
      requireConfig('igUserId', 'pageId');
      requireWrite();
      if (!args.comment) throw new Error('請指定要測試的留言：npm run check -- ig-like-block --comment <IG留言ID>');
      const token = pageToken();
      const attempts = [];
      // 嘗試按讚：若平台沒有這個功能，會回傳錯誤，這正是要記錄的結果
      try {
        await post(`${args.comment}/likes`, { token });
        attempts.push({ action: 'like', ok: true });
      } catch (err) {
        attempts.push({ action: 'like', ok: false, code: err.code, error: err.message });
      }
      const liked = attempts[0].ok;
      return result(
        liked ? STATUS.CAN : STATUS.CANNOT,
        `${liked ? '按讚成功' : '按讚失敗（2026-04 起需 instagram_manage_engagement 權限，請在 META_EXTRA_SCOPES 加上後重新 /login 再試；端點以官方文件為準）'}；封鎖用戶沒有公開 API，不實測`,
        { attempts },
      );
    },
  },

  'ig-ads': {
    title: 'Instagram 廣告留言：從廣告查出 IG 媒體並讀取留言',
    usage: '先執行 fb-ads 產生廣告對應表',
    async run() {
      requireConfig('igUserId', 'pageId');
      const f = path.join(DATA_DIR, 'ad_map.json');
      if (!fs.existsSync(f)) return result(STATUS.PENDING, '還沒有廣告對應表；請先執行 fb-ads');
      const map = JSON.parse(fs.readFileSync(f, 'utf8')).ads.filter((m) => m.ig_media_id);
      if (!map.length) return result(STATUS.PENDING, '廣告裡沒有 Instagram 版位的素材；請投放一則含 IG 版位的廣告');
      const token = pageToken();
      const store = new CommentStore();
      const counts = [];
      for (const m of map.slice(0, 10)) {
        try {
          const cs = await readMediaComments(m.ig_media_id, token, store);
          counts.push({ ad_id: m.ad_id, ig_media_id: m.ig_media_id, comments: cs.length });
        } catch (err) {
          counts.push({ ad_id: m.ad_id, ig_media_id: m.ig_media_id, error: err.message, code: err.code });
        }
      }
      const ok = counts.filter((c) => !c.error);
      if (!ok.length) return fromGraphError(Object.assign(new Error(counts[0].error), { code: counts[0].code }), '讀取 IG 廣告留言');
      return result(STATUS.CONDITIONAL, `可從廣告查到 IG 媒體並讀取留言（${ok.length}/${counts.length}）。是否能即時收到，看 webhook-stats；收不到就只能輪詢`, { counts });
    },
  },
};
