// 轉接器：把 Meta 的 webhook 事件與 API 回應轉成統一的內部留言格式。
// 平台特有欄位保留在 raw，核心流程只看統一欄位。

const toIso = (t) => {
  if (t == null) return null;
  if (typeof t === 'number') return new Date(t * 1000).toISOString();
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

// webhook 的整包 body → 多筆統一留言事件（非留言事件會被略過並回報在 skipped）
export function normalizeWebhook(body, receivedAt = new Date().toISOString()) {
  const comments = [];
  const skipped = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const c = body.object === 'page'
        ? fromFacebookChange(entry, change, receivedAt)
        : body.object === 'instagram'
          ? fromInstagramChange(entry, change, receivedAt)
          : null;
      if (c) comments.push(c);
      else skipped.push({ object: body.object, field: change.field, item: change.value?.item, verb: change.value?.verb });
    }
  }
  return { comments, skipped };
}

function fromFacebookChange(entry, change, receivedAt) {
  const v = change.value || {};
  if (change.field !== 'feed' || v.item !== 'comment' || !v.comment_id) return null;
  const pageId = String(entry.id);
  // 主留言的 parent_id 是貼文 ID；回覆的 parent_id 是上一層留言 ID
  const isTopLevel = !v.parent_id || v.parent_id === v.post_id;
  // 部分事件（edited、hide 等）用 sender_id／sender_name 取代 from
  const authorId = v.from?.id ?? v.sender_id ?? null;
  return {
    platform: 'facebook',
    account_id: pageId,
    platform_comment_id: v.comment_id,
    parent_comment_id: isTopLevel ? null : v.parent_id,
    content_id: v.post_id || null,
    author_id: authorId,
    author_name: v.from?.name ?? v.sender_name ?? null,
    text: v.message ?? null,
    is_brand: authorId != null && String(authorId) === pageId,
    verb: v.verb || 'add',
    platform_created_at: toIso(v.created_time),
    received_at: receivedAt,
    raw: change,
  };
}

function fromInstagramChange(entry, change, receivedAt) {
  const v = change.value || {};
  if (!['comments', 'live_comments'].includes(change.field) || !v.id) return null;
  const igUserId = String(entry.id);
  return {
    platform: 'instagram',
    account_id: igUserId,
    platform_comment_id: v.id,
    parent_comment_id: v.parent_id || null,
    content_id: v.media?.id || null,
    content_type: v.media?.media_product_type || null,
    // 廣告或加強推廣貼文上的留言會帶 ad_id
    ad_id: v.media?.ad_id || null,
    original_media_id: v.media?.original_media_id || null,
    author_id: v.from?.id ?? null,
    author_name: v.from?.username ?? null,
    text: v.text ?? null,
    is_brand: v.from?.id != null && String(v.from.id) === igUserId,
    verb: 'add',
    // IG 留言 webhook 通常不附留言時間，用 entry.time 近似，之後可用 API 補抓精確時間
    platform_created_at: toIso(entry.time),
    received_at: receivedAt,
    raw: change,
  };
}

// API 讀回的 Facebook 留言 → 統一格式
export function fromFacebookApi(comment, { pageId, postId, parentId = null }) {
  return {
    platform: 'facebook',
    account_id: pageId,
    platform_comment_id: comment.id,
    parent_comment_id: comment.parent?.id || parentId,
    content_id: postId,
    author_id: comment.from?.id ?? null,
    author_name: comment.from?.name ?? null,
    text: comment.message ?? null,
    is_brand: comment.from?.id != null && String(comment.from.id) === String(pageId),
    is_hidden: comment.is_hidden ?? null,
    verb: 'add',
    platform_created_at: toIso(comment.created_time),
    received_at: new Date().toISOString(),
    raw: comment,
  };
}

// API 讀回的 Instagram 留言 → 統一格式
export function fromInstagramApi(comment, { igUserId, mediaId, parentId = null }) {
  const authorId = comment.from?.id ?? null;
  return {
    platform: 'instagram',
    account_id: igUserId,
    platform_comment_id: comment.id,
    parent_comment_id: comment.parent_id || parentId,
    content_id: mediaId,
    author_id: authorId,
    author_name: comment.from?.username ?? comment.username ?? null,
    text: comment.text ?? null,
    is_brand: authorId != null && String(authorId) === String(igUserId),
    is_hidden: comment.hidden ?? null,
    verb: 'add',
    platform_created_at: toIso(comment.timestamp),
    received_at: new Date().toISOString(),
    raw: comment,
  };
}

// 從平台留言時間到系統收到的延遲（秒）
export function latencySeconds(c) {
  if (!c.platform_created_at || !c.received_at) return null;
  return Math.round((Date.parse(c.received_at) - Date.parse(c.platform_created_at)) / 1000);
}
