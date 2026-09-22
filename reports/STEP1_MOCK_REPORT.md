# 第一步報告：離線 mock 管線

日期：2026-09-22
執行環境：Claude Code 雲端容器（Linux，Node v22.22.2，npm 10.9.7），沒有音效裝置、沒有金鑰、沒有 Kick 連線。
文件基準 commit：39168fa6c19ad619ab60605f020c97e5c0d0ede5（程式 commit 在本報告之後，見 project/WORK_LEDGER.json 的 content_head）。

## 1. 這一步證明了什麼、沒證明什麼

**已證明（TESTED，mock）**
- 「合成畫面 + 合成留言 → 角色回覆 → mock 語音 → 模擬播放」整條流程能用一個命令重播 30 分鐘場景時間，並輸出可讀 transcript 與指標。
- 排程、去重、時效、換局失效、暫停/急停/恢復的取消防護、預算預留與結算、故障處理，共 38 個自動化測試通過。
- 同一留言重播 0 次、播放重疊 0 次、急停後晚到播放 0 次、預算超限 0 筆、覆蓋率不超過 100%。

**沒證明（NOT_TESTED）**
- 真實 AI 是否看得懂遊戲畫面、回覆是否自然。mock 模型是固定模板，它「答對」留言只是因為模板把留言原文塞進句子。
- 真實語音、真實播放、真實推流、Kick 留言接收、實際延遲秒數、急停在真機上的靜音時間。
- 抗注入能力。本機擋下的是明顯樣式（「忽略規則」「讀出提示詞」等），語意層的抗注入要等真模型才能測。

## 2. 實際執行的命令與退出碼

| 命令 | 退出碼 |
| --- | --- |
| `npm ci` | 0 |
| `npm run build` | 0 |
| `npm test`（38 tests, 38 pass, 0 fail） | 0 |
| `node dist/src/cli.js fixtures --scenario fixtures/scenario-a --minutes 30 --seed 42` | 0 |
| `node dist/src/cli.js replay --scenario fixtures/scenario-a --config config/runtime.example.json --out runtime/logs/replay-a.jsonl --inject-estop 10 --report-json runtime/report-a.json` | 0 |
| `node dist/src/cli.js report runtime/logs/replay-a.jsonl` | 0 |
| `node dist/src/cli.js doctor` | 0（設備類檢查全部 SKIPPED，不等於通過） |

重跑方式：`npm ci && npm test && npm run fixtures && npm run replay`。fixture digest：`2bed4bf2c989fe1248bf917aeabf4c3ed971f3e7778b9661c5ab86be1666dd1c`（同 seed 重生必須相同）。

## 3. 回播輸出（原文）

以下是 replay 命令的實際輸出，未修改。

```
# 回播報告（mock）
場景時間 1860.25s，實際 wall time 5.52s。mock 的延遲是設定值，不代表真實模型或 TTS。

## 留言
- 收到 106 則；唯一合格（可回答）85 則；被已播回覆涵蓋 66 則；覆蓋率 77.6%
- 身分提問略過 6；注入樣式本機擋下 10；空白/超長 5；同來源重送丟棄 11；跨來源同 ID 2 組（各自獨立，未互相吃掉）

## 發言
- 模型呼叫 197 次；播出 153 句（留言回覆 52、遊戲評論 101）；短句 13；合法安靜 15 次
- reason_code：game_event=101，chat_reply=52

## 丟棄分類
- resend_duplicate: 11
- unsafe_input_local: 10
- paid_disabled: 10
- decision_rejected:duplicate: 9
- context_changed: 7
- skipped_identity: 6
- model_timeout: 6
- invalid_input: 5
- slot_expired: 5
- decision_rejected:length: 2
- late_result_discarded: 2
- decision_rejected:human_claim: 2
- chat_expired: 2
- expired: 1
- rate_limited: 1
- decision_rejected:schema: 1
- tts_failed: 1
- resume_backlog: 1
- device_error: 1
- game_event_expired: 1
- spend_limit_reached: 1

## 延遲（場景時間）
- t1 事件→送模型：n=153 中位數 1.75s p95 7.50s 最大 11.00s
- t2 模型往返：n=153 中位數 2.02s p95 2.63s 最大 2.68s
- t3 驗證+TTS：n=153 中位數 0.40s p95 0.40s 最大 0.40s
- t4 播放啟動：n=153 中位數 0.00s p95 0.00s 最大 0.00s
- 合計 事件→開始播放：n=153 中位數 4.19s p95 10.30s 最大 13.67s

## 安全性檢查
- 同一留言重播次數：0（必須 0）
- 播放重疊：0（必須 0）
- 非法狀態轉換：0（必須 0）
- 換局次數：9
- 急停 10 次，最長靜音 0.00s，急停後晚到播放 0（必須 0）
- 付費停用事件：1；ERROR 次數：1
- 預算（假費率）：本小時 $0.4284 / 上限 5；整場 $0.4284 / 上限 10；結算 197 筆，超限 0 筆（必須 0）

## 文字 transcript（前 12 句）
- [16.07s] (game_event) 第1局5比1，這波在推進。對面壓得有點兇。
- [23.21s] (chat) 有人問樓上說得對，看這節奏應該還有機會。現在第1局，6比2。  ← fixture:m000090
- [32.21s] (game_event) 第1局6比2，節奏還算平穩。這局節奏我喜歡。
- [39.49s] (game_event) 漂亮！
- [45.25s] (game_event) 第1局12比2，這波在推進。先穩住，別急。
- [52.40s] (game_event) 第1局15比2，這波在推進。對面壓得有點兇。
- [59.54s] (game_event) 第1局15比2，關鍵時刻了。先穩住，別急。
- [67.42s] (chat) 有人問這波先守還是先攻，先穩住，別急。現在第1局，15比2。  ← fixture:m000016, fixture:m000007
- [94.04s] (game_event) 第1局20比5，這波在推進。這局節奏我喜歡。
- [100.96s] (game_event) 第1局20比5，節奏還算平穩。對面壓得有點兇。
- [109.03s] (game_event) 第1局20比6，節奏還算平穩。先看下一步再說。
- [117.04s] (chat) 有人問想睡了，先看下一步再說。現在第1局，20比6。  ← fixture:m000093

日誌：/home/user/Auto-Reply/runtime/logs/replay-a.jsonl；事件 2137 筆；場景 31.0 分鐘，wall 5.5 秒
```

