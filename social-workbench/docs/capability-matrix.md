# Meta（Facebook 粉專 + Instagram 專業帳號）留言管理 API 研究

> 研究日期：2026-09-30
> 產品情境：品牌 FB 粉專與 IG 專業帳號的留言管理 SaaS（含廣告留言），先「影子模式」（唯讀），再開「回覆模式」。
> 方法限制：本環境**無法直接開啟** developers.facebook.com / facebook.com。以下事實來自：
> (1) WebSearch 搜尋結果摘錄（多半直接引用 Meta 官方文件文字）；
> (2) Meta 官方 SDK 原始碼 `facebook/facebook-python-business-sdk`（GitHub，2026-09-17 commit，`API_VERSION = v26.0`、SDK `v26.0.2`）；
> (3) RestFB（Java SDK，2026-08 commit）內的 webhook 型別定義與測試 payload；
> (4) 第三方整理（GitHub gist「Instagram Official APIs — Comprehensive Reference (April 2026)」、部落格等）。
> 每條事實都附**該事實所屬的官方文件 URL**（即使沒能直接開啟），並標註可信度：
> - **【多源確認】**：兩個以上獨立來源一致（含 SDK 原始碼 + 官方文件摘錄）
> - **【單一來源】**：只有一個來源
> - **【推論】**：依經驗／相關事實推導，**必須實測**

---

## 0. 版本現況

| 事實 | 可信度 | 官方文件 |
|---|---|---|
| 目前最新 Graph API / Marketing API 版本為 **v26.0**（官方 Python Business SDK 2026-09 已切到 `v26.0`；搜尋結果中官方參考頁標題為「Graph API Reference v26.0: Page Ads Posts」「v26.0: Comment」）。v25.0 為前一版（2026 年初）。 | 多源確認 | https://developers.facebook.com/docs/graph-api/changelog/versions/ |
| v25 相關變更：Webhooks 的 mTLS 憑證於 **2026-03-31** 前改由 Meta 自有 CA 簽發（若有做 mTLS 驗證需更新 trust store）；舊的 reach 類指標被 Media Views 取代。 | 單一來源（第三方摘要） | https://developers.facebook.com/docs/graph-api/changelog |
| 建議：新專案直接鎖定 `v26.0`，每個 Graph 版本約 2 年後淘汰。 | 推論 | https://developers.facebook.com/docs/graph-api/changelog/versions/ |

---

## (a) 能力矩陣：平台 × 動作

圖例：✅ 可做　❌ 不可做　⚠️ 有條件

### A-1. Facebook 粉專（Graph API，`graph.facebook.com/v26.0`）

