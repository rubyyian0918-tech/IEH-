// 驗證 Meta webhook 的 X-Hub-Signature-256，確認事件真的來自 Meta。
import crypto from 'node:crypto';

export function sign(rawBody, appSecret) {
  return 'sha256=' + crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
}

export function verifySignature(rawBody, header, appSecret) {
  if (!header || !appSecret) return false;
  const expected = Buffer.from(sign(rawBody, appSecret));
  const actual = Buffer.from(header);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

// Meta 的 signed_request（資料刪除回呼、取消授權回呼會用到）
export function parseSignedRequest(signedRequest, appSecret) {
  const [sig, payload] = String(signedRequest || '').split('.');
  if (!sig || !payload) return null;
  const expected = crypto.createHmac('sha256', appSecret).update(payload).digest('base64url');
  const a = Buffer.from(expected);
  const b = Buffer.from(sig.replace(/=+$/, ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
}