### 3.1 怎麼讀這些數字

- **場景時間 31 分鐘、wall time 5.5 秒**：用虛擬時鐘加速。這不是 30 分鐘實時穩定度測試。
- **覆蓋率 77.6%**：85 則可回答留言中 66 則被已播回覆涵蓋。沒被涵蓋的 19 則去哪了，看「丟棄分類」：付費停用 10（場景最後 1 分鐘故意注入額度用盡）、換局失效 7、模型逾時 6、模型回覆重複被擋 9、槽過期 5 等。這些都是故意注入的故障，不是漏接。
- **遊戲評論 101 句 vs 留言回覆 52 句**：mock 模型看到分數變化就講，所以很多話。真實版會由事前預看的講評計畫控制節奏，不會每 7 秒講一次。
- **延遲中位數 4.2 秒、p95 10.3 秒**：t2 模型往返是 mock 設定的 1.2 到 2.7 秒，不是真實模型。t1（事件到送模型）的 p95 7.5 秒來自串行設計：前一句還在播就得等。這是設計取捨，真實版可以再調。
- **急停最長靜音 0.00 秒**：虛擬時鐘下 stopNow 立即完成。真機的 1 秒目標要另外量。
- **身分提問略過 6 / 6**：fixture 裡 6 種問法全部被略過，沒送模型。宣稱真人的句子（故障注入 2 次）全部被驗證器擋下。

## 4. 覆核 R1 的 F1 至 F5 對應

| 條件 | 做法 | 測試 |
| --- | --- | --- |
| F1 安靜與短句 | 先驗 schema/ID 再分支；speak=false 直接 IDLE 不計失敗；長度以 code point 計、不含空白、20 字只是目標 | validator 測試、「合法安靜」「短句可播」 |
| F2 換局與晚到 callback | contextVersion 隨影片段落遞增；三道關卡加所有 async 完成都比對 jobId + generation；pause/stop 後晚到結果丟棄不改狀態 | 「TTL 內換局」「pause 中晚到」「stop 後 finally」「10 次急停」 |
| F3 串行與覆蓋率 | 候選槽最多一筆、播完才生成、採集持續；去重鍵 source:messageId，seen/selected/spoken 分開，spoken 在真的開始播才記；覆蓋率 = 被涵蓋的唯一合格留言 / 唯一合格留言，遊戲評論另計 | 「同時最多一個」「串行」、replay 測試 |
| F4 預算 | 假費率；先預留（含圖片 token、最大 output、TTS 上限字數）後結算；逾時以預留額計；null 上限拒絕 | budget 測試、「預算不超上限」 |
| F5 範圍 | 只做 mock 循環與必測項目，沒做控制台、OCR、第二供應商 | 本報告 |
| F6 控制通道 | 同程序 stdin：pause / resume / estop / stop / status（`replay --realtime` 可用）；真機播放器留第二步 | 未自動化測試，只有程式 |

## 5. 已知限制

1. mock 模型的回覆是模板，會出現「有人問想睡了，先看下一步再說」這種答非所問的句子。這是 mock 的本質，不是 bug；真模型接上後才有意義。
2. 身分提問與注入的本機判斷是正規表達式，只擋明顯句型。「這遊戲有 AI 嗎」不會被誤擋，但更隱晦的問法會漏到模型那層。
3. 畫面事件在 mock 裡以分數變化為觸發；真實影片沒有這個訊號，第二步改由講評計畫與畫面差異判定。
4. 留言中斷期間的留言被來源直接略過，沒有記入日誌，所以「收到 106 則」少於 fixture 的 118 行（11 則重送 + 1 段中斷）。
5. `replay --realtime` 的 stdin 控制沒有自動化測試。

## 6. 下一步（第二步）需要使用者提供

1. 遊戲影片檔（任何常見格式，先給 5 到 10 分鐘的一段就夠）。
2. Claude API 金鑰的放置方式（環境變數名稱即可，金鑰本身不要貼進對話或 repo）。
3. 語音服務選擇：Azure AI Speech 或 ElevenLabs，以及金鑰放置方式。
4. 角色設定：名字、個性、口頭禪、禁忌。沒有的話沿用 fixture 裡的「小遊」。
5. 每小時與每場費用上限（美元）。
