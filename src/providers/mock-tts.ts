/** MockTtsProvider：產生靜音 WAV 並回報時長。通過只代表管線通，不代表真實 TTS 通。 */
import type { Clock } from '../clock.js';
import { TtsError, type ProviderUsage, type TtsProvider, type TtsRequest, type TtsResult } from '../types.js';
import type { FaultSchedule } from './faults.js';
import { countChars } from '../util/text.js';

export function silentWav(durationMs: number, sampleRate = 16000): Buffer {
  const samples = Math.round((durationMs / 1000) * sampleRate);
  const dataLen = samples * 2;
  const b = Buffer.alloc(44 + dataLen);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataLen, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataLen, 40);
  return b;
}

export class MockTtsProvider implements TtsProvider {
  readonly id = 'mock-tts';
  private u: ProviderUsage = { calls: 0, inputTokens: 0, outputTokens: 0, imageTokens: 0, ttsCharacters: 0, usd: 'UNKNOWN' };
  constructor(
    private clock: Clock,
    private faults: FaultSchedule | null,
    private latencyMs = 400,
  ) {}
  usage(): ProviderUsage {
    return { ...this.u };
  }
  async synthesize(req: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    this.u.calls++;
    const n = countChars(req.text);
    this.u.ttsCharacters += n;
    await this.clock.sleep(this.latencyMs, signal);
    if (this.faults?.active(this.clock.now(), ['tts_fail'])) throw new TtsError('mock tts failure');
    const durationMs = Math.min(8000, Math.max(700, Math.round((n * 230) / (req.rate ?? 1))));
    return { audio: silentWav(Math.min(durationMs, 2000)), mediaType: 'audio/wav', durationMs };
  }
}
