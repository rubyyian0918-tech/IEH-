# 社群經營工作台｜階段 0 技術驗證工具

這**不是**正式系統，是一支可以重複執行的小程式，用來確認 Meta 平台（Facebook 粉專＋Instagram）實際上能做什麼。
每個驗證項目執行後會得到「可做／不可做／有條件／待實測」的結論，最後整理成一份報告。

- **先讀這份**：初步結論與 MVP 範圍建議 [`docs/phase0-findings.md`](docs/phase0-findings.md)
- 官方文件研究的總表：[`docs/capability-matrix.md`](docs/capability-matrix.md)
- 實測結果：執行後產生在 `results/REPORT.md`

> 為什麼要在你自己的電腦上執行？Claude Code 的雲端環境目前連不到 Facebook，所以實測要在你的電腦（或之後的主機）上跑。

---

## 它怎麼運作（白話版）

```
Facebook／Instagram ──(有人留言)──▶ webhook 網址 ──▶ 本機伺服器
                                                   1. 驗證簽章（確定是 Meta 送來的）
                                                   2. 原始事件先存檔
                                                   3. 立刻回應 Meta「收到了」
                                                   4. 背景整理成統一格式、去重、記錄延遲
你 ──▶ npm run check -- <項目> ──▶ 呼叫 Graph API 讀取／回覆／隱藏 ──▶ 結果存在 results/
```

- **token 加密儲存**：登入授權後拿到的 token 用 `TOKEN_ENC_KEY` 加密存在 `data/`，畫面與日誌只顯示前後幾碼。
- **去重**：以「平台＋平台留言 ID」當唯一值，同一則留言重送幾次都只存一筆。
- **影子模式**：預設 `ALLOW_WRITE=false`，只讀不發。只有回覆／隱藏／刪除的驗證需要打開，而且只能用在你自己的測試粉專。

---

## 一次性準備

### 1. 安裝 Node.js
到 <https://nodejs.org> 下載 **22 版以上**（選 LTS）。安裝後在終端機輸入 `node -v`，看到 `v22` 以上就可以。

### 2. 下載這份程式並安裝套件
```bash
cd social-workbench
npm install
```

### 3. 建立 Meta App（開發模式）
1. 用個人 Facebook 帳號到 <https://developers.facebook.com> 註冊成為開發者。
2. 建立 App，類型選「商家（Business）」相關的用途，加入以下產品：
   - Facebook 登入（Facebook Login）
   - Webhooks
   - Instagram（使用 Facebook 登入的 Instagram API）
3. 到「設定 → 基本資料」抄下 **App ID** 和 **App Secret**。
4. 暫時不用送審。開發模式下，**App 角色成員**（管理員、開發者、測試人員）都能使用。設計夥伴的粉專管理員要先加成測試人員。

> Meta 後台的選單名稱常改，找不到時以官方文件為準，或把畫面截圖給 Claude Code 看。

### 4. 準備測試用粉專與 Instagram
- 建一個測試用粉專，並把一個 Instagram **商業或創作者帳號**連結到這個粉專。
- 找另一個個人帳號當「顧客」，在粉專貼文和 IG 貼文、Reels 下面留言，並互相回覆幾則。

### 5. 讓 Meta 找得到你的電腦（對外網址）
Meta 的 webhook 需要一個 `https://` 開頭、外部連得到的網址。最簡單的方法是 Cloudflare Tunnel（免註冊）：

```bash
# macOS：brew install cloudflared      Windows：winget install --id Cloudflare.cloudflared
cloudflared tunnel --url http://localhost:3000
```

畫面會出現類似 `https://xxxx-xxxx.trycloudflare.com` 的網址，填到 `.env` 的 `PUBLIC_BASE_URL`。
注意：這種臨時網址**每次重開都會變**，變了就要回 Meta 後台更新 webhook 網址與登入的重新導向網址。

### 6. 填寫設定檔
```bash
cp .env.example .env
```
打開 `.env` 依說明填入。`TOKEN_ENC_KEY` 用這行產生：
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### 7. 在 Meta 後台填網址
啟動伺服器（`npm run server`）後，打開 <http://localhost:3000> 會列出要填的網址：

| Meta 後台位置 | 要填的值 |
|---|---|
| Facebook 登入 → 設定 → 有效的 OAuth 重新導向 URI | `<PUBLIC_BASE_URL>/callback` |
| Webhooks → Page → 回呼網址／驗證權杖 | `<PUBLIC_BASE_URL>/webhook`／`.env` 的 `WEBHOOK_VERIFY_TOKEN`，並訂閱 `feed` |
| Webhooks → Instagram → 回呼網址／驗證權杖 | 同上，並訂閱 `comments`、`live_comments` |
| 設定 → 基本資料 → 資料刪除要求網址 | `<PUBLIC_BASE_URL>/meta/data-deletion` |
| Facebook 登入 → 設定 → 取消授權回呼網址 | `<PUBLIC_BASE_URL>/meta/deauthorize` |