| 動作 | 結果 | 條件 / 備註 | 官方文件 | 可信度 |
|---|---|---|---|---|
| 讀取粉專貼文列表 | ✅ | `GET /{page-id}/feed`（含訪客貼文）、`/{page-id}/posts`、`/{page-id}/published_posts`；`/feed` 支援 `include_hidden`、`show_expired`。需 Page token + `pages_read_engagement`（+`pages_show_list` 取得粉專）。 | https://developers.facebook.com/docs/graph-api/reference/page/feed/ | 多源確認（SDK＋文件摘錄） |
| 讀取貼文留言（含巢狀回覆） | ✅ | `GET /{post-id}/comments?filter=stream&order=chronological`：`filter=stream` 攤平所有層級（含回覆），`toplevel`（預設）只取頂層；`order` = `chronological` / `reverse_chronological`；另有 `live_filter`、`since`。巢狀用 `GET /{comment-id}/comments`。需 `pages_read_engagement` + `pages_read_user_content`。 | https://developers.facebook.com/docs/graph-api/reference/object/comments/ | 多源確認（SDK enum `Filter.stream/toplevel`、`Order`） |
| 留言欄位 | ✅ | `id, message, created_time, from, parent, is_hidden, can_hide, can_remove, can_reply_privately, comment_count, like_count, permalink_url, attachment, message_tags, admin_creator, object, is_private` | https://developers.facebook.com/docs/graph-api/reference/comment/ | 多源確認（SDK Field 列表） |
| 取得留言者身分（`from`） | ⚠️ | 自 2018-02 起：**粉專貼文上的留言，只有用 Page access token 查詢才會回傳使用者資訊**（否則省略 `from`）。上線後仍需 `pages_read_user_content` Advanced Access。 | https://developers.facebook.com/docs/graph-api/reference/comment/ | 多源確認（官方公告摘錄） |
| 回覆留言 | ✅ | `POST /{comment-id}/comments`，參數 `message`、`attachment_id`/`attachment_url`/`attachment_share_url`。以 Page token 發出即「以粉專身分」回覆。需 `pages_manage_engagement`。 | https://developers.facebook.com/docs/graph-api/reference/comment/comments/ | 多源確認 |
| 隱藏 / 取消隱藏 | ✅ | `POST /{comment-id}` 參數 `is_hidden=true/false`；先看 `can_hide`。需 `pages_manage_engagement`。 | https://developers.facebook.com/docs/graph-api/reference/comment/ | 多源確認（SDK `api_update` 參數含 `is_hidden`） |
| 刪除留言 | ✅ | `DELETE /{comment-id}`；先看 `can_remove`。需 `pages_manage_engagement`。 | https://developers.facebook.com/docs/graph-api/reference/comment/ | 多源確認 |
| 編輯粉專自己的留言 | ✅ | `POST /{comment-id}` 帶 `message`（僅限粉專自己發的留言）。 | https://developers.facebook.com/docs/graph-api/reference/comment/ | 單一來源（SDK 參數）＋推論 |
| 以粉專身分按讚留言 | ✅ | `POST /{comment-id}/likes`、`DELETE /{comment-id}/likes`（SDK 有 `create_like`/`delete_likes`）。需 `pages_manage_engagement`。 | https://developers.facebook.com/docs/graph-api/reference/object/likes/ | 單一來源（SDK）＋推論 |
| 封鎖使用者 | ⚠️ | Page 有 `/{page-id}/blocked` edge（GET/POST/DELETE，參數 `uid`/`user`/`psid`/`asid`）。但留言 `from.id` 是 app-scoped/page-scoped ID，能否直接拿來封鎖、所需權限（推測 `pages_manage_engagement` 或 `pages_manage_metadata`）**未確認**。 | https://developers.facebook.com/docs/graph-api/reference/page/blocked/ | 單一來源（SDK）；權限為推論 |
| 私訊回覆留言者（Private Reply） | ⚠️ | `POST /{page-id}/messages` 帶 `recipient: {comment_id}`；需 `pages_messaging`（另案審查），7 天內、每則留言 1 次。非本產品第一階段範圍。 | https://developers.facebook.com/docs/messenger-platform/discovery/private-replies/ | 推論 |
| Webhook 即時收留言（`feed` 欄位） | ⚠️ | 需 App 訂閱 Page 物件 `feed` 欄位 + 每個粉專 `POST /{page-id}/subscribed_apps?subscribed_fields=feed`。需 `pages_manage_metadata`（+`pages_show_list`、`pages_read_engagement`）。開發模式只會收到 app 角色使用者觸發的事件。 | https://developers.facebook.com/docs/pages-api/webhooks-for-pages | 多源確認 |
| 讀取廣告（暗貼文 / 未發佈貼文）留言 | ✅ | 取得廣告的 `effective_object_story_id`（= `{page_id}_{post_id}`）後 `GET /{story-id}/comments`，用 Page token 即可讀。 | https://developers.facebook.com/docs/marketing-api/reference/ad-creative/ | 多源確認（SDK 欄位＋第三方工具普遍做法） |
| 回覆 / 隱藏 / 刪除廣告留言 | ✅ | 與一般留言相同端點（廣告貼文屬於粉專）。 | https://developers.facebook.com/docs/graph-api/reference/comment/ | 推論（業界工具 Agorapulse 等皆支援） |
| 廣告留言走 `feed` webhook | ⚠️ | **官方文件未明文**。多數整合商回報暗貼文留言會以 `item=comment` 出現在 `feed` webhook，但也有社群回報漏送（特別是動態素材／Advantage+ 產生的貼文）。**必須實測**；建議 webhook + 定期輪詢雙軌。 | https://developers.facebook.com/docs/pages-api/webhooks-for-pages | 推論 |
| 把貼文對應回廣告 | ⚠️ | 兩條路：① `GET /act_{ad_account_id}/ads?fields=id,name,creative{effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,object_story_id}` 需 `ads_read`（+ 使用者要有廣告帳號權限）；② `GET /{page-id}/ads_posts`（參數 `exclude_dynamic_ads`、`include_inline_create`、`since`、`until`）用 Page token 列出曾被用於廣告的貼文。 | https://developers.facebook.com/docs/graph-api/reference/page/ads_posts/ | 多源確認（SDK 有 `get_ads_posts` 及參數；官方頁標題 v26.0） |
| `promotable_posts` edge | ❌（已不存在於 v26 SDK） | SDK v26 的 Page 物件已無 `get_promotable_posts`，改用 `ads_posts` 或貼文欄位 `promotable_id` / `is_eligible_for_promotion` / `is_published`。 | https://developers.facebook.com/docs/graph-api/reference/page/ads_posts/ | 單一來源（SDK 缺席推論為已移除） |

### A-2. Instagram（Instagram API with Facebook Login，`graph.facebook.com`）

