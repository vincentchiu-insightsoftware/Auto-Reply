import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyLexicon, buildSsml, wavDurationMs, AzureTtsProvider } from '../src/providers/azure-tts.js';
import { silentWav } from '../src/providers/mock-tts.js';
import { TtsError } from '../src/types.js';

test('azure: SSML 逸出與詞典包裝，長詞優先', () => {
  const lex = { version: 1, locale: 'zh-TW', entries: { '垃圾': 'le 4 - se 4', '垃圾桶': 'le 4 - se 4 - tong 3' } };
  const out = applyLexicon('把垃圾丟進垃圾桶 <b>', lex);
  assert.equal(out, '把<phoneme alphabet="sapi" ph="le 4 - se 4">垃圾</phoneme>丟進<phoneme alphabet="sapi" ph="le 4 - se 4 - tong 3">垃圾桶</phoneme> &lt;b&gt;');
  const ssml = buildSsml('你好', { voice: 'zh-TW-HsiaoChenNeural', locale: 'zh-TW', rate: 1.1, lexicon: null });
  assert.match(ssml, /xml:lang="zh-TW"/);
  assert.match(ssml, /<voice name="zh-TW-HsiaoChenNeural"><prosody rate="\+10%">你好<\/prosody>/);
  assert.match(buildSsml('a', { voice: 'v', locale: 'zh-TW', rate: 1 }), /<prosody>a<\/prosody>/);
});

test('azure: WAV 時長解析', () => {
  assert.equal(wavDurationMs(silentWav(1234)), 1234);
  assert.equal(wavDurationMs(Buffer.from('not wav')), null);
});

test('azure: 沒金鑰就明確失敗；HTTP 錯誤分流；成功回傳時長', async () => {
  assert.throws(() => new AzureTtsProvider({ key: '', region: '', voice: 'v' }), TtsError);
  const mk = (status: number, body: Buffer | string) => async () => new Response(body, { status, headers: { 'content-type': 'audio/wav' } });
  const bad = new AzureTtsProvider({ key: 'k', region: 'eastasia', voice: 'v', fetchImpl: mk(401, 'x') as unknown as typeof fetch });
  await assert.rejects(bad.synthesize({ text: '嗨', voiceId: null }, new AbortController().signal), /auth failed/);
  const rl = new AzureTtsProvider({ key: 'k', region: 'eastasia', voice: 'v', fetchImpl: mk(429, 'x') as unknown as typeof fetch });
  await assert.rejects(rl.synthesize({ text: '嗨', voiceId: null }, new AbortController().signal), /rate limited/);
  let seenBody = '';
  const ok = new AzureTtsProvider({
    key: 'k', region: 'eastasia', voice: 'zh-TW-HsiaoChenNeural', pricePerMillionChars: 15,
    lexicon: { version: 1, locale: 'zh-TW', entries: { '垃圾': 'le 4 - se 4' } },
    fetchImpl: (async (_url: string, init: RequestInit) => {
      seenBody = String(init.body);
      return new Response(silentWav(900), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const r = await ok.synthesize({ text: '把垃圾清掉', voiceId: null }, new AbortController().signal);
  assert.equal(r.durationMs, 900);
  assert.match(seenBody, /ph="le 4 - se 4"/);
  assert.equal(ok.usage().ttsCharacters, 5);
  assert.ok(typeof ok.usage().usd === 'number' && (ok.usage().usd as number) > 0);
});
