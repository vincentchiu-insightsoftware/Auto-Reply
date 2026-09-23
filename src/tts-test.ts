/**
 * 發音試聽包：把 fixtures/pronunciation/sentences.json 用指定供應商與聲音合成，
 * 寫出音檔、index.md、可直接點播放的 index.html，以及機器檢查（有無聲音、長度）。
 * 支援 azure（zh-TW 聲音）與 elevenlabs（使用者複製的聲音 × 多個模型）。沒金鑰就明確失敗。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AzureTtsProvider, AZURE_ZH_TW_VOICES, type Lexicon } from './providers/azure-tts.js';
import { ElevenLabsTtsProvider, ELEVENLABS_MODELS } from './providers/elevenlabs-tts.js';
import { loadHomophones, type Homophones } from './text/homophones.js';
import type { TtsProvider } from './types.js';

interface SentenceSet {
  version: number;
  locale: string;
  sentences: { id: string; text: string; listen_for: { chars: string; expected: string }[] }[];
}

export interface TtsTestOptions {
  provider: 'azure' | 'elevenlabs';
  sentencesPath: string;
  outDir: string;
  /** azure：聲音名稱清單；elevenlabs：模型清單 */
  variants: string[];
  /** elevenlabs 必填 */
  voiceId: string | null;
  lexiconPath: string | null; // azure 注音詞典
  homophonesPath: string | null; // 替字表（任何供應商）
  limit: number | null;
  timeoutMs: number;
  rate: number;
}

export interface TtsTestResult {
  files: number;
  failures: number;
  chars: number;
  credentialError: string | null;
  silentFiles: string[];
  indexHtml: string;
}

interface Row {
  variant: string;
  id: string;
  text: string;
  hints: string;
  file: string | null;
  durationMs: number | null;
  rms: number | null;
  error: string | null;
  substituted: string[];
}

