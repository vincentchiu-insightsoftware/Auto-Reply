/**
 * 發音試聽包：把 fixtures/pronunciation/sentences.json 用指定聲音合成，寫出 wav 與試聽清單。
 * 需要 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION。沒有就明確失敗，不產生假結果。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AzureTtsProvider, AZURE_ZH_TW_VOICES, type Lexicon } from './providers/azure-tts.js';

interface SentenceSet {
  version: number;
  locale: string;
  sentences: { id: string; text: string; listen_for: { chars: string; expected: string }[] }[];
}

export interface TtsTestOptions {
  sentencesPath: string;
  outDir: string;
  voices: string[];
  lexiconPath: string | null;
  limit: number | null;
  timeoutMs: number;
  rate: number;
}

export async function runTtsTest(o: TtsTestOptions): Promise<{ files: number; failures: number; chars: number }> {
  const set = JSON.parse(readFileSync(o.sentencesPath, 'utf8')) as SentenceSet;
  const lexicon: Lexicon | null = o.lexiconPath ? (JSON.parse(readFileSync(o.lexiconPath, 'utf8')) as Lexicon) : null;
  const sentences = o.limit ? set.sentences.slice(0, o.limit) : set.sentences;
  mkdirSync(o.outDir, { recursive: true });
  const lines: string[] = ['# 發音試聽清單', '', `產生時間：${new Date().toISOString()}`, `詞典：${o.lexiconPath ?? '（無）'}，條目 ${lexicon ? Object.keys(lexicon.entries).length : 0}`, '', '每一句聽一次，把唸錯的字記在「結果」欄。唸錯的詞加進 config/lexicon.zh-TW.json 後重跑，確認修正。', ''];
  let files = 0, failures = 0, chars = 0;
  const failLog: string[] = [];
  for (const voice of o.voices) {
    const tts = AzureTtsProvider.fromEnv(voice, { lexicon });
    lines.push(`## ${voice}`, '', '| 句 | 文字 | 要聽的字 | 檔案 | 結果 |', '| --- | --- | --- | --- | --- |');
    for (const s of sentences) {
      const file = `${voice}_${s.id}.wav`;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
      try {
        const r = await tts.synthesize({ text: s.text, voiceId: voice, rate: o.rate }, ctl.signal);
        writeFileSync(join(o.outDir, file), r.audio);
        files++;
        chars += Array.from(s.text).length;
        lines.push(`| ${s.id} | ${s.text} | ${s.listen_for.map((l) => `${l.chars}（${l.expected}）`).join('；')} | ${file}（${(r.durationMs / 1000).toFixed(1)}s） |  |`);
        process.stderr.write(`ok  ${voice} ${s.id} ${r.durationMs}ms\n`);
      } catch (e) {
        failures++;
        failLog.push(`${voice} ${s.id}: ${(e as Error).message}`);
        lines.push(`| ${s.id} | ${s.text} | ${s.listen_for.map((l) => l.chars).join('；')} | 失敗：${(e as Error).message} |  |`);
        process.stderr.write(`ERR ${voice} ${s.id} ${(e as Error).message}\n`);
        if (/auth failed/.test((e as Error).message)) break; // 金鑰錯就不用再試
      } finally {
        clearTimeout(timer);
      }
    }
    lines.push('', `用量：${JSON.stringify(tts.usage())}`, '');
  }
  lines.push('## 失敗記錄', '', ...(failLog.length ? failLog.map((f) => `- ${f}`) : ['- 無']));
  writeFileSync(join(o.outDir, 'index.md'), lines.join('\n'));
  return { files, failures, chars };
}

export function defaultVoices(): string[] {
  return [...AZURE_ZH_TW_VOICES];
}
