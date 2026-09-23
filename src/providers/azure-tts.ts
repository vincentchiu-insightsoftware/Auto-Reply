/**
 * AzureTtsProvider：Azure AI Speech REST 介面，zh-TW neural voice，SSML 輸入。
 * - 本地詞典（lexicon）：把指定詞彙包成 <phoneme alphabet="sapi" ph="...">，讀音由我們決定，不靠模型猜。
 *   zh-TW 的 sapi 音標是注音符號（例如 "ㄌㄜˋ ㄙㄜˋ"），音節以空格分開；拼音+數字是 zh-CN 的格式，zh-TW 會回 400（2026-09-23 實測）。
 * - 金鑰只從環境變數讀：AZURE_SPEECH_KEY、AZURE_SPEECH_REGION。沒有就明確失敗。
 * - 不重試。逾時由呼叫方 AbortSignal 決定。
 * 狀態：2026-09-23 以真實金鑰在 eastasia 執行過：合成、注音 phoneme、prosody rate 皆 200。
 */
import { TtsError, type ProviderUsage, type TtsProvider, type TtsRequest, type TtsResult } from '../types.js';
import { applyHomophones, type Homophones } from '../text/homophones.js';

export interface Lexicon {
  version: number;
  locale: string;
  /** 詞 → sapi 注音，例如 "垃圾": "ㄌㄜˋ ㄙㄜˋ" */
  entries: Record<string, string>;
}

export interface AzureTtsOptions {
  key: string;
  region: string;
  voice: string; // 例如 zh-TW-HsiaoChenNeural
  locale?: string; // 預設 zh-TW
  lexicon?: Lexicon | null;
  /** 替字表：先換同音字再送（任何供應商通用），與注音詞典可並用 */
  homophones?: Homophones | null;
  /** 每百萬字元美元；未知給 null → usage.usd = 'UNKNOWN' */
  pricePerMillionChars?: number | null;
  /** 測試可注入 fetch */
  fetchImpl?: typeof fetch;
  outputFormat?: string;
}

export const AZURE_ZH_TW_VOICES = ['zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural'] as const;

export function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 把詞典命中的詞包成 phoneme。長詞優先，避免「垃圾桶」被「垃圾」切壞。 */
export function applyLexicon(text: string, lexicon: Lexicon | null | undefined): string {
  if (!lexicon || Object.keys(lexicon.entries).length === 0) return escapeXml(text);
  const words = Object.keys(lexicon.entries).sort((a, b) => b.length - a.length);
  let out = '';
  let i = 0;
  outer: while (i < text.length) {
    for (const w of words) {
      if (text.startsWith(w, i)) {
        out += `<phoneme alphabet="sapi" ph="${escapeXml(lexicon.entries[w]!)}">${escapeXml(w)}</phoneme>`;
        i += w.length;
        continue outer;
      }
    }
    out += escapeXml(text[i]!);
    i++;
  }
  return out;
}

export function buildSsml(text: string, opts: { voice: string; locale: string; rate: number; lexicon?: Lexicon | null }): string {
  const ratePct = Math.round((opts.rate - 1) * 100);
  const inner = applyLexicon(text, opts.lexicon);
  // 空的 <prosody> 會被 Azure 以 400 拒絕（2026-09-23 實測），原速時不包
  const body = ratePct === 0 ? inner : `<prosody rate="${ratePct > 0 ? '+' : ''}${ratePct}%">${inner}</prosody>`;
  return (
    `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${opts.locale}">` +
    `<voice name="${escapeXml(opts.voice)}">${body}</voice></speak>`
  );
}