| 動作 | 結果 | 條件 / 備註 | 官方文件 | 可信度 |
|---|---|---|---|---|
| 讀取貼文 / Reels 留言 | ✅ | `GET /{ig-media-id}/comments`（僅頂層，每頁最多 50，時間倒序）；Reels、輪播、影片皆為 IG Media，同端點。需 `instagram_basic` + `instagram_manage_comments` + `pages_read_engagement` + `pages_show_list`（IG 帳號需連結 FB 粉專）。 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/comments/ | 多源確認 |
| 讀取回覆 | ✅ | `GET /{ig-comment-id}/replies`。IG 只有一層巢狀。 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies/ | 多源確認 |
| 留言欄位 | ✅ | `id, text, timestamp, from{id,username}, username, hidden, like_count, media{id,media_product_type}, parent_id, replies, user, legacy_instagram_comment_id`。`user` 只在留言者是 app 使用者本身時回傳，其他人請用 `from`/`username`。 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/ | 多源確認（SDK Field）；`user` 行為為推論 |
| 回覆留言 | ⚠️ | `POST /{ig-comment-id}/replies?message=...`；只能回覆**頂層留言**（對回覆再回覆會失敗或被歸到同一串，需實測錯誤碼）。新增頂層留言：`POST /{ig-media-id}/comments`（可帶 `ad_id`）。 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/replies/ | 多源確認；「僅頂層」為推論 |
| 隱藏 / 取消隱藏 | ✅ | `POST /{ig-comment-id}?hide=true|false`（SDK 參數 `hide`、`ad_id`）。媒體擁有者自己的留言可能無法隱藏（需實測）。 | https://developers.facebook.com/docs/instagram-platform/comment-moderation/ | 多源確認 |
| 刪除留言 | ⚠️ | `DELETE /{ig-comment-id}`（可帶 `ad_id`）。第三方資料對「是否能刪除他人在自家貼文的留言」說法不一（gist：可刪自家貼文上的留言；另一來源：只能刪自己發的）。**需實測**。 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-comment/ | 單一來源（衝突） |
| 開關某則貼文的留言功能 | ✅ | `POST /{ig-media-id}?comment_enabled=true|false`。 | https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-media/ | 多源確認 |
| **按讚留言** | ⚠️（**2026-04 起可做**） | Meta 於 **2026-04-22** 開放以 API 對 Feed 貼文、Reels、留言、回覆按讚/取消讚；需新權限 **`instagram_manage_engagement`**（需 App Review）；僅限自家媒體上的留言，不支援限時動態與私人帳號內容。**確切端點形式未能從官方頁確認**（SDK v26 尚未收錄）。 | https://developers.facebook.com/docs/instagram-platform/changelog/ | 多源確認（replient.ai、almcorp、Social Media Today 均報導）；端點細節未確認 |
| 封鎖 / 限制（restrict）使用者 | ❌ | 查無任何官方端點；SDK 的 IGUser/IGComment 亦無 block/restrict 方法。 | https://developers.facebook.com/docs/instagram-platform/comment-moderation/ | 推論（多來源皆未提及，無反證） |
| 私訊回覆留言者 | ⚠️ | `POST /{ig-user-id}/messages` 帶 `recipient:{comment_id}`，需 `instagram_manage_messages`；限 750 次/小時。非第一階段範圍。 | https://developers.facebook.com/docs/instagram-platform/private-replies/ | 單一來源 |
| Webhook `comments` | ⚠️ | 訂閱 Instagram 物件的 `comments` 欄位 + 對粉專 `POST /{page-id}/subscribed_apps`（FB Login 路徑）。需 `instagram_manage_comments` **Advanced Access**、App 為 Live 模式、**IG 帳號必須是公開帳號**。開發模式只有 app 角色使用者的帳號會送。 | https://developers.facebook.com/docs/instagram-platform/webhooks | 多源確認 |
| Webhook `live_comments` | ⚠️ | 直播進行中的留言；直播結束後不再送。 | https://developers.facebook.com/docs/graph-api/webhooks/reference/instagram | 多源確認（官方＋RestFB 型別） |
| **廣告留言觸發 webhook** | ✅（有條件） | 官方文件：留言者在**加強推廣（boosted）貼文或 IG 廣告貼文**留言時，`comments` webhook 的 `value.media` 會帶 **`ad_id`、`ad_title`**；RestFB 型別另有 `original_media_id`（2024-06 新增，推測為廣告暗貼文對應的原始媒體 ID）。 | https://developers.facebook.com/docs/instagram-platform/webhooks | 多源確認（官方摘錄＋RestFB 2022/2024 changelog） |
| 讀取 IG 廣告留言 | ✅ | 從廣告 creative 取 `effective_instagram_media_id`（另有 `instagram_permalink_url`、`source_instagram_media_id`、`instagram_user_id`），再 `GET /{effective_instagram_media_id}/comments`。 | https://developers.facebook.com/docs/marketing-api/guides/instagramads/ ；https://developers.facebook.com/docs/marketing-api/reference/instagram-media/comments/ | 多源確認（SDK AdCreative 欄位） |
| 回覆 / 隱藏 / 刪除 IG 廣告留言 | ✅ | 同一般端點，SDK 顯示 hide/delete/create comment 可帶 `ad_id` 參數（用途推測為指明廣告脈絡，需實測是否必填）。 | https://developers.facebook.com/docs/marketing-api/reference/instagram-comment/ | 單一來源（SDK）＋推論 |

### A-3. Instagram API with Instagram Login（`graph.instagram.com`）

