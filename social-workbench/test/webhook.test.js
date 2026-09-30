import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sign, verifySignature, parseSignedRequest } from '../src/webhook/signature.js';
import { normalizeWebhook, latencySeconds } from '../src/meta/normalize.js';

test('簽章正確才通過', () => {
  const body = Buffer.from('{"a":1}');
  assert.equal(verifySignature(body, sign(body, 's3cret'), 's3cret'), true);
  assert.equal(verifySignature(body, sign(body, 'other'), 's3cret'), false);
  assert.equal(verifySignature(body, undefined, 's3cret'), false);
  assert.equal(verifySignature(body, 'sha256=short', 's3cret'), false);
});

test('signed_request 解析與竄改偵測', () => {
  const payload = Buffer.from(JSON.stringify({ user_id: '42', algorithm: 'HMAC-SHA256' })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'app').update(payload).digest('base64url');
  assert.equal(parseSignedRequest(`${sig}.${payload}`, 'app').user_id, '42');
  assert.equal(parseSignedRequest(`${sig}.${payload}`, 'wrong'), null);
  assert.equal(parseSignedRequest('garbage', 'app'), null);
});

const fbEvent = (value, pageId = '100') => ({
  object: 'page',
  entry: [{ id: pageId, time: 1790000000, changes: [{ field: 'feed', value }] }],
});

test('FB 主留言：parent_id 等於貼文 ID 時視為主留言', () => {
  const { comments } = normalizeWebhook(fbEvent({
    item: 'comment', verb: 'add', comment_id: 'c1', post_id: '100_1', parent_id: '100_1',
    from: { id: '9', name: '顧客' }, message: '有貨嗎', created_time: 1790000000,
  }), '2026-09-21T14:13:30.000Z');
  assert.equal(comments.length, 1);
  const c = comments[0];
  assert.equal(c.platform, 'facebook');
  assert.equal(c.parent_comment_id, null);
  assert.equal(c.is_brand, false);
  assert.equal(c.platform_created_at, '2026-09-21T14:13:20.000Z');
  assert.equal(latencySeconds(c), 10);
});

test('FB 回覆：粉專自己發的回覆標成品牌回覆', () => {
  const { comments } = normalizeWebhook(fbEvent({
    item: 'comment', verb: 'add', comment_id: 'c2', post_id: '100_1', parent_id: 'c1',
    from: { id: '100', name: '粉專' }, message: '有的喔', created_time: 1790000000,
  }));
  assert.equal(comments[0].parent_comment_id, 'c1');
  assert.equal(comments[0].is_brand, true);
});

test('非留言事件（例如按讚、貼文）會被略過', () => {
  const { comments, skipped } = normalizeWebhook(fbEvent({ item: 'reaction', verb: 'add', post_id: '100_1' }));
  assert.equal(comments.length, 0);
  assert.equal(skipped[0].item, 'reaction');
});

test('IG 留言事件轉成統一格式', () => {
  const { comments } = normalizeWebhook({
    object: 'instagram',
    entry: [{ id: '178', time: 1790000000, changes: [{ field: 'comments', value: {
      id: 'ig1', text: '多少錢', from: { id: '55', username: 'amy' }, media: { id: 'm1', media_product_type: 'REELS' },
    } }] }],
  });
  assert.equal(comments[0].platform, 'instagram');
  assert.equal(comments[0].content_id, 'm1');
  assert.equal(comments[0].content_type, 'REELS');
  assert.equal(comments[0].author_name, 'amy');
  assert.equal(comments[0].is_brand, false);
});
