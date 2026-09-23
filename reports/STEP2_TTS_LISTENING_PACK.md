# 第二步（語音）：Azure 發音試聽包實測

日期：2026-09-23
環境：Claude Code 雲端容器；Azure Speech 資源由使用者提供（區域 eastasia，Free F0）。金鑰以對話方式交付，測完由使用者在 Azure 重新產生使其失效；金鑰未寫入 repo。

## 實際執行與結果

| 命令 | 結果 |
| --- | --- |
| `npm test` | 41 pass / 0 fail |
| `node dist/src/cli.js tts-test --voices zh-TW-HsiaoChenNeural --limit 1` | 第一次 HTTP 400：空的 `<prosody>` 被拒。修正後 200 |
| `node dist/src/cli.js tts-test --out runtime/tts-test --lexicon none` | 120 個 wav，0 失敗，1,644 字元 |
| `node dist/src/cli.js tts-test --out runtime/tts-test/lexicon-demo --lexicon config/lexicon.zh-TW.example.json --limit 7` | 21 個 wav，0 失敗，309 字元 |
| 機器檢查（Python：RMS、長度） | 120 檔全部有聲音，長度 1.8 至 5.4 秒，平均 3.7 秒 |

用量合計約 2,000 字元，遠低於每月 50 萬字元的免費額度。

## 實測確認的事實

- zh-TW 三個聲音在 voices/list 為 GA：HsiaoChenNeural（女）、HsiaoYuNeural（女）、YunJheNeural（男）。
- **zh-TW 的 sapi 音標是注音符號**，音節以空格分開，聲調 ˊ ˇ ˋ ˙：`<phoneme alphabet="sapi" ph="ㄌㄜˋ ㄙㄜˋ">垃圾</phoneme>` → 200。
- 拼音加數字（zh-CN 格式）對 zh-TW 聲音一律 400，含 `le 4 - se 4`、`le4 se4`、`x-sapi` 等 6 種寫法。
- IPA 帶聲調符號 400；不帶聲調的 IPA 200 但無實用價值。
- `<sub alias="樂色">垃圾</sub>` 200，可作備援。
- 空 `<prosody>` 400；`<prosody rate="+10%">` 200。

## 交付

- `runtime/xiaoyou-tts-test.zip`（16.6 MB，不進 repo）：120 句 + 21 句注音對照 + `index.html` 試聽頁 + `machine-check.json`。
- 使用者需回覆：選哪個聲音；哪幾句哪個字唸錯。

## 尚未驗證

- 發音正確與否、自然度：需人耳，待使用者回覆。
- 長句、快語速、情緒語氣：本包只有短句原速。