| 動作 | 結果 | 條件 / 備註 | 官方文件 | 可信度 |
|---|---|---|---|---|
| 登入 / 權杖 | ✅ | Business Login for Instagram；不需 FB 粉專。短效 1 小時 → 長效 60 天，需在到期前 refresh。舊 scope `business_*` 已於 2025-01-27 淘汰，改為 `instagram_business_basic`、`instagram_business_manage_comments` 等。 | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login | 多源確認 |
| 讀取/回覆/隱藏/刪除留言 | ✅ | 同樣的 `/comments`、`/replies`、`?hide=` 端點，權限 `instagram_business_basic` + `instagram_business_manage_comments`。 | https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/ | 多源確認 |
| Webhook comments | ✅ | 訂閱：`POST /me/subscribed_apps?subscribed_fields=comments`（用 IG user token）。 | https://developers.facebook.com/docs/instagram-platform/webhooks | 單一來源（gist） |
| 廣告對應（Marketing API） | ❌ | Instagram Login 無法存取 Marketing API（`ads_read`），無法從廣告帳號對應 creative；廣告/Business Discovery/Hashtag 僅 FB Login 路徑。 | https://developers.facebook.com/docs/instagram-platform/overview/ | 多源確認 |
| 建議 | — | 本產品要處理廣告留言 → **以 Facebook Login（for Business）為主路徑**；Instagram Login 可作為「沒有連結粉專的 IG 帳號」補充路徑。 | — | 推論 |

---

## (b) App Review 權限清單

> 原則：開發模式（Development）下，**所有權限都可對 app 角色使用者（管理員/開發者/測試者）本人管理的粉專/IG 帳號使用**，不用審查。要服務外部客戶的粉專，每個權限都需要 **Advanced Access = App Review + 商家驗證（Business Verification）**。服務其他企業的 SaaS 通常也會被要求「Access Verification（技術供應商驗證）」（**單一來源/推論，需在 App Dashboard 確認**）。

| 權限 | 用途（本產品） | 階段 | 備註 | 可信度 |
|---|---|---|---|---|
| `pages_show_list` | 列出使用者管理的粉專、取得 Page token | 影子 | 幾乎所有 Pages 權限的前置 | 多源確認 |
| `pages_read_engagement` | 讀貼文、留言數、粉專基本資料；IG FB-Login 路徑也要 | 影子 | | 多源確認 |
| `pages_read_user_content` | 讀取**使用者產生**的內容（訪客貼文、留言、`from`） | 影子 | 有第三方文章稱「不需 App Review」，與 Meta 規則不符（所有 Advanced Access 皆需審查）→ 以需要審查看待 | 多源確認（衝突已標註） |
| `pages_manage_metadata` | 訂閱 webhook（`/{page-id}/subscribed_apps`） | 影子 | Page webhook 必要 | 多源確認 |
| `pages_manage_engagement` | 回覆、隱藏、刪除、按讚粉專留言 | 回覆 | 影子模式**不要**申請，避免截圖影片不符被拒 | 多源確認 |
| `business_management` | 讀取商業管理平台擁有的資產（粉專/廣告帳號/IG 由 BM 持有時）、系統使用者 | 視需要 | 若僅透過個人管理員授權粉專可不申請；若使用 Facebook Login for Business 取 BM 資產通常需要 | 推論 |
| `ads_read` | 讀廣告與 creative，將貼文/媒體對應到廣告 | 影子（廣告） | 使用者需對廣告帳號有角色 | 多源確認 |
| `instagram_basic` | 讀 IG 帳號、媒體 | 影子 | | 多源確認 |
| `instagram_manage_comments` | 讀取留言、IG `comments` webhook、回覆/隱藏/刪除 | 影子（讀+webhook 就需要） | IG 讀留言與 webhook 也綁這個權限，影子模式就要申請 | 多源確認 |
| `instagram_manage_engagement` | IG 按讚留言（2026-04 新增） | 回覆（選配） | 新權限，審查標準未知 | 多源確認（存在）；審查細節未知 |
| `instagram_business_basic` / `instagram_business_manage_comments` | Instagram Login 路徑對應權限 | 選配 | | 多源確認 |
| （不需）`pages_manage_posts`、`read_insights`、`pages_messaging`、`instagram_manage_messages` | 發文、洞察、私訊 | 非範圍 | 除非要做私訊回覆 | — |

### 審查影片（screencast）與送審準備

