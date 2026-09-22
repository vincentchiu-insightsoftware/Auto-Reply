/**
 * 留言的本機粗篩。只做樣式判斷，語意判斷留給模型。
 * 結果：eligible（可回答）、skipped_identity、unsafe_input_local、invalid_input
 */
import type { ChatMessage } from '../types.js';
import { IDENTITY_QUESTION, INJECTION, countChars } from '../util/text.js';

export type ChatClass = 'eligible' | 'skipped_identity' | 'unsafe_input_local' | 'invalid_input';

export function classifyChat(m: ChatMessage, opts: { maxChars: number; skipIdentity: boolean }): ChatClass {
  const text = m.text.trim();
  if (text.length === 0) return 'invalid_input';
  if (countChars(text) > opts.maxChars) return 'invalid_input';
  if (INJECTION.test(text)) return 'unsafe_input_local';
  if (opts.skipIdentity && IDENTITY_QUESTION.test(text)) return 'skipped_identity';
  return 'eligible';
}
