// 平台 token 加密儲存（AES-256-GCM）。token 不寫進日誌、不出現在畫面。
import crypto from 'node:crypto';

function keyFrom(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex || '')) {
    throw new Error('TOKEN_ENC_KEY 必須是 64 個 0-9a-f 字元（見 .env.example 的產生方式）');
  }
  return Buffer.from(hex, 'hex');
}

export function encrypt(plaintext, keyHex) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFrom(keyHex), iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
}

export function decrypt(payload, keyHex) {
  const [iv, tag, data] = payload.split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFrom(keyHex), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

// 日誌裡只顯示 token 的前後幾碼
export function mask(token) {
  if (!token) return '(無)';
  return token.length <= 12 ? '****' : `${token.slice(0, 6)}…${token.slice(-4)}`;
}