| 項目 | 說明 | 可信度 |
|---|---|---|
| 每個權限各自示範 | 影片中必須看得到該權限的實際用途：例如 `pages_manage_engagement` 要看到在你的產品中按「回覆/隱藏/刪除」→ 到 Facebook 上顯示結果。只示範讀取卻申請寫入權限會被拒。 | 多源確認（第三方經驗） |
| 完整 OAuth 流程 | 從登出狀態開始，展示 Facebook Login（for Business）授權對話框、勾選粉專/IG 帳號、授予權限。 | 多源確認 |
| 使用真實角色帳號 | 用有粉專管理員角色的測試帳號，不要用 Business Manager 預覽。 | 單一來源 |
| 英文介面或加字幕 | 審查員看得懂的 UI 語言或英文說明字幕。 | 推論（普遍建議） |
| 提供測試帳號 | 審查員可登入你 SaaS 的帳密；若需要，提供可用的測試粉專。 | 多源確認 |
| Webhook 端點可用 | 審查期間 webhook 端點要能驗證（`hub.challenge`）且回 200；Meta 會實測訂閱型權限。 | 單一來源 |
| 必要設定 | 隱私權政策 URL、服務條款、App icon、**Deauthorize Callback URL**、**Data Deletion Request Callback URL**（或資料刪除說明頁）、App 類別、商家驗證完成。 | 多源確認 |
| 分階段送審建議 | 第一次送：`pages_show_list`、`pages_read_engagement`、`pages_read_user_content`、`pages_manage_metadata`、`instagram_basic`、`instagram_manage_comments`、`ads_read`（影子模式）；第二次再送 `pages_manage_engagement`（+`instagram_manage_engagement`）。注意 IG 回覆/隱藏也在 `instagram_manage_comments` 內，第一次送審影片就得示範 IG 的寫入動作才可能通過，或在影子模式也放「回覆」按鈕。 | 推論 |

---

## (c) 關鍵端點與 payload 範例

### C-1. 權杖流程（FB Login 路徑）

```http
# 1) 短效 user token → 長效 user token（約 60 天）
GET https://graph.facebook.com/v26.0/oauth/access_token
  ?grant_type=fb_exchange_token&client_id={app-id}&client_secret={app-secret}&fb_exchange_token={short-lived-user-token}

# 2) 用長效 user token 取得 Page token（取得的 Page token 無到期日，debug_token 顯示 expires_at: 0）
GET https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token={long-lived-user-token}

# 3) 檢查權杖
GET https://graph.facebook.com/v26.0/debug_token?input_token={token}&access_token={app-id}|{app-secret}
# 重點欄位：is_valid, expires_at, data_access_expires_at, scopes, granular_scopes（每個權限對應哪些 page/ig id）
```

| 事實 | 可信度 | 官方文件 |
|---|---|---|
| 由長效 user token 換出的 Page token **沒有到期日**，但在使用者改密碼、移除 App、失去粉專角色、或 **data access 到期（使用者約 90 天未回訪 App，`data_access_expires_at`）** 時失效。 | 多源確認 | https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived |
| 錯誤碼 `190`（OAuthException）= 權杖問題；subcode：`458` App 未授權（使用者移除 App）、`459` 帳號被檢查點鎖定、`460` 改密碼、`463` 過期、`464` 未確認使用者、`467` 權杖無效（登出等）、`492` session 無效（常見於失去粉專角色）。注意到期回 **HTTP 400** 不是 401。有第三方文章對 460/463 意義寫反，以官方表為準。 | 多源確認（官方錯誤表摘錄）；492 解讀為推論 | https://developers.facebook.com/docs/graph-api/guides/error-handling/ |
| 其他要處理的錯誤：`10`/`200` 系列（權限不足）、`4`（App 層級限流）、`17`（使用者限流）、`32`（Page 限流）、`613`、`80001`（Pages BUC 限流）、`80002`（IG BUC 限流）。 | 推論（依過往官方錯誤表） | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ |
| **Deauthorize callback**：使用者移除 App 時 Meta POST `signed_request` 到你設定的 URL，只需回 200。**Data deletion callback**：POST `signed_request`（`base64url(簽章).base64url(payload)`，以 App Secret 做 HMAC-SHA256 驗證），需回 `{"url": "<狀態查詢頁>", "confirmation_code": "<代碼>"}`。上線前必須設定（或提供資料刪除說明頁）。 | 多源確認 | https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback/ |
| **系統使用者（System User）權杖**：在 Business Manager 建立，可選不過期；適合「自家 BM」的資產。SaaS 要用客戶 BM 的系統使用者權杖，需透過 Facebook Login for Business 的「系統使用者存取權杖」設定，客戶授權後於其 BM 建立 business integration system user。 | 推論 | https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/ ；https://developers.facebook.com/docs/marketing-api/system-users/ |

### C-2. 讀取留言

```http
# 粉專貼文（含暗貼文：story id 來自 effective_object_story_id）
GET /v26.0/{page_id}_{post_id}/comments
  ?filter=stream&order=chronological&limit=100
  &fields=id,message,created_time,from{id,name},parent{id},is_hidden,can_hide,can_remove,comment_count,like_count,permalink_url,attachment
  &access_token={page-token}

# IG 媒體（Reels 同端點）
GET /v26.0/{ig-media-id}/comments?fields=id,text,timestamp,from{id,username},username,hidden,like_count,parent_id,replies{id,text,timestamp,from,hidden,parent_id}&access_token={page-token 或 user-token}
GET /v26.0/{ig-comment-id}/replies?fields=id,text,timestamp,from,hidden,parent_id
```

### C-3. 寫入動作