/** WAV 16-bit 的 RMS；非 WAV 回 null */
export function wavRms(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const end = Math.min(buf.length, off + 8 + size);
      let sum = 0, n = 0;
      for (let i = off + 8; i + 1 < end; i += 2) {
        const v = buf.readInt16LE(i);
        sum += v * v;
        n++;
      }
      return n ? Math.sqrt(sum / n) : 0;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderIndexHtml(title: string, rows: Row[], variants: string[], notes: string[]): string {
  const H: string[] = [];
  H.push(`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${esc(title)}</title><meta name="viewport" content="width=device-width,initial-scale=1">`);
  H.push('<style>body{font-family:system-ui,-apple-system,"Noto Sans TC",sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;line-height:1.6;color:#222}h1{font-size:1.6rem}h2{margin-top:2.2rem;border-bottom:2px solid #ddd;padding-bottom:4px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px 8px;vertical-align:top;font-size:.95rem}th{background:#f5f5f5;text-align:left}audio{width:230px;height:32px}.hint{color:#555}.mark{background:#fff3b0;padding:0 3px;border-radius:3px}.note{background:#eef6ff;border-left:4px solid #4a90e2;padding:10px 14px;margin:12px 0}textarea{width:100%;min-height:34px;font-size:.9rem}small{color:#777}.err{color:#b00}</style></head><body>');
  H.push(`<h1>${esc(title)}</h1>`);
  H.push('<div class="note"><b>怎麼聽：</b>每一列按播放，只看「要聽的字」那一欄，判斷唸得對不對；也順便感受自然度。唸錯就在最右邊格子記下來。<br><b>最後要告訴我：</b>1. 哪個聲音／模型最好；2. 哪幾句哪個字唸錯。</div>');
  for (const n of notes) H.push(`<p><small>${esc(n)}</small></p>`);
  for (const v of variants) {
    H.push(`<h2>${esc(v)}</h2><table><tr><th style="width:44px">句</th><th>文字</th><th style="width:30%">要聽的字（應該唸）</th><th>播放</th><th style="width:18%">你的結果</th></tr>`);
    for (const r of rows.filter((x) => x.variant === v)) {
      const play = r.file ? `<audio controls preload="none" src="${esc(r.file)}"></audio><br><small>${r.durationMs === null ? '' : (r.durationMs / 1000).toFixed(1) + 's'}${r.substituted.length ? ' 替字：' + esc(r.substituted.join('、')) : ''}</small>` : `<span class="err">失敗：${esc(r.error ?? '')}</span>`;
      H.push(`<tr><td>${esc(r.id)}</td><td>${esc(r.text)}</td><td class="hint">${r.hints}</td><td>${play}</td><td><textarea placeholder="對 / 哪個字錯"></textarea></td></tr>`);
    }
    H.push('</table>');
  }
  H.push('<h2>聽完之後</h2><p>把「哪個聲音／模型」和「哪幾句哪個字唸錯」回覆給我。唸錯的詞我會加進替字表或注音詞典，重做一次讓你確認。</p></body></html>');
  return H.join('\n');
}

export async function runTtsTest(o: TtsTestOptions): Promise<TtsTestResult> {
  const set = JSON.parse(readFileSync(o.sentencesPath, 'utf8')) as SentenceSet;
  const lexicon: Lexicon | null = o.lexiconPath ? (JSON.parse(readFileSync(o.lexiconPath, 'utf8')) as Lexicon) : null;
  const homophones: Homophones | null = loadHomophones(o.homophonesPath);
  const sentences = o.limit ? set.sentences.slice(0, o.limit) : set.sentences;
  mkdirSync(o.outDir, { recursive: true });
  const rows: Row[] = [];
  let files = 0, failures = 0, chars = 0;
  let credentialError: string | null = null;
  const usageLines: string[] = [];

  for (const variant of o.variants) {
    let tts: TtsProvider;
    try {
      tts =
        o.provider === 'azure'
          ? AzureTtsProvider.fromEnv(variant, { lexicon, homophones })
          : ElevenLabsTtsProvider.fromEnv(o.voiceId ?? '', { modelId: variant, homophones });
    } catch (e) {
      credentialError = (e as Error).message;
      failures += sentences.length * (o.variants.length - o.variants.indexOf(variant));
      process.stderr.write(`ERR 憑證檢查未通過：${credentialError}\n`);
      break;
    }
    let authFailed = false;
    for (const s of sentences) {
      const hints = s.listen_for.map((l) => `<span class="mark">${esc(l.chars)}</span> → ${esc(l.expected)}`).join('<br>');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), o.timeoutMs);
      try {
        const r = await tts.synthesize({ text: s.text, voiceId: o.provider === 'azure' ? variant : null, rate: o.rate }, ctl.signal);
        const ext = r.mediaType === 'audio/wav' ? 'wav' : 'mp3';
        const file = `${variant}_${s.id}.${ext}`;
        writeFileSync(join(o.outDir, file), r.audio);
        files++;
        chars += Array.from(s.text).length;
        const rms = r.mediaType === 'audio/wav' ? wavRms(r.audio) : null;
        const subs = (tts as { lastHomophoneHits?: string[] }).lastHomophoneHits ?? [];
        rows.push({ variant, id: s.id, text: s.text, hints, file, durationMs: r.durationMs, rms, error: null, substituted: [...subs] });
        process.stderr.write(`ok  ${variant} ${s.id} ${r.durationMs}ms\n`);
      } catch (e) {
        failures++;
        const msg = (e as Error).message;
        rows.push({ variant, id: s.id, text: s.text, hints, file: null, durationMs: null, rms: null, error: msg, substituted: [] });
        process.stderr.write(`ERR ${variant} ${s.id} ${msg}\n`);
        if (/auth failed/.test(msg)) {
          authFailed = true;
          break;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    usageLines.push(`${variant}: ${JSON.stringify(tts.usage())}`);
    if (authFailed) {
      credentialError = 'auth failed';
      break;
    }
  }

  const silentFiles = rows.filter((r) => r.file && r.rms !== null && r.rms < 50).map((r) => r.file!);
  const wavRows = rows.filter((r) => r.rms !== null);
  const notes = [
    `供應商：${o.provider}；替字表：${o.homophonesPath ?? '（無）'}（${homophones ? Object.keys(homophones.entries).length : 0} 條）；注音詞典：${o.lexiconPath ?? '（無）'}`,
    `機器檢查：${files} 個檔；${wavRows.length ? `WAV 檔中靜音 ${silentFiles.length} 個` : 'mp3 檔不做靜音檢查'}；失敗 ${failures} 個。這只代表「有發出聲音」，唸對不對還是要你聽。`,
    `用量：${usageLines.join('；')}`,
  ];
  if (credentialError) notes.unshift(`憑證錯誤：${credentialError}`);
  const md: string[] = ['# 發音試聽清單', '', `產生時間：${new Date().toISOString()}`, ...notes.map((n) => `- ${n}`), ''];
  for (const v of o.variants) {
    md.push(`## ${v}`, '', '| 句 | 文字 | 要聽的字 | 檔案 | 結果 |', '| --- | --- | --- | --- | --- |');
    for (const r of rows.filter((x) => x.variant === v)) md.push(`| ${r.id} | ${r.text} | ${r.hints.replace(/<[^>]+>/g, '')} | ${r.file ?? '失敗：' + r.error} |  |`);
    md.push('');
  }
  writeFileSync(join(o.outDir, 'index.md'), md.join('\n'));
  const indexHtml = join(o.outDir, 'index.html');
  writeFileSync(indexHtml, renderIndexHtml(`發音試聽包（${o.provider}）`, rows, o.variants, notes));
  writeFileSync(join(o.outDir, 'machine-check.json'), JSON.stringify({ files, failures, chars, silentFiles, rows: rows.map((r) => ({ variant: r.variant, id: r.id, file: r.file, durationMs: r.durationMs, rms: r.rms, error: r.error })) }, null, 2));
  return { files, failures, chars, credentialError, silentFiles, indexHtml };
}

export function defaultVariants(provider: 'azure' | 'elevenlabs'): string[] {
  return provider === 'azure' ? [...AZURE_ZH_TW_VOICES] : [...ELEVENLABS_MODELS];
}
