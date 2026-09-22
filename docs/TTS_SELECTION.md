# 語音服務選擇

日期：2026-09-22。首要條件：講繁體中文時用字發音不能跑掉。其次才是自然度與價格。

## 結論

**首選 Azure AI Speech，zh-TW neural voice。** 理由不是它一定唸得最準，而是它是候選中唯一能「唸錯就強制指定讀音」的：

| 能力 | Azure AI Speech | ElevenLabs |
| --- | --- | --- |
| 官方台灣中文聲音 | 有，zh-TW 三個：HsiaoChen（女）、HsiaoYu（女）、YunJhe（男） | 只標 Chinese，不分繁簡與台灣口音 |
| 逐詞指定讀音 | 有。SSML `<phoneme alphabet="sapi" ph="le 4 - se 4">垃圾</phoneme>`，拼音加聲調，官方列出 zh-TW 支援 sapi 音標集 | 音標標籤只支援 `eleven_flash_v2`，官方文件沒有中文音標支援 |
| 整批詞典 | 有。自訂 lexicon 檔（100 KB 內），一次修多個詞 | 有 pronunciation dictionary，但中文只能用 alias 換字，不能指定讀音 |
| 唸錯時的修法 | 加一條詞典，永久修正 | 換字、加標點、換模型，碰運氣 |
| 自然度 | 專業主播風，穩定但比較「正」 | 情緒與口語感較強 |
| 價格 | 免費額度每月 50 萬字元；超出的每百萬字元單價官方頁面本次顯示佔位符，需在訂閱內確認 | 依方案 |

你之前遇到 ElevenLabs 某些字唸怪，正好是右欄的問題：它沒有給中文一個「我說這個字就唸這樣」的開關。Azure 有。

保留 ElevenLabs 作備選：如果試聽後覺得 Azure 太正經，可以只在特定情境切換，但那時要接受偶爾唸錯且修不了。

## 免費額度夠用多久

每句約 30 到 60 字，每小時如果講 300 句，約 1.5 萬字元。50 萬字元約可支撐 30 小時直播，測試期完全夠。

## 我能測什麼、不能測什麼

- **我聽不到聲音。** 雲端環境沒有喇叭，也沒有可靠的自動化方法判斷「這個字唸對了沒」。用語音辨識反查會被辨識模型自己「修正」回正確字，測不到讀音錯誤。
- **我能做的：** 準備 40 句專門踩雷的句子（破音字、台灣慣用讀音、遊戲用語），一個命令產生三個聲音的試聽檔與清單，你花 10 到 15 分鐘聽完打勾。聽到唸錯的詞，加進詞典重跑，確認修好。
- 這是這個問題唯一可靠的驗證方式：人耳。程式負責把流程縮到最短。

## 操作步驤（需要你先做）

1. 到 Azure 建立一個 Speech 資源（免費 F0 層即可），取得金鑰與區域（例如 `eastasia`）。
2. 在執行環境設定環境變數 `AZURE_SPEECH_KEY` 與 `AZURE_SPEECH_REGION`。金鑰不要貼進對話或 repo。
3. 執行：

```
npm ci && npm run build
node dist/src/cli.js tts-test                 # 三個聲音 × 40 句，輸出到 runtime/tts-test/
node dist/src/cli.js tts-test --voices zh-TW-HsiaoChenNeural --limit 10   # 先小量試
```

4. 打開 `runtime/tts-test/index.md`，逐句聽，把唸錯的字記在「結果」欄。
5. 唸錯的詞加進 `config/lexicon.zh-TW.json`，格式見 `config/lexicon.zh-TW.example.json`。重跑同一命令，確認修正。
6. 同時決定「小遊」用哪個聲音。

## 狀態

Azure 接口程式已寫好並有單元測試（SSML 組裝、詞典包裝、WAV 時長、HTTP 錯誤分流），但**尚未用真實金鑰呼叫過**，標 NOT_TESTED。zh-TW 的 sapi 音標格式依官方文件的 zh-CN 範例推定相同，首次真實呼叫時要確認 400 錯誤是否出現。