```http
# FB
POST /v26.0/{comment-id}/comments   message=感謝您的回饋！          # 回覆
POST /v26.0/{comment-id}            is_hidden=true                  # 隱藏
DELETE /v26.0/{comment-id}                                          # 刪除

# IG
POST /v26.0/{ig-comment-id}/replies message=感謝您的回饋！           # 回覆
POST /v26.0/{ig-comment-id}         hide=true                       # 隱藏（廣告留言可加 ad_id）
DELETE /v26.0/{ig-comment-id}                                       # 刪除
```

### C-4. Webhook 設定與驗證

```http
# 粉專安裝 App 並訂閱 feed（Page token，需 pages_manage_metadata）
POST /v26.0/{page-id}/subscribed_apps?subscribed_fields=feed
# 查詢
GET  /v26.0/{page-id}/subscribed_apps
```
- 驗證挑戰：GET `hub.mode=subscribe&hub.verify_token=...&hub.challenge=...` → 原樣回傳 `hub.challenge`。【多源確認】
- 簽章：header `X-Hub-Signature-256: sha256=<hex>`，以 **App Secret** 對**原始 request body bytes** 做 HMAC-SHA256 比對（要用常數時間比較，不能先 JSON parse 再序列化）。【多源確認】https://developers.facebook.com/docs/graph-api/webhooks/getting-started#validate-payloads
- 重送：失敗時立即重試，之後以遞減頻率重送最長約 **36 小時**；投遞為 **at-least-once**，可能重複、可能亂序；需 5 秒內（實務上愈快愈好）回 200。**以 `comment_id + verb + created_time` 做冪等去重**。【多源確認（36 小時出自 Meta webhooks 通用文件/WhatsApp 文件摘錄；Page webhook 是否相同為推論）】
- 一個 POST 可能批次包含多個 `entry`、每個 entry 多個 `changes`。【多源確認（RestFB 測試檔 `feed-two-entries`）】

### C-5. 粉專 `feed` webhook payload（留言）

```json
{
  "object": "page",
  "entry": [{
    "id": "1234567890321",
    "time": 1449135003,
    "changes": [{
      "field": "feed",
      "value": {
        "item": "comment",
        "verb": "add",
        "comment_id": "901097836652708_903438993085259",
        "post_id": "1234567890321_901097836652708",
        "parent_id": "1234567890321_901097836652708",
        "from": { "id": "1234567890321", "name": "Tester" },
        "created_time": 1449135003,
        "message": "and the next one"
      }
    }]
  }]
}
```
（來源：RestFB 測試資料 `feed-comment-add-211.json`）

| 事實 | 可信度 |
|---|---|
| `verb` 值：`add`、`edited`、`remove`、`hide`、`unhide`（貼文另有 `block`/`unblock`/`mute` 等）。 | 多源確認（RestFB 測試檔＋文件摘錄） |
| **頂層留言的 `parent_id` = `post_id`**；回覆的 `parent_id` = 上層 `comment_id`。用 `parent_id == post_id` 判斷是否頂層。 | 單一來源（RestFB 樣本）＋推論 |
| 不同 verb 欄位形狀不一致：`edited`/`hide` 樣本用 `sender_id`/`sender_name` 取代 `from`；`remove` 可能沒有 `message`、`created_time`。解析器要容錯。 | 單一來源（RestFB 樣本，年代較舊，需實測 v26 形狀） |
| **偵測品牌原生回覆**：樣本中粉專自己留言時 `from.id == entry.id`（= page id）。可用來辨識「管理員直接在 FB 上回覆」。 | 單一來源＋推論（需實測；若以個人身分而非粉專身分回覆則 `from` 是個人） |
| `from` 可能缺漏：Meta 社群有「comment webhook 缺 from.id」的討論串；開發模式/權限不足時使用者資訊可能被省略。收到後建議以 Page token 回查 `GET /{comment_id}?fields=from,...` 補齊。 | 單一來源（社群討論標題）＋推論 |
| 只訂 App 層級不夠，每個粉專都要呼叫 `/{page-id}/subscribed_apps`；粉專若在設定中關閉 App 平台則不送。 | 多源確認 |

### C-6. Instagram `comments` webhook payload

```json
{
  "object": "instagram",
  "entry": [{
    "id": "{ig-user-id}",
    "time": 1519399307,
    "changes": [{
      "field": "comments",
      "value": {
        "id": "123456789",
        "text": "This is an example.",
        "from": { "id": "1234536447", "username": "testuser" },
        "parent_id": "987654321",
        "media": {
          "id": "76543987",
          "media_product_type": "FEED",
          "ad_id": "(僅廣告/加強推廣貼文)",
          "ad_title": "(僅廣告/加強推廣貼文)",
          "original_media_id": "(推測：廣告對應的原始媒體)"
        }
      }
    }]
  }]
}
```
- 只有 `add` 事件，**沒有編輯/刪除/隱藏事件**（IG comments webhook 只通知新留言）。【推論：官方欄位表與樣本皆無 verb 欄位】
- 輪播（album）留言的 webhook 不含 album ID，需以 comment id 回查 `media`。【單一來源（官方摘錄）】
- 品牌帳號自己的回覆也會觸發 webhook（自動回覆機器人常見「自己回自己」迴圈），`from.id` 會等於 IG 帳號 ID → 可用來偵測原生回覆。【推論，需實測】

