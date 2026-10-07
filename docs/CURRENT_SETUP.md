# 目前設定（給任何要接手的人或視窗看）

更新：2026-10-07

| 項目 | 現在用什麼 | 在哪裡設定 |
|---|---|---|
| 測試台 / 控制頁 | https://vivacious-abundance-production-b7d0.up.railway.app/?key=xiaoyou-2026 | Railway 專案 auto-reply-report → 服務「內部測試台」 |
| 直播畫面頁（OBS 瀏覽器來源） | https://vivacious-abundance-production-b7d0.up.railway.app/?view=live&key=xiaoyou-2026 | 同上 |
| 大腦 | AI Token King 中繼站，模型 qwen3-vl-flash | Railway 變數 OPENAI_MODEL（也可填 gpt-5.5） |
| 聲音 | Azure HD 曉悠 zh-CN-Xiaoyou:DragonHDFlashLatestNeural，預設語氣 chat | config/runtime.stage.json → tts |
| 皮（VRM 角色） | Alicia Solid（內測暫用；© DWANGO，商用可、免標註） | Railway 變數 AVATAR_URL；或把 .vrm 放到伺服器 runtime/avatar/model.vrm |
| Kick 留言 | 官方 Events API webhook，已授權頻道 vincentchiu | 控制頁 Kick 面板 |
| 畫面推流 | OBS（任一台電腦）擷取直播畫面頁 | docs/OBS_SETUP.md |

重點：皮、聲音、大腦都在雲端伺服器上，瀏覽器開網址就會載入，**本機不需要任何模型檔或聲音檔**。OBS 只負責把那一頁畫面推到 Kick；設定改了，OBS 對瀏覽器來源按右鍵「重新整理」就會看到新版本。

Railway 部署觸發已限縮：只有 src/、stage/、config/、fixtures/ 與套件檔變動才會重啟測試台；報告頁只在 report-site/ 變動時重建。
