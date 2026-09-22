# 與上游文件的差異

上游：https://github.com/firekou/Auto_Reply_Bot ，2026-09-22 讀取 main 的 README、AGENTS.md、docs/PROJECT_PLAN.md、prompts/*、config/runtime.example.json、project/WORK_LEDGER.json，以及 PR #1 分支（reviewed_head 7a791e28）的 docs/IMPLEMENTATION_DESIGN.md、IMPLEMENTATION_BACKLOG.md、POC_RUNBOOK.md，和 reviewer commit 6079e14b 的 reviews/ARB-001_GPT_REVIEW_R1.md、prompts/CLAUDE_ARB002_IMPLEMENTATION_PROMPT.md。

## 沿用

- 五個可替換的介面：畫面來源、留言來源、模型、語音合成、播放器，全部有 mock 版本，才能在沒有設備的環境測試。
- 狀態機、sessionGeneration 取消、contextVersion 換局失效、候選槽最多一筆、串行生成與播放。
- 本機驗證器：模型輸出只是資料，句數、長度、格式、ID 對應、重複、時效都由程式檢查後才能播。
- 留言與畫面文字是不可信資料，不能改寫系統指令。推論層沒有 shell、檔案、瀏覽器與金鑰。
- 預算先預留後結算，費率未知不啟動付費，逾時不假定零費用。
- GPT 覆核 R1 的 F1 至 F5 修正條件全部納入第一步的實作與測試。
- 證據分級與 mock/real 分開報告的規則。

## 改動

| 項目 | 上游 | 本專案 | 影響 |
| --- | --- | --- | --- |
| 遊戲畫面 | 現場瀏覽器頁面截圖 | 預錄影片檔 | 不需要 Playwright 截圖與黑畫面偵測；可事前整支預看並規劃講評 |
| 留言來源 | 未定，優先官方介面、其次 DOM、最後 OCR | Kick 官方 API 的 chat.message.sent webhook | 不需要 DOM 與 OCR 路徑；需要一個公開可達的接收網址 |
| 執行位置 | 使用者的直播電腦加 OBS | 建議雲端主機，程式直接把聲音混入影片推流；本機方案保留為替代 | 使用者本機可以不架東西；驗收改為輸出測試影片檔 |
| 人工在場 | 有操作者與急停 | 無人值守 | 新增守門機制：服務斷線自動安靜、費用上限自動停、影片結束自動收播、錯誤自動復位 |
| 身分問題 | 如實回答 | 略過不回，且禁止宣稱真人 | 本機分類器把身分提問標為不回覆；驗證器擋下「我是真人」類句子 |
| AI 標示 | 操作者試播前確認 | Kick 守則要求 AI 擬真內容須在標題或畫面標示；由使用者決定，程式提供字幕或角落標示選項 | 見 PROJECT_PLAN 第 6 節 |

## 不沿用

- 上游的工作編號（ARB-001、ARB-002）、GPT 覆核流程與 draft PR 交接格式。本專案用 project/WORK_LEDGER.json 記錄進度即可。
- OBS Application Audio Capture、TikTok Live Studio、視窗擷取後備、OCR 後備。