### C-7. 廣告 → 貼文/媒體對應

```http
# 需 ads_read；列出廣告與 creative 的有效貼文/媒體
GET /v26.0/act_{ad_account_id}/ads
  ?fields=id,name,effective_status,creative{id,object_story_id,effective_object_story_id,effective_instagram_media_id,instagram_permalink_url,source_instagram_media_id,instagram_user_id,asset_feed_spec}
  &limit=200

# 用 Page token 列出曾用於廣告的貼文（含暗貼文）
GET /v26.0/{page-id}/ads_posts?exclude_dynamic_ads=false&include_inline_create=true&since=...&fields=id,created_time,is_published,permalink_url,promotable_id
```
| 事實 | 可信度 |
|---|---|
| AdCreative 欄位（v26 SDK）：`effective_object_story_id`、`effective_instagram_media_id`、`instagram_permalink_url`、`source_instagram_media_id`、`instagram_user_id`（`instagram_actor_id` 已被取代）、`object_story_id`、`asset_feed_spec`。 | 多源確認（SDK） |
| 同一 `object_story_id`（使用既有貼文）被多個廣告共用時，留言集中在同一貼文 → 一篇貼文可對應多個 ad。資料模型要設計為 post ↔ ad 多對多。 | 多源確認（第三方） |
| 動態素材（`asset_feed_spec`）/ Advantage+ creative 可能為每個素材組合產生不同的暗貼文 ID，而 creative 的 `effective_object_story_id` 只回一個。`ads_posts` 的 `exclude_dynamic_ads=false` 可能可以列出這些衍生貼文。 | 推論（**需實測**） |
| IG 廣告：`effective_instagram_media_id` 可直接 `GET /{id}/comments`；IG webhook 本身已帶 `ad_id`，可免輪詢直接對應。 | 多源確認 |

### C-8. 限流（Rate limiting）

| 事實 | 可信度 | 官方文件 |
|---|---|---|
| **Pages API 使用 BUC 限流**：每 24 小時呼叫數 = `4800 × 粉專的 engaged users`（以 Page token 呼叫）。回應 header `X-Business-Use-Case-Usage`：JSON，key 為 business object id（page id），值為陣列，每筆含 `type`、`call_count`、`total_cputime`、`total_time`（皆為百分比）、`estimated_time_to_regain_access`（分鐘）。 | 多源確認 | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ |
| **IG Platform BUC**：每 24 小時 = `4800 × 帳號 impressions`（24 小時內內容曝光次數），實際下限約數百次/小時；同樣用 `X-Business-Use-Case-Usage`。 | 多源確認 | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/#instagram-graph-api |
| **App 層級（Platform rate limit）**：用 user/app token 時，每小時 `200 × 每日活躍使用者`；header `X-App-Usage: {"call_count":%,"total_cputime":%,"total_time":%}`。 | 多源確認 | https://developers.facebook.com/docs/graph-api/overview/rate-limiting/ |
| Marketing API（`/act_/ads`）有獨立的 ads_management BUC（header `X-Business-Use-Case-Usage` type=`ads_management`，並有 `X-Ad-Account-Usage`）。 | 推論 | https://developers.facebook.com/docs/marketing-api/overview/rate-limiting/ |
| 建議：webhook 為主、輪詢為輔；讀留言用 `since` 增量、批次請求（`/?ids=` 或 batch API）；監看 header 超過 75% 即降速。 | 推論 | — |

---

## 開發模式 vs 上線（Live）/ Advanced Access

| 事實 | 可信度 | 官方文件 |
|---|---|---|
| 開發模式：只有 App 角色（管理員/開發者/測試者）可登入授權；權限為 Standard Access，只能存取這些人**自己管理**的粉專/IG。 | 多源確認 | https://developers.facebook.com/docs/development/build-and-test/app-modes |
| 開發模式下的 webhook：只有 App 角色使用者造成的事件會送。**意思是：影子模式用真實客戶粉專時，一般網友的留言在開發模式可能收不到**（即使粉專管理員是 App 角色）。這點對「影子模式先上」影響極大，需第一時間實測。 | 多源確認（第三方）；對「粉專管理員是 App 角色時，一般網友留言是否送」為**不確定** | https://developers.facebook.com/docs/graph-api/webhooks/getting-started |
| IG `comments` webhook：需 App 為 Live + `instagram_manage_comments` Advanced Access；IG 帳號需為公開帳號。 | 多源確認 | https://developers.facebook.com/docs/instagram-platform/webhooks |
| Advanced Access 需 App Review + 商家驗證（Business Verification）。 | 多源確認 | https://developers.facebook.com/docs/graph-api/overview/access-levels/ |
| 用 Graph API 輪詢（非 webhook）在開發模式對 App 角色管理的粉專可讀所有留言（含一般網友）。所以**影子模式初期可用輪詢**頂住，等 Advanced Access 下來再開 webhook。 | 推論（需實測 `from` 是否被省略） | https://developers.facebook.com/docs/graph-api/reference/object/comments/ |