/** 從 RIFF/WAVE 標頭算時長（PCM）。不是 WAV 就回 null。 */
export function wavDurationMs(buf: Buffer): number | null {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12;
  let byteRate = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ') byteRate = buf.readUInt32LE(off + 16);
    if (id === 'data') {
      if (!byteRate) return null;
      const dataLen = Math.min(size, buf.length - off - 8);
      return Math.round((dataLen / byteRate) * 1000);
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/**
 * HTTP header 只接受 ISO-8859-1。金鑰或區域若含中文、全形字、空白或換行（常見於把佔位文字直接貼進環境變數），
 * fetch 會丟出難懂的 ByteString TypeError。這裡先檢查並回傳可讀的說明；沒問題回 null。不回傳金鑰內容。
 */
export function validateAzureCredentials(key: string, region: string): string | null {
  const firstBad = (v: string) => Array.from(v).findIndex((c) => c.codePointAt(0)! < 0x21 || c.codePointAt(0)! > 0x7e);
  const hex = (v: string, i: number) => 'U+' + v.codePointAt(i)!.toString(16).toUpperCase().padStart(4, '0');
  const bk = firstBad(key);
  if (bk >= 0) return `AZURE_SPEECH_KEY 第 ${bk + 1} 個字元不是可列印 ASCII（${hex(key, bk)}），金鑰應為 32 位十六進位字串，目前像是佔位文字，請填入 Azure 入口網站的實際金鑰`;
  const br = firstBad(region);
  if (br >= 0) return `AZURE_SPEECH_REGION 第 ${br + 1} 個字元不是可列印 ASCII（${hex(region, br)}），應為區域代碼，例如 eastasia`;
  return null;
}

export class AzureTtsProvider implements TtsProvider {
  readonly id = 'azure-tts';
  private u: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0, imageTokens: 0, ttsCharacters: 0, usd: 'UNKNOWN' };
  private price: number | null;
  constructor(private o: AzureTtsOptions) {
    if (!o.key || !o.region) throw new TtsError('Azure Speech 金鑰或區域未設定（AZURE_SPEECH_KEY / AZURE_SPEECH_REGION）');
    const bad = validateAzureCredentials(o.key, o.region);
    if (bad) throw new TtsError(bad);
    this.price = o.pricePerMillionChars ?? null;
    if (this.price !== null) this.u.usd = 0;
  }
  static fromEnv(voice: string, extra: Partial<AzureTtsOptions> = {}): AzureTtsProvider {
    return new AzureTtsProvider({ key: process.env.AZURE_SPEECH_KEY ?? '', region: process.env.AZURE_SPEECH_REGION ?? '', voice, ...extra });
  }
  usage(): ProviderUsage {
    return { ...this.u };
  }
  lastHomophoneHits: string[] = [];
  async synthesize(req: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    const voice = req.voiceId ?? this.o.voice;
    const sub = applyHomophones(req.text, this.o.homophones);
    this.lastHomophoneHits = sub.hits;
    const ssml = buildSsml(sub.text, { voice, locale: this.o.locale ?? 'zh-TW', rate: req.rate ?? 1, lexicon: this.o.lexicon ?? null });
    const url = `https://${this.o.region}.tts.speech.microsoft.com/cognitiveservices/v1`;
    const f = this.o.fetchImpl ?? fetch;
    this.u.calls++;
    const chars = Array.from(req.text).length;
    this.u.ttsCharacters += chars;
    if (this.price !== null && typeof this.u.usd === 'number') this.u.usd += (chars * this.price) / 1_000_000;
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': this.o.key,
          'Content-Type': 'application/ssml+xml',
          'X-Microsoft-OutputFormat': this.o.outputFormat ?? 'riff-24khz-16bit-mono-pcm',
          'User-Agent': 'auto-reply-host',
        },
        body: ssml,
        signal,
      });
    } catch (e) {
      throw new TtsError(`azure request failed: ${(e as Error).name}: ${(e as Error).message}`);
    }
    if (res.status === 401 || res.status === 403) throw new TtsError(`azure auth failed (${res.status})`);
    if (res.status === 429) throw new TtsError('azure rate limited (429)');
    if (!res.ok) throw new TtsError(`azure http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const audio = Buffer.from(await res.arrayBuffer());
    const durationMs = wavDurationMs(audio);
    if (durationMs === null || audio.length < 100) throw new TtsError('azure returned non-wav or empty audio');
    return { audio, mediaType: 'audio/wav', durationMs };
  }
}
