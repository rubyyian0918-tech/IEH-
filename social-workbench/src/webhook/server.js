// 驗證用伺服器：
//   /login、/callback          Facebook 登入授權
//   /webhook                   接收 Meta webhook（先存原始事件、立即回應，再背景處理）
//   /meta/deauthorize          取消授權回呼
//   /meta/data-deletion        資料刪除回呼（Meta 要求）
import http from 'node:http';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { verifySignature, parseSignedRequest } from './signature.js';
import { normalizeWebhook, latencySeconds } from '../meta/normalize.js';
import { CommentStore, append, readAll } from '../store.js';
import { loginUrl, handleCallback } from '../meta/auth.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function page(title, html) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>body{font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem}
code,pre{background:#f3f3f3;padding:.1rem .3rem;border-radius:4px}pre{padding:1rem;overflow:auto}</style>
<h1>${esc(title)}</h1>${html}`;
}

// ── 背景處理佇列：webhook 收到後只存檔、放進佇列，不在接收當下做其他事 ──
const queue = [];
let draining = false;
export function createProcessor(store = new CommentStore(), { prefix = '' } = {}) {
  return function processEvent(event) {
    const { comments, skipped } = normalizeWebhook(event.body, event.received_at);
    const results = comments.map((c) => {
      const r = store.upsert(c);
      const lat = latencySeconds(c);
      append(`${prefix}webhook_latency.jsonl`, {
        key: r.key, platform: c.platform, verb: c.verb, is_brand: c.is_brand,
        duplicate: !r.inserted, latency_seconds: lat, received_at: c.received_at,
      });
      return { key: r.key, inserted: r.inserted, is_brand: c.is_brand, latency_seconds: lat };
    });
    return { results, skipped };
  };
}

function enqueue(event, processEvent, prefix) {
  queue.push(event);
  if (draining) return;
  draining = true;
  setImmediate(() => {
    while (queue.length) {
      const e = queue.shift();
      try {
        const out = processEvent(e);
        append(`${prefix}webhook_events_status.jsonl`, { id: e.id, status: 'processed', ...out });
        for (const r of out.results) {
          console.log(`[webhook] ${r.inserted ? '新留言' : '重複（已去重）'} ${r.key}${r.is_brand ? '（品牌自己發的）' : ''}，延遲 ${r.latency_seconds ?? '?'} 秒`);
        }
      } catch (err) {
        append(`${prefix}webhook_events_status.jsonl`, { id: e.id, status: 'error', error: err.message });
        console.error('[webhook] 處理失敗', err.message);
      }
    }
    draining = false;
  });
}

// prefix：自我測試時把紀錄寫到不同檔名，不混進真實統計
export function createServer({ prefix = '', processEvent = createProcessor(undefined, { prefix }) } = {}) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    try {
      // 首頁：狀態與操作連結
      if (req.method === 'GET' && url.pathname === '/') {
        const events = readAll('webhook_events.jsonl').length;
        return send(res, 200, page('社群經營工作台｜技術驗證', `
<p>伺服器運作中。已收到 webhook 事件：<b>${events}</b> 筆。</p>
<ol><li><a href="/login">用 Facebook 登入並授權粉專</a></li>
<li>Webhook 網址：<code>${esc((config.publicBaseUrl || '(尚未設定 PUBLIC_BASE_URL)') + '/webhook')}</code></li>
<li>資料刪除回呼：<code>${esc((config.publicBaseUrl || '') + '/meta/data-deletion')}</code></li>
<li>取消授權回呼：<code>${esc((config.publicBaseUrl || '') + '/meta/deauthorize')}</code></li></ol>`), 'text/html; charset=utf-8');
      }

      if (req.method === 'GET' && url.pathname === '/login') {
        res.writeHead(302, { location: loginUrl() });
        return res.end();
      }

      if (req.method === 'GET' && url.pathname === '/callback') {
        if (url.searchParams.get('error')) {
          return send(res, 400, page('授權失敗', `<p>${esc(url.searchParams.get('error_description') || url.searchParams.get('error'))}</p>`), 'text/html; charset=utf-8');
        }
        const out = await handleCallback({ code: url.searchParams.get('code'), state: url.searchParams.get('state') });
        return send(res, 200, page('授權完成', `<p>已用 <b>${esc(out.user)}</b> 登入，token 已加密儲存。</p>
<h2>可管理的粉專</h2><pre>${esc(JSON.stringify(out.pages, null, 2))}</pre>
<h2>已授予的權限</h2><pre>${esc(out.granted_scopes.join('\n'))}</pre>
<p>把要測試的粉專 ID 填進 .env 的 <code>FB_PAGE_ID</code>，Instagram ID 填進 <code>IG_USER_ID</code>。</p>`), 'text/html; charset=utf-8');
      }

      // Meta 設定 webhook 時的驗證請求
      if (req.method === 'GET' && url.pathname === '/webhook') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe' && config.verifyToken
          && url.searchParams.get('hub.verify_token') === config.verifyToken;
        return ok ? send(res, 200, url.searchParams.get('hub.challenge') || '') : send(res, 403, 'verify token 不符');
      }

      if (req.method === 'POST' && url.pathname === '/webhook') {
        const raw = await readBody(req);
        if (!verifySignature(raw, req.headers['x-hub-signature-256'], config.appSecret)) {
          append(`${prefix}webhook_rejected.jsonl`, { at: new Date().toISOString(), reason: 'bad_signature' });
          return send(res, 401, 'invalid signature');
        }
        const event = {
          id: crypto.randomUUID(),
          received_at: new Date().toISOString(),
          body: JSON.parse(raw.toString('utf8')),
        };
        append(`${prefix}webhook_events.jsonl`, event); // 先存原始事件
        send(res, 200, 'EVENT_RECEIVED'); // 立即回應平台
        return enqueue(event, processEvent, prefix); // 再背景處理
      }

      // 取消授權回呼：使用者移除 App 時 Meta 會通知
      if (req.method === 'POST' && url.pathname === '/meta/deauthorize') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const data = parseSignedRequest(form.get('signed_request'), config.appSecret);
        if (!data) return send(res, 400, 'bad signed_request');
        append('deauthorize.jsonl', { at: new Date().toISOString(), user_id: data.user_id });
        console.warn(`[授權] 使用者 ${data.user_id} 取消授權，需通知組織管理員並停用連線`);
        return send(res, 200, 'ok');
      }

      // 資料刪除回呼：回傳查詢網址與確認碼
      if (req.method === 'POST' && url.pathname === '/meta/data-deletion') {
        const form = new URLSearchParams((await readBody(req)).toString('utf8'));
        const data = parseSignedRequest(form.get('signed_request'), config.appSecret);
        if (!data) return send(res, 400, 'bad signed_request');
        const code = crypto.randomBytes(8).toString('hex');
        append('data_deletion.jsonl', { at: new Date().toISOString(), user_id: data.user_id, code, status: 'received' });
        return send(res, 200, { url: `${config.publicBaseUrl}/meta/data-deletion/status?code=${code}`, confirmation_code: code }, 'application/json');
      }

      if (req.method === 'GET' && url.pathname === '/meta/data-deletion/status') {
        const rec = readAll('data_deletion.jsonl').find((r) => r.code === url.searchParams.get('code'));
        return send(res, rec ? 200 : 404, page('資料刪除狀態', rec ? `<p>確認碼 ${esc(rec.code)}：已收到刪除請求（${esc(rec.at)}）。</p>` : '<p>查無此確認碼。</p>'), 'text/html; charset=utf-8');
      }

      send(res, 404, 'not found');
    } catch (err) {
      console.error(err);
      send(res, 500, page('發生錯誤', `<p>${esc(err.message)}</p>`), 'text/html; charset=utf-8');
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(config.port, () => {
    console.log(`伺服器已啟動：http://localhost:${config.port}`);
    console.log(config.publicBaseUrl ? `對外網址：${config.publicBaseUrl}` : '提醒：尚未設定 PUBLIC_BASE_URL，Meta 無法把 webhook 送到這台電腦');
  });
}