---

## (d) 只能靠實測回答的開放問題

1. **開發模式 + 客戶粉專管理員被加為 Tester**：一般網友在該粉專留言，`feed` webhook 會不會送？輪詢 `/comments` 時 `from` 會不會回？（決定影子模式能否在送審前就跑真實客戶）
2. **FB 暗貼文 / 廣告留言**是否穩定出現在 `feed` webhook？動態素材、Advantage+ creative、Advantage+ 購物活動（ASC 已於 2026-09 逐步淘汰）產生的衍生貼文是否也送？
3. 動態素材廣告每個素材組合是否各自有暗貼文 ID？`/{page-id}/ads_posts?exclude_dynamic_ads=false` 能否完整列出？creative `effective_object_story_id` 是否只回其中一個？
4. v26 的 `feed` webhook 各 verb（add/edited/remove/hide/unhide）實際欄位形狀（`from` vs `sender_id`/`sender_name`、`remove` 是否帶 `created_time`）。
5. 品牌管理員以**個人身分**（非切換為粉專）回覆時，`from` 是誰？能否用 `admin_creator` 欄位辨識是哪個管理員以粉專身分回覆？
6. IG：品牌帳號自己的回覆是否觸發 `comments` webhook（推測會）；IG 留言被隱藏、刪除、編輯時是否有任何 webhook（推測無，需輪詢 `hidden` 對帳）。
7. IG `DELETE /{ig-comment-id}` 能否刪除**他人**在自家貼文（含廣告）的留言？IG 廣告留言的 hide/delete/reply 是否必須帶 `ad_id`？
8. IG 回覆「回覆」（二層）時的實際行為/錯誤碼。
9. IG webhook 中 `original_media_id` 的確切語意（廣告暗媒體 → 原始自然貼文？）。
10. `instagram_manage_engagement`（按讚）確切端點、是否 FB Login 與 Instagram Login 皆可用、審查要求。
11. `/{page-id}/blocked` 能否用留言 `from.id`（page-scoped id）封鎖，需要哪個權限。
12. Pages BUC 實際額度（小粉專 engaged users 少 → 額度小）在高流量廣告期間是否夠用；`estimated_time_to_regain_access` 的實際值。
13. Page token 失效時（使用者失去粉專角色）實際回的 subcode（推測 492 或 190 無 subcode），以及是否會同時觸發 deauthorize callback（推測不會，只有移除 App 才會）。
14. Webhook 重送最長時間與重複頻率（Page webhook 是否同 36 小時）；長時間失敗後 App 訂閱是否被自動停用。
15. 是否被要求「Access Verification / 技術供應商驗證」，以及 `business_management` 是否為取得 BM 持有粉專/廣告帳號的必要條件。

---

## 參考來源（可存取的非 Meta 來源）

- Meta 官方 Python Business SDK（v26.0.2）：https://github.com/facebook/facebook-python-business-sdk （`facebook_business/adobjects/{comment,igcomment,igmedia,page,pagepost,adcreative}.py`、`apiconfig.py`）
- RestFB webhook 型別與測試 payload：https://github.com/restfb/restfb （`src/main/lombok/com/restfb/types/webhook/instagram/InstagramCommentsValue.java`、`src/test/resources/json/webhooks/feed-comment-*.json`、CHANGELOG：#1202 IG comments 新欄位 2022-04、#1438 `original_media_id` 2024-06）
- Instagram Official APIs — Comprehensive Reference（2026-04）：https://gist.github.com/jameschapman2c/65eff9f54a2d350b17a6ce5127b9fe42
- IG 按讚 API（2026-04-22）：https://replient.ai/en/blog/instagram-api-for-liking-comments 、https://almcorp.com/blog/meta-expands-instagram-management-apis/ 、https://www.socialmediatoday.com/news/meta-expands-instagram-management-apis/818385/
- Graph API v25/v24 變更摘要：https://web.swipeinsight.app/posts/facebook-launches-graph-api-v25-and-marketing-api-v25-updates-22544
- 權杖與錯誤碼：https://www.outstand.so/blog/facebook-instagram-long-lived-page-access-token 、https://bundle.social/blog/facebook-page-access-token
- 資料刪除 / 取消授權 callback 實作範例：https://github.com/postmill-ai/postmill-app/pull/82
- App Review 經驗：https://singhamandeep.com/facebook-page-api-permissions-app-review/ 、https://singhamandeep.com/facebook-webhooks-app-review/
- Meta 社群討論串（標題層級證據）：「Why is there missing from.id in the comment webhook?」https://developers.facebook.com/community/threads/268619059053703/ ；「Are comments on instagram ads received via the comments webhook?」https://developers.facebook.com/community/threads/613488722397051/
