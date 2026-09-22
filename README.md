# Auto-Reply：全自動 AI 遊戲直播主

一個在 Kick 上直播的 AI 主持角色。播放預先錄好的遊戲影片，用固定角色的聲音講得像正在玩，同時即時讀觀眾留言並適時回覆。直播期間沒有真人在場。

## 文件入口

1. [專案規劃 v0.2](docs/PROJECT_PLAN.md)：目標、規則、架構、階段、風險、需要使用者準備的事。
2. [與上游文件的差異](docs/UPSTREAM_DIFF.md)：本專案沿用與改動 firekou/Auto_Reply_Bot 規劃的地方。
3. [工作狀態](project/WORK_LEDGER.json)：目前進度與下一步。

## 目前狀態

2026-09-22：第一步「離線 mock 管線」完成（見 [reports/STEP1_MOCK_REPORT.md](reports/STEP1_MOCK_REPORT.md)）。38 個測試通過，30 分鐘場景可用一個命令重播。尚未接任何真實服務，尚未直播；真實項目全部 NOT_TESTED。

## 快速開始

```
npm ci
npm test                 # 建置 + 38 個測試
npm run fixtures         # 產生 30 分鐘合成場景（可重生，同 seed 同結果）
npm run replay           # 虛擬時鐘回播並印出報告
node dist/src/cli.js replay --scenario fixtures/scenario-a --config config/runtime.example.json --out runtime/logs/r.jsonl --inject-estop 10
node dist/src/cli.js replay --scenario fixtures/scenario-a --config config/runtime.example.json --realtime --limit-minutes 2   # 實時模式，stdin 可輸入 pause/resume/estop/stop/status
node dist/src/cli.js doctor
```

## 程式結構

```
src/types.ts            五個介面：FrameSource、ChatSource、ModelProvider、TtsProvider、AudioPlayer
src/director/           Director（候選槽、狀態機、取消防護）、驗證器、本機分類、預算
src/context/            去重、短期記憶、角色與參考資料
src/sources/mock.ts     依 fixture 時間軸回放的畫面與留言來源
src/providers/          mock 模型（可腳本化故障）、mock TTS
src/audio/              離線播放器
src/fixtures/           合成 fixture 產生器與假畫面繪製
src/replay.ts           回播 harness（VirtualClock）
src/report.ts           指標與報告
src/cli.ts              arb CLI
tests/                  38 個測試
```

## 四個階段

| 階段 | 內容 | 需要使用者做的事 |
| --- | --- | --- |
| 1 離線 mock | 用假影片、假留言、假 AI、假聲音把整條流程跑通，附測試與報告 | 無 |
| 2 真實內容 | 接真影片、真 AI、真聲音，輸出一支測試影片供檢視 | 提供影片檔、Claude 與語音服務金鑰、角色設定 |
| 3 接 Kick | 接 Kick 留言 API，雲端主機短時間試播 | 註冊 Kick 開發者應用程式並授權、提供串流金鑰 |
| 4 全自動 | 確認穩定後無人值守 | 決定費用上限與 AI 標示方式 |

## 兩條不會跨的線

1. 角色不主動宣稱自己是真人。觀眾問「是不是 AI」時略過不回，也不說謊。
2. 不使用任何真人的複製聲音，只用合成聲音。

## 證據規則

mock 通過不代表真實通過。沒有在真實環境跑過的項目一律標 NOT_TESTED。報告裡的命令與退出碼必須是實際執行的結果，沒跑的標「預定」。
