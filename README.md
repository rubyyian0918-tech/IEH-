# Game Box

Game Box 是一個跨平台小遊戲平台 App，要上架 Google Play（`.aab`）和 Apple App Store（`.ipa`），也要支援電腦與平板。使用者年齡為 6 歲以上。

主平台由專案負責人開發，團隊成員各自開發獨立的小遊戲，最後嵌入主平台的 Library。

## 介面雛形

`prototype/index.html` 是可以點的介面雛形，用瀏覽器直接打開就能看，不需要安裝任何東西。

- 配色：黑底、橘色品牌色，版面參考串流影音平台（主打大圖、橫向滑動列、Top 10 排行）
- 右上角可以切換「手機」和「電腦 / 平板」兩種版面
- 左側可以直接跳到任一畫面，右側會顯示這個畫面對應到心智圖的哪個節點
- 「點點橘子」是可以實際玩的示範遊戲，用來測試遊戲容器（GameHost）
- 家長控制的示範 PIN 是 `0000`

### 畫面與心智圖對照

| App 位置 | 畫面 | 對應心智圖 |
| --- | --- | --- |
| 進入 | 登入 / 訪客模式 | 使用者帳戶 › 帳號安全與登入 |
| Home | 首頁、熱門遊戲排行、搜尋 | Games、熱門遊戲排行、搜尋 |
| Home › 商城 | 商品展示區、商品詳情區、購物車與結帳、個人商城資產 | 商城（全部分支） |
| Library | Game List → Game Detail → Game Play → Game Result | Games |
| Profile | 個人頁、資產與錢包、加好友、帳號安全與登入 | 使用者帳戶、加好友 |
| Settings | 五個設定群組、家長控制 | 使用設定（紅框的「分支主題 6」定為家長控制） |

心智圖裡「搜尋 › 分支主題 1」原本是空的，雛形先補上最近搜尋、熱門搜尋和依類型瀏覽。

## 建議技術架構（React Native）

```
gamebox/
├─ apps/
│  └─ platform/                 # 主平台 App（React Native + Expo）
│     └─ src/
│        ├─ navigation/         # 4 個主 Tab + 各自的 Stack
│        ├─ screens/            # home / library / profile / settings / store / auth
│        ├─ components/         # GameRow、GameCard、Top10Row、Sheet…
│        ├─ game-host/          # GameHost 容器：HUD、暫停、時間限制、分數回傳
│        └─ parental/           # 家長控制：PIN、遊玩時間、分級、購買核准
├─ packages/
│  ├─ game-sdk/                 # 給成員用的遊戲介面與型別（見下方）
│  └─ ui/                       # 共用設計元件與色彩、字體 tokens
└─ games/
   ├─ star-hopper/              # 每位成員一個資料夾，各自開發
   ├─ number-bubbles/
   └─ …
```

導覽結構：

```
RootStack
├─ AuthStack        Welcome（登入 / 訪客）
└─ MainTabs
   ├─ Home          Home › Ranking / Search / Store › Product / Cart / Inventory
   ├─ Library       GameList › GameDetail › GamePlay › GameResult
   ├─ Profile       Profile › Wallet / Friends / Security
   └─ Settings      Settings › SettingsGroup / Parental
```

## 遊戲整合介面（給團隊成員）

每款遊戲是一個獨立的 package，對外只輸出一份 manifest 和一個 React 元件。主平台的 GameHost 負責載入、暫停和時間限制，遊戲本身不需要處理這些事情。

```ts
// packages/game-sdk/src/index.ts
export interface GameManifest {
  id: string;              // 'star-hopper'
  title: string;           // '星際跳跳'
  category: '動作' | '益智' | '學習' | '節奏' | '休閒';
  ageRating: '6+' | '8+' | '12+';
  estMinutes: number;
  description: string;     // Game Detail 的簡介
  howToPlay: string[];     // Game Detail 的玩法說明
  tags: string[];          // 用來計算「類似遊戲推薦」
  author: string;
  version: string;
}

export interface GameContext {
  paused: boolean;                          // GameHost 暫停時為 true
  locale: string;
  volume: { music: number; sfx: number };   // 來自 Settings › 聲音與音效
  onScore(score: number): void;             // 更新 HUD 分數
  onFinish(result: { score: number; stars?: 0 | 1 | 2 | 3 }): void; // 進入 Game Result
  onExit(): void;
}

export interface GameModule {
  manifest: GameManifest;
  Component: React.ComponentType<{ ctx: GameContext }>;
}
```

成員的遊戲只要輸出 `GameModule`，主平台在 `games/registry.ts` 登記後就會出現在 Library：

```ts
import starHopper from '@gamebox/star-hopper';
import numberBubbles from '@gamebox/number-bubbles';
export const GAMES: GameModule[] = [starHopper, numberBubbles];
```

如果成員用 HTML5 / Unity WebGL 開發，可以在 GameHost 裡用 WebView 載入，透過 `postMessage` 傳同樣的 `score` / `finish` / `exit` 事件。

## 上架注意事項

- Android：`eas build -p android` 產生 `.aab`，上傳 Google Play Console。因為目標年齡含 13 歲以下，需要參加「家庭政策」並填寫目標年齡層。
- iOS：`eas build -p ios` 產生 `.ipa`，用 Transporter 或 EAS Submit 上傳。建議放在「兒童」類別（年齡層 6–8 / 9–11），這個類別不能放第三方廣告和追蹤。
- 購買：G 幣與道具必須使用 Google Play Billing 和 Apple In-App Purchase，不能串接其他金流。
- 隱私：13 歲以下帳號需要家長同意（COPPA、GDPR-K），頭像不開放上傳照片，聊天預設只有預設片語。