---

## 開始驗證

開兩個終端機視窗：一個跑 `cloudflared`，一個跑 `npm run server`。再開第三個執行下面的指令。

| 順序 | 指令 | 你要做的事 |
|---|---|---|
| 1 | 瀏覽器打開 `http://localhost:3000/login` | 用 Facebook 登入，勾選測試粉專與 IG。完成後把畫面上的粉專 ID、IG ID 填進 `.env` |
| 2 | `npm run check -- pages` | 確認拿到 token、權限都有授予 |
| 3 | `npm run check -- fb-subscribe` | 讓 App 訂閱粉專；接著用「顧客」帳號留言，伺服器視窗應在幾秒內出現「新留言」 |
| 3b | 同上 | **最關鍵的一題**：再請一個「不是 App 角色成員」的朋友留言，看伺服器有沒有收到。開發模式下可能只收得到 App 角色成員的留言，這決定影子模式能不能在送審前就接真實客戶 |
| 4 | `npm run check -- fb-read` | 讀取粉專貼文、主留言與回覆 |
| 5 | 用**粉專身分在 FB App** 回覆一則留言，再執行 `npm run check -- fb-native-reply` | 確認系統能認出「品牌自己回的」 |
| 6 | `npm run check -- ig-read` | 讀取 IG 貼文與 Reels 留言 |
| 7 | 把 `.env` 的 `ALLOW_WRITE` 改成 `true`，執行 `npm run check -- fb-write --comment <留言ID>` | 在測試粉專上回覆、隱藏、取消隱藏、刪除。留言 ID 可從 fb-read 的結果找 |
| 8 | `npm run check -- ig-write --comment <IG留言ID>`、`npm run check -- ig-like-block --comment <IG留言ID>` | IG 的回覆／隱藏／刪除；確認按讚是否可做 |
| 9 | 投放一則小預算廣告（FB＋IG 版位），用顧客帳號在廣告下留言，再執行 `npm run check -- fb-ads`、`npm run check -- ig-ads` | 確認能把留言歸到廣告 |
| 10 | `npm run check -- webhook-stats` | 看延遲、重送次數、有沒有收到品牌回覆與廣告留言事件 |
| 11 | 到 Facebook「設定 → 商業整合」移除這個 App，再執行 `npm run check -- token-health` | 確認系統能偵測 token 失效；做完重新 `/login` |
| 12 | 在 `.env` 填 `ANTHROPIC_API_KEY`，執行 `npm run check -- ai`（示範留言）或 `npm run check -- ai --source real`（真實留言） | 打開 `results/ai-samples.md`，逐則填「分類正確？」「建議可用？」 |
| 13 | `npm run report` | 產生 `results/REPORT.md` |

`npm run check -- all` 會一次跑完所有**唯讀**項目；`npm run check` 不加參數會列出全部項目。
`dedupe`（去重）不需要任何帳號，現在就可以執行。

### 自動測試
```bash
npm test
```
會檢查：簽章驗證、signed_request 竄改偵測、留言格式轉換（主留言／回覆／品牌回覆／IG）、token 加解密、去重（含重啟後）、AI 結果格式與成本控制規則。

---

## 檔案說明

| 路徑 | 用途 |
|---|---|
| `src/webhook/server.js` | 本機伺服器：登入、webhook、資料刪除與取消授權回呼 |
| `src/meta/graph.js` | 呼叫 Graph API；統一處理錯誤（token 失效、權限不足、限流） |
| `src/meta/normalize.js` | 轉接器：把 FB／IG 的格式轉成統一留言格式 |
| `src/meta/auth.js` | Facebook 登入授權，要求的權限清單在這裡 |
| `src/ai/analyze.js` | 所有 AI 呼叫集中在這裡，記錄模型、提示版本、用量、成本 |
| `src/checks/` | 每個驗證項目 |
| `fixtures/` | 示範品牌設定與 20 則示範留言（真實留言用 `--source real`） |
| `data/` | 執行時產生：加密 token、原始 webhook 事件、留言、AI 用量（不上傳） |
| `results/` | 執行時產生：每個項目的結果與報告（含留言內容，不上傳；要分享請只分享 REPORT.md） |
