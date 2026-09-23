/**
 * ElevenLabsTtsProvider：POST /v1/text-to-speech/{voice_id}，xi-api-key 驗證。
 * - 用使用者自己複製的聲音（voice_id）。
 * - 讀音修正靠替字表（homophones），不依賴廠商音標。
 * - 預設要 pcm_24000 並自行包成 WAV 以取得精確時長；方案不允許 PCM 時退回 mp3 並以位元率估時長。
 * - 金鑰只從環境變數 ELEVENLABS_API_KEY 讀。不重試。
 * 狀態：程式已寫、有單元測試；真實呼叫待使用者金鑰（NOT_TESTED）。
 */
import { TtsError, type ProviderUsage, type TtsProvider, type TtsRequest, type TtsResult } from '../types.js';
import { applyHomophones, type Homophones } from '../text/homophones.js';

export interface ElevenLabsOptions {
  apiKey: string;
  voiceId: string;
  modelId?: string; // 預設 eleven_multilingual_v2
  languageCode?: string | null; // 例如 'zh'；v2 不一定接受，預設不送
  outputFormat?: 'pcm_24000' | 'pcm_22050' | 'pcm_16000' | 'mp3_44100_128';
  voiceSettings?: { stability?: number; similarity_boost?: number; style?: number; use_speaker_boost?: boolean; speed?: number };
  homophones?: Homophones | null;
  pricePerMillionChars?: number | null;
  fetchImpl?: typeof fetch;
}

export const ELEVENLABS_MODELS = ['eleven_multilingual_v2', 'eleven_v3', 'eleven_flash_v2_5'] as const;

export function pcmToWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function validateElevenLabsKey(key: string, voiceId: string): string | null {
  const bad = (v: string) => Array.from(v).some((c) => c.codePointAt(0)! < 0x21 || c.codePointAt(0)! > 0x7e);
  if (bad(key)) return 'ELEVENLABS_API_KEY 含非可列印 ASCII 字元，看起來不是真正的金鑰';
  if (bad(voiceId)) return 'voice_id 含非可列印 ASCII 字元';
  return null;
}

export class ElevenLabsTtsProvider implements TtsProvider {
  readonly id = 'elevenlabs-tts';
  private u: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0, imageTokens: 0, ttsCharacters: 0, usd: 'UNKNOWN' };
  private price: number | null;
  private format: NonNullable<ElevenLabsOptions['outputFormat']>;
  lastHomophoneHits: string[] = [];
  constructor(private o: ElevenLabsOptions) {
    if (!o.apiKey || !o.voiceId) throw new TtsError('ElevenLabs 金鑰或 voice_id 未設定（ELEVENLABS_API_KEY / --voice-id）');
    const bad = validateElevenLabsKey(o.apiKey, o.voiceId);
    if (bad) throw new TtsError(bad);
    this.price = o.pricePerMillionChars ?? null;
    if (this.price !== null) this.u.usd = 0;
    this.format = o.outputFormat ?? 'pcm_24000';
  }
  static fromEnv(voiceId: string, extra: Partial<ElevenLabsOptions> = {}): ElevenLabsTtsProvider {
    return new ElevenLabsTtsProvider({ apiKey: process.env.ELEVENLABS_API_KEY ?? '', voiceId, ...extra });
  }
  get modelId(): string {
    return this.o.modelId ?? 'eleven_multilingual_v2';
  }
  usage(): ProviderUsage {
    return { ...this.u };
  }

  private async post(text: string, format: string, signal: AbortSignal): Promise<Response> {
    const f = this.o.fetchImpl ?? fetch;
    const body: Record<string, unknown> = { text, model_id: this.modelId };
    if (this.o.languageCode) body.language_code = this.o.languageCode;
    if (this.o.voiceSettings) body.voice_settings = this.o.voiceSettings;
    try {
      return await f(`https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(this.o.voiceId)}?output_format=${format}`, {
        method: 'POST',
        headers: { 'xi-api-key': this.o.apiKey, 'Content-Type': 'application/json', Accept: '*/*' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      throw new TtsError(`elevenlabs request failed: ${(e as Error).name}: ${(e as Error).message}`);
    }
  }

  async synthesize(req: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    const sub = applyHomophones(req.text, this.o.homophones);
    this.lastHomophoneHits = sub.hits;
    this.u.calls++;
    const chars = Array.from(sub.text).length;
    this.u.ttsCharacters += chars;
    if (this.price !== null && typeof this.u.usd === 'number') this.u.usd += (chars * this.price) / 1_000_000;

    let res = await this.post(sub.text, this.format, signal);
    let format: string = this.format;
    if (!res.ok && res.status !== 401 && res.status !== 429 && format.startsWith('pcm_')) {
      // 方案不允許 PCM 時退回 mp3
      const errText = await res.text();
      if (/output_format|pcm|tier|plan|subscription/i.test(errText) || res.status === 400 || res.status === 403) {
        format = 'mp3_44100_128';
        res = await this.post(sub.text, format, signal);
      } else {
        throw new TtsError(`elevenlabs http ${res.status}: ${errText.slice(0, 200)}`);
      }
    }
    if (res.status === 401) throw new TtsError('elevenlabs auth failed (401)');
    if (res.status === 429) throw new TtsError('elevenlabs rate limited (429)');
    if (!res.ok) throw new TtsError(`elevenlabs http ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length < 100) throw new TtsError('elevenlabs returned empty audio');
    if (format.startsWith('pcm_')) {
      const sr = Number(format.split('_')[1]);
      return { audio: pcmToWav(bytes, sr), mediaType: 'audio/wav', durationMs: Math.round((bytes.length / 2 / sr) * 1000) };
    }
    const kbps = Number(format.split('_')[2] ?? '128');
    return { audio: bytes, mediaType: 'audio/mpeg', durationMs: Math.round((bytes.length * 8) / (kbps * 1000) * 1000) };
  }
}
