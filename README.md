# LINE 餐廳訂位系統

顧客透過 LINE 提供日期、時間、人數與電話。系統採用 **Gemini 多模型備援（`gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite`）＋規則式引擎兜底** 的混合架構：自然語言交由 Gemini 理解，營業時間、桌位庫存與寫入 SQLite 則由本機程式嚴格驗證；若遇 API 過載或逾時，會自動降級至備援模型或內建規則問答，確保訂位不中斷。

## 店家規則

- 全年無休；營業時間分為 **中午時段 11:30–14:30** 與 **晚上時段 17:00–20:00**。
- 每筆訂位保留桌位 2 小時，因此最晚入座時間為中午 **12:30** 與晚上 **18:00**。
- 店內有 6 張 4 人桌及 6 張 2 人桌，最多可安排 36 位。
- 5 位以上會先列出當下可用的拆桌方案；顧客選擇方案後才建立訂位。
- 顧客回覆「確認」或選擇拆桌方案後，系統才寫入訂位資料。

## 設定與啟動

需求：Node.js 22.13 以上版本。此專案使用 Node.js 內建 SQLite 與 `fetch`，無需安裝 npm 套件。

1. 在 [LINE 官方帳號管理頁](https://tw.linebiz.com/login/) 建立官方帳號，並在「設定」→「Messaging API」啟用 Messaging API。
2. 到 [LINE Developers Console](https://developers.line.biz/console/) 打開該 Messaging API channel：從 **Basic settings** 複製 Channel secret；從 **Messaging API** 簽發並複製 Channel access token。
3. 若還沒有 `.env`，才將 `.env.example` 複製成 `.env`；接著填入 LINE 設定與 `GEMINI_API_KEY`。`GEMINI_MODEL` 預設為 `gemini-3.8-flash`，`GEMINI_FALLBACK_MODELS` 預設為 `gemini-3.6-flash,gemini-3.5-flash-lite`（若留空 `GEMINI_API_KEY` 仍會以規則式問答運作）。`ADMIN_PASSWORD` 請使用至少 20 個字元的隨機密碼。

   ```powershell
   Copy-Item .\line-meeting-assistant\.env.example .\line-meeting-assistant\.env
   ```

4. 從工作區根目錄啟動服務：

   ```powershell
   node .\line-meeting-assistant\src\server.mjs
   ```

   若 PowerShell 已位於本專案資料夾，可執行 `node .\src\server.mjs` 或 `npm.cmd start`。服務啟動後可在 `http://localhost:3000/health` 確認狀態與目前啟用的 Gemini 模型鏈。

5. 另開 PowerShell 啟動 Cloudflare Quick Tunnel：

   ```powershell
   & "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel --url http://localhost:3000
   ```

   複製輸出的 `https://....trycloudflare.com` 網址。

6. 回到 LINE Developers Console 的 channel → **Messaging API** 分頁，在 **Webhook URL** 填入 `https://....trycloudflare.com/webhook`，按 **Verify**，再啟用 **Use webhook**。

保持 Node 服務和 cloudflared 兩個 PowerShell 視窗開啟。Quick Tunnel 停止或重開後，網址可能改變；網址改變時要更新 LINE Webhook URL。

## 顧客訂位對話

可使用自然口語一次或分次提供資料，例如：

> 下週五晚餐 6 點，四大一小，電話 0912345678。

- 系統支援相對日期（明天、後天、這週六、下週五）、口語人數（四大一小、一家三口）與營業資訊詢問。
- 若時間不在可訂位時段，助理會說明中午與晚上營業時間及店內桌位資訊，並請顧客重新選擇。
- 5 位以上會依當下空桌列出最多兩種拆桌方案，例如「4 人桌 × 1 + 2 人桌 × 1」或「4 人桌 × 2」。顧客回覆方案代號或自然語氣選擇後才完成訂位。輸入「取消」可放棄目前流程；輸入 `/help` 可查看說明。

## 業主後台與本機對話測試

在瀏覽器開啟 `http://localhost:3000/admin`；若從其他裝置查看，使用目前的 Quick Tunnel 網址加上 `/admin`。登入帳號為 `owner`，密碼使用 `.env` 的 `ADMIN_PASSWORD`。

- **即時訂位狀況總覽**：頂部卡片即時顯示本時段與全日訂位組數／人數、現場入座進度（用餐中／待入座／已離席／已取消）、剩餘空桌與可容納人數，以及下一組待入座資訊與一鍵報到按鈕。
- **桌位平面圖**：可切換 **中午時段（11:30–14:30）** 與 **晚上時段（17:00–20:00）**，並選擇整個時段或單一時間點查看 12 張桌位狀態（藍色可訂、橘色待入座、紅色用餐中）；桌卡上可直接點選「報到入座」或「結帳離席」。
- **當日訂位與入座管理**：依中午時段與晚上時段分開列出所選日期的訂位狀態、預計離席時間與現場操作（報到入座／已離席／取消／恢復待入座）；離席或取消的訂位會立即釋出桌位。
- **本機對話測試模擬器**：開啟 `http://localhost:3000/test`（與後台同組帳密），可免開 Cloudflare Tunnel 直接測試 Gemini 多模型對話與即時寫入後台。
- **GitHub Pages（`github.io`）運行模式**：
  - 專案根目錄提供 `index.html`、`admin.html`、`test-chat.html` 與 `browser-store.js`。
  - 在 GitHub Pages 開啟後台時，預設會以 **瀏覽器獨立模式** 立即運作（完整支援午／晚時段、方案二即時概況、一鍵報到／離席／取消，且與 `test-chat.html` 跨分頁即時同步）。
  - 若要連接本機或雲端執行中的 Node.js + SQLite + Gemini 真實後端，點選後台右上角「連線設定」，填入 Cloudflare Tunnel 網址（如 `https://xxxx.trycloudflare.com`）或 `http://localhost:3000` 及 `.env` 中的 `ADMIN_PASSWORD` 即可即時同步（後端已內建 `github.io` 與 `localhost` CORS 支援）。
- 新訂位完成或狀態變更時，所有開啟中的後台頁面會即時同步更新；按「啟用桌面提醒」可額外開啟瀏覽器通知。
- 後台與測試模擬器皆透過密碼保護，因為 Cloudflare Tunnel 也會讓外部網路連到本機服務。

訂位資料存於 `data/reservations.sqlite`；舊版會議資料庫 `data/meetings.sqlite` 不會被刪除。請勿分享 `.env`、後台密碼或訂位資料庫。
