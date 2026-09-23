import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ElevenLabsTtsProvider, pcmToWav } from '../src/providers/elevenlabs-tts.js';
import { applyHomophones } from '../src/text/homophones.js';
import { wavDurationMs } from '../src/providers/azure-tts.js';
import { wavRms } from '../src/tts-test.js';
import { TtsError } from '../src/types.js';

test('替字表：長詞優先，回報命中', () => {
  const h = { version: 1, locale: 'zh-TW', entries: { '垃圾': '樂色', '垃圾桶': '樂色桶' } };
  const r = applyHomophones('把垃圾丟進垃圾桶', h);
  assert.equal(r.text, '把樂色丟進樂色桶');
  assert.deepEqual(r.hits, ['垃圾', '垃圾桶']);
  assert.deepEqual(applyHomophones('沒有命中', h), { text: '沒有命中', hits: [] });
});

test('pcm → wav 包裝與時長', () => {
  const pcm = Buffer.alloc(24000 * 2); // 1 秒 @24kHz 16-bit
  const wav = pcmToWav(pcm, 24000);
  assert.equal(wavDurationMs(wav), 1000);
  assert.equal(wavRms(wav), 0);
});

test('elevenlabs：沒金鑰失敗；401；pcm 成功並套替字；不允許 pcm 時退回 mp3', async () => {
  assert.throws(() => new ElevenLabsTtsProvider({ apiKey: '', voiceId: 'v' }), TtsError);
  assert.throws(() => new ElevenLabsTtsProvider({ apiKey: '把金鑰貼這裡', voiceId: 'v' }), /非可列印/);
  const mk = (status: number, body: Buffer | string) => (async () => new Response(body, { status })) as unknown as typeof fetch;
  const bad = new ElevenLabsTtsProvider({ apiKey: 'k', voiceId: 'v', fetchImpl: mk(401, 'x') });
  await assert.rejects(bad.synthesize({ text: '嗨', voiceId: null }, new AbortController().signal), /auth failed/);

  const seen: { url: string; body: string }[] = [];
  const ok = new ElevenLabsTtsProvider({
    apiKey: 'k', voiceId: 'abc', modelId: 'eleven_v3', homophones: { version: 1, locale: 'zh-TW', entries: { '垃圾': '樂色' } },
    fetchImpl: (async (url: string, init: RequestInit) => {
      seen.push({ url, body: String(init.body) });
      return new Response(Buffer.alloc(24000 * 2), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r = await ok.synthesize({ text: '把垃圾清掉', voiceId: null }, new AbortController().signal);
  assert.equal(r.mediaType, 'audio/wav');
  assert.equal(r.durationMs, 1000);
  assert.match(seen[0]!.url, /text-to-speech\/abc\?output_format=pcm_24000/);
  assert.match(seen[0]!.body, /"text":"把樂色清掉"/);
  assert.match(seen[0]!.body, /"model_id":"eleven_v3"/);
  assert.deepEqual(ok.lastHomophoneHits, ['垃圾']);

  let calls = 0;
  const fb = new ElevenLabsTtsProvider({
    apiKey: 'k', voiceId: 'abc',
    fetchImpl: (async (url: string) => {
      calls++;
      if (/pcm_/.test(url)) return new Response('{"detail":"output_format pcm_24000 requires a higher tier"}', { status: 403 });
      return new Response(Buffer.alloc(16000), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r2 = await fb.synthesize({ text: '嗨', voiceId: null }, new AbortController().signal);
  assert.equal(calls, 2);
  assert.equal(r2.mediaType, 'audio/mpeg');
  assert.equal(r2.durationMs, 1000); // 16000 bytes @128kbps
});
