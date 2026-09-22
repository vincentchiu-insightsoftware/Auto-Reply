/**
 * 模型輸出驗證。順序：schema → ID 對應 → speak 分支 → 內容規則。
 * speak=false 且欄位為空 → 合法安靜（不算失敗）。
 */
import { REASON_CODES, type RawDecision } from '../types.js';
import { splitSentences, countChars, normalize, FORBIDDEN_FORMAT, HUMAN_CLAIM } from '../util/text.js';

export type ValidationFail =
  | 'schema'
  | 'stale_observation'
  | 'unknown_chat_id'
  | 'invalid_silence'
  | 'empty'
  | 'sentence_count'
  | 'length'
  | 'format'
  | 'human_claim'
  | 'avoid_phrase'
  | 'duplicate';

export type Validation =
  | { ok: true; kind: 'silence'; decision: RawDecision }
  | { ok: true; kind: 'speak'; decision: RawDecision; utterance: string; short: boolean }
  | { ok: false; reason: ValidationFail; detail?: string };

export interface ValidatorOptions {
  observationId: string;
  allowedChatIds: string[];
  recentSpoken: string[];
  maxSentences: number;
  maxCharacters: number;
  targetMinCharacters: number;
  blockHumanClaims: boolean;
  avoidPhrases: string[];
}

export function parseDecision(raw: unknown): RawDecision | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.speak !== 'boolean') return null;
  if (typeof o.utterance !== 'string') return null;
  if (!Array.isArray(o.reply_to_ids) || !o.reply_to_ids.every((x) => typeof x === 'string')) return null;
  if (typeof o.observation_id !== 'string') return null;
  if (typeof o.reason_code !== 'string' || !(REASON_CODES as readonly string[]).includes(o.reason_code)) return null;
  const keys = Object.keys(o);
  if (keys.length !== 5) return null;
  return o as unknown as RawDecision;
}

export function validateDecision(raw: unknown, opts: ValidatorOptions): Validation {
  const d = parseDecision(raw);
  if (!d) return { ok: false, reason: 'schema' };
  if (d.observation_id !== opts.observationId) return { ok: false, reason: 'stale_observation' };
  for (const id of d.reply_to_ids) if (!opts.allowedChatIds.includes(id)) return { ok: false, reason: 'unknown_chat_id', detail: id };
  if (!d.speak) {
    if (d.utterance !== '' || d.reply_to_ids.length > 0) return { ok: false, reason: 'invalid_silence' };
    return { ok: true, kind: 'silence', decision: d };
  }
  const text = d.utterance.trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  const sentences = splitSentences(text);
  if (sentences.length < 1 || sentences.length > opts.maxSentences) return { ok: false, reason: 'sentence_count', detail: String(sentences.length) };
  const n = countChars(text);
  if (n > opts.maxCharacters) return { ok: false, reason: 'length', detail: String(n) };
  if (FORBIDDEN_FORMAT.test(text)) return { ok: false, reason: 'format' };
  if (opts.blockHumanClaims && HUMAN_CLAIM.test(text)) return { ok: false, reason: 'human_claim' };
  for (const p of opts.avoidPhrases) if (p && text.includes(p)) return { ok: false, reason: 'avoid_phrase', detail: p };
  const norm = normalize(text);
  if (opts.recentSpoken.some((s) => normalize(s) === norm)) return { ok: false, reason: 'duplicate' };
  return { ok: true, kind: 'speak', decision: d, utterance: text, short: n < opts.targetMinCharacters };
}
