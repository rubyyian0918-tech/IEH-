import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 用臨時資料夾，避免動到真實資料
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-'));
const { encrypt, decrypt, mask } = await import('../src/crypto.js');
const { CommentStore } = await import('../src/store.js');

const KEY = 'a'.repeat(64);

test('token 加密後可還原，且密文不含原文', () => {
  const secret = 'EAAB-page-token-123';
  const enc = encrypt(secret, KEY);
  assert.ok(!enc.includes(secret));
  assert.equal(decrypt(enc, KEY), secret);
  assert.throws(() => decrypt(enc, 'b'.repeat(64)));
  assert.throws(() => encrypt(secret, 'too-short'));
  assert.equal(mask(secret), 'EAAB-p…-123');
});

test('同一平台＋留言 ID 只存一筆；不同平台同 ID 分開存', () => {
  const store = new CommentStore('t1.jsonl');
  const c = { platform: 'facebook', platform_comment_id: 'x1', verb: 'add', text: 'hi' };
  assert.equal(store.upsert(c).inserted, true);
  assert.equal(store.upsert(c).inserted, false);
  assert.equal(store.upsert({ ...c, platform: 'instagram' }).inserted, true);
  assert.equal(store.count(), 2);
});

test('重新載入後仍記得已收過的留言（重啟不會重複建立）', () => {
  new CommentStore('t2.jsonl').upsert({ platform: 'facebook', platform_comment_id: 'y1', verb: 'add' });
  const reloaded = new CommentStore('t2.jsonl');
  assert.equal(reloaded.upsert({ platform: 'facebook', platform_comment_id: 'y1', verb: 'add' }).inserted, false);
});

test('編輯事件只更新狀態，不新增', () => {
  const store = new CommentStore('t3.jsonl');
  store.upsert({ platform: 'facebook', platform_comment_id: 'z1', verb: 'add' });
  store.upsert({ platform: 'facebook', platform_comment_id: 'z1', verb: 'edited', received_at: 'now' });
  assert.equal(store.count(), 1);
  assert.equal(store.byKey.get('facebook:z1').last_verb, 'edited');
});
