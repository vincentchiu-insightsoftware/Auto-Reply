import { readFileSync } from 'node:fs';

export interface RuntimeConfig {
  schema_version: string;
  mode: 'mock' | 'real';
  persona_path: string;
  reference_path: string | null;
  capture: { frame_interval_ms: number; chat_interval_ms: number; max_image_long_edge: number; max_images_per_request: number };
  director: {
    tick_ms: number;
    min_model_interval_ms: number;
    max_calls_per_minute: number;
    game_event_ttl_ms: number;
    chat_ttl_ms: number;
    recent_spoken_count: number;
    max_chat_messages: number;
    max_chat_characters: number;
    max_reference_characters: number;
    idle_comment_interval_ms: number;
  };
  model: { provider: string; model_id: string | null; timeout_ms: number; max_output_tokens: number; retries_per_event: number };
  tts: { provider: string; voice_id: string | null; timeout_ms: number; retries_per_event: number };
  speech: { min_sentences: number; max_sentences: number; max_characters: number; target_min_characters: number; max_input_message_characters: number };
  audio: { device_id: string | null; exclusive_player: boolean; emergency_stop_target_ms: number };
  budget: {
    billing_mode: 'unconfigured' | 'fake' | 'real';
    hourly_usd_limit: number | null;
    session_usd_limit: number | null;
    price_table_version: string | null;
    price_table: { input_per_mtok: number; output_per_mtok: number; tts_per_mchar: number } | null;
  };
  recovery: { consecutive_failures_before_pause: number; cooldown_ms: number; auto_reset_error_after_ms: number | null };
  identity: { skip_identity_questions: boolean; block_human_claims: boolean };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function req(obj: Record<string, unknown>, key: string, type: string, path: string): unknown {
  if (!(key in obj)) throw new ConfigError(`${path}.${key} missing`);
  const v = obj[key];
  if (type === 'number|null' ? !(typeof v === 'number' || v === null) : typeof v !== type)
    throw new ConfigError(`${path}.${key} must be ${type}`);
  return v;
}

/** 讀取並驗證設定。缺欄位、型別錯、付費模式沒有授權上限都要明確失敗。 */
export function validateConfig(raw: unknown): RuntimeConfig {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('config must be an object');
  const c = raw as Record<string, unknown>;
  const mode = req(c, 'mode', 'string', 'config');
  if (mode !== 'mock' && mode !== 'real') throw new ConfigError('config.mode must be mock|real');
  for (const section of ['capture', 'director', 'model', 'tts', 'speech', 'audio', 'budget', 'recovery', 'identity'])
    if (typeof c[section] !== 'object' || c[section] === null) throw new ConfigError(`config.${section} missing`);
  const cap = c.capture as Record<string, unknown>;
  for (const k of ['frame_interval_ms', 'chat_interval_ms', 'max_image_long_edge', 'max_images_per_request']) req(cap, k, 'number', 'capture');
  const d = c.director as Record<string, unknown>;
  for (const k of [
    'tick_ms', 'min_model_interval_ms', 'max_calls_per_minute', 'game_event_ttl_ms', 'chat_ttl_ms', 'recent_spoken_count',
    'max_chat_messages', 'max_chat_characters', 'max_reference_characters', 'idle_comment_interval_ms',
  ]) req(d, k, 'number', 'director');
  const m = c.model as Record<string, unknown>;
  req(m, 'provider', 'string', 'model');
  for (const k of ['timeout_ms', 'max_output_tokens', 'retries_per_event']) req(m, k, 'number', 'model');
  if ((m.retries_per_event as number) !== 0) throw new ConfigError('model.retries_per_event must be 0 (本事件不重試)');
  const t = c.tts as Record<string, unknown>;
  req(t, 'provider', 'string', 'tts');
  for (const k of ['timeout_ms', 'retries_per_event']) req(t, k, 'number', 'tts');
  const sp = c.speech as Record<string, unknown>;
  for (const k of ['min_sentences', 'max_sentences', 'max_characters', 'target_min_characters', 'max_input_message_characters']) req(sp, k, 'number', 'speech');
  const b = c.budget as Record<string, unknown>;
  const billing = req(b, 'billing_mode', 'string', 'budget');
  req(b, 'hourly_usd_limit', 'number|null', 'budget');
  req(b, 'session_usd_limit', 'number|null', 'budget');
  if (mode === 'real') {
    if (billing !== 'real') throw new ConfigError('mode=real requires budget.billing_mode=real');
    if (b.hourly_usd_limit === null || b.session_usd_limit === null || b.price_table_version === null || !b.price_table)
      throw new ConfigError('付費模式需要已授權的 hourly_usd_limit、session_usd_limit、price_table_version 與 price_table；null 不等於無上限');
  }
  if (billing === 'fake' && !b.price_table) throw new ConfigError('billing_mode=fake requires budget.price_table');
  const r = c.recovery as Record<string, unknown>;
  for (const k of ['consecutive_failures_before_pause', 'cooldown_ms']) req(r, k, 'number', 'recovery');
  req(r, 'auto_reset_error_after_ms', 'number|null', 'recovery');
  const idn = c.identity as Record<string, unknown>;
  req(idn, 'skip_identity_questions', 'boolean', 'identity');
  req(idn, 'block_human_claims', 'boolean', 'identity');
  if (typeof c.persona_path !== 'string') throw new ConfigError('config.persona_path missing');
  return raw as RuntimeConfig;
}

export function loadConfig(path: string): RuntimeConfig {
  const text = readFileSync(path, 'utf8');
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`config JSON parse error: ${(e as Error).message}`);
  }
  return validateConfig(raw);
}
