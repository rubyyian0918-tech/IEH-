// 驗證用的簡易儲存：JSON Lines 檔案放在 data/。正式系統會改用資料庫。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';
import { encrypt, decrypt } from './crypto.js';

function file(name) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  return path.join(DATA_DIR, name);
}

export function append(name, record) {
  fs.appendFileSync(file(name), JSON.stringify(record) + '\n');
}

export function readAll(name) {
  const f = file(name);
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

// ── 留言去重：以「平台＋平台留言 ID」為唯一值 ──
export class CommentStore {
  constructor(name = 'comments.jsonl') {
    this.name = name;
    this.byKey = new Map(readAll(name).map((c) => [c.key, c]));
  }

  static key(platform, platformCommentId) {
    return `${platform}:${platformCommentId}`;
  }

  // 回傳 { inserted: true } 表示新留言；重送的同一則留言回傳 { inserted: false }
  upsert(comment) {
    const key = CommentStore.key(comment.platform, comment.platform_comment_id);
    const existing = this.byKey.get(key);
    if (existing) {
      // 編輯或刪除事件只更新狀態，不新增一筆
      if (comment.verb && comment.verb !== 'add') {
        const updated = { ...existing, last_verb: comment.verb, updated_at: comment.received_at };
        this.byKey.set(key, updated);
        append(this.name, updated);
      }
      return { inserted: false, key };
    }
    const record = { key, ...comment };
    this.byKey.set(key, record);
    append(this.name, record);
    return { inserted: true, key };
  }

  count() {
    return this.byKey.size;
  }
}

// ── token 加密儲存 ──
const TOKENS = 'tokens.enc.json';

export function saveTokens(tokens) {
  const payload = encrypt(JSON.stringify(tokens), config.tokenEncKey);
  fs.writeFileSync(file(TOKENS), JSON.stringify({ saved_at: new Date().toISOString(), payload }), { mode: 0o600 });
}

export function loadTokens() {
  const f = file(TOKENS);
  if (!fs.existsSync(f)) {
    throw new Error('還沒有 token。請先執行 npm run server，再用瀏覽器打開 /login 完成 Facebook 登入授權。');
  }
  return JSON.parse(decrypt(JSON.parse(fs.readFileSync(f, 'utf8')).payload, config.tokenEncKey));
}
