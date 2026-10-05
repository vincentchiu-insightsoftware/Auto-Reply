import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { verifyKickSignature, parseKickChat } from '../src/kick/client.js';
import { WebChatSource } from '../src/sources/web-chat.js';
import { VirtualClock } from '../src/clock.js';
import { Deduper } from '../src/context/dedup.js';

test('kick: webhook 簽章驗得過，改一個字就驗不過，錯的公鑰也驗不過', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  const id = '01JKICKMSGID', ts = '2026-10-05T00:00:00Z', body = JSON.stringify({ message_id: 'm1', content: '哈囉' });
  const sig = sign('sha256', Buffer.from(`${id}.${ts}.${body}`), privateKey).toString('base64');
  assert.equal(verifyKickSignature(pem, id, ts, body, sig), true);
  assert.equal(verifyKickSignature(pem, id, ts, body + ' ', sig), false);
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'pem' }) as string;
  assert.equal(verifyKickSignature(other, id, ts, body, sig), false);
  assert.equal(verifyKickSignature('not a key', id, ts, body, sig), false);
});

test('kick: payload 轉留言；空內容或沒 ID 丟掉', () => {
  const ev = parseKickChat({ message_id: 'abc', content: '小遊你好', sender: { user_id: 5, username: 'amy' }, broadcaster: { user_id: 9, channel_slug: 'xiaoyou' } });
  assert.deepEqual(ev, { messageId: 'abc', author: 'amy', text: '小遊你好', senderUserId: 5, broadcasterUserId: 9, broadcasterSlug: 'xiaoyou' });
  assert.equal(parseKickChat({ message_id: 'abc', content: '   ' }), null);
  assert.equal(parseKickChat({ message_id: 'e1', content: '[emote:1730754:emojiAwake] 早安 [emote:1579036:emojiBlowKiss]' })?.text, '(表情 Awake) 早安 (表情 BlowKiss)');
  assert.equal(parseKickChat({ content: 'x' }), null);
  assert.equal(parseKickChat('nope'), null);
});

test('kick: 外部留言與網頁留言同 ID 不互撞；Kick 重送同 ID 不算新', () => {
  const clock = new VirtualClock(0);
  const src = new WebChatSource(clock);
  const d = new Deduper();
  const web = src.push('同事', 'hi');
  const kick = src.pushExternal('kick', web.messageId, 'amy', 'hi');
  assert.equal(d.admit(web).isNew, true);
  assert.equal(d.admit(kick).isNew, true);
  assert.equal(d.admit(src.pushExternal('kick', web.messageId, 'amy', 'hi')).isNew, false);
});
