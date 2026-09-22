/**
 * 共用型別。五個可替換介面：FrameSource、ChatSource、ModelProvider、TtsProvider、AudioPlayer。
 * 所有時間都是毫秒，來自注入的 Clock，不直接用 Date.now()。
 */

export interface SourceHealth {
  state: 'ok' | 'degraded' | 'offline';
  lastOkAt: number | null;
  consecutiveFailures: number;
  reason?: string;
}

/** mock 專用：合成畫面的「預期事實」。真實影片沒有這個欄位，模型只能看圖。 */
export interface MockFrameFacts {
  round: number;
  scoreA: number;
  scoreB: number;
  status: string;
  kind: 'normal' | 'black' | 'frozen' | 'round_change';
}

export interface Frame {
  frameRef: string;
  bytes: Buffer;
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  frameHash: string;
  capturedAt: number;
  /** 影片內的時間位置 */
  videoTimeMs: number;
  /** 影片段落版本（換局、換關）。來源能判定時提供；不能判定時維持不變。 */
  segment: number;
  /** 粗粒度內容簽章：來源能算時提供（例如分數/狀態變化），用來判定「有意義的畫面變化」；沒有就用 frameHash。 */
  eventKey?: string;
  mockFacts?: MockFrameFacts;
}

export interface ChatMessage {
  messageId: string;
  idStability: 'stable' | 'synthetic';
  source: string;
  text: string;
  author?: string;
  receivedAt: number;
  sourceTime?: number;
}

export interface FrameSource {
  readonly id: string;
  start(signal: AbortSignal): Promise<void>;
  /** 回傳「目前時間」對應的畫面；來源不可用時 throw SourceError。 */
  grab(signal: AbortSignal): Promise<Frame>;
  health(): SourceHealth;
  /** 影片是否已播完 */
  ended(): boolean;
  stop(): Promise<void>;
}

export interface ChatSource {
  readonly id: string;
  start(signal: AbortSignal): Promise<void>;
  /** 只回傳上次呼叫之後新出現的留言，最舊在前。 */
  poll(signal: AbortSignal): Promise<ChatMessage[]>;
  health(): SourceHealth;
  stop(): Promise<void>;
}

export interface Persona {
  id: string;
  version: string;
  language: string;
  name: string;
  personality: string[];
  speaking_style: string[];
  catchphrases: string[];
  avoid_phrases: string[];
  voice_id: string | null;
}

export interface PlanNote {
  fromVideoMs: number;
  toVideoMs: number;
  segment: number;
  notes: string[];
  avoid: string[];
}

export interface DecisionInput {
  observationId: string;
  contextVersion: number;
  currentTime: number;
  persona: Persona;
  referenceExcerpts: string[];
  planNotes: PlanNote[];
  frames: Frame[];
  untrustedChat: ChatMessage[];
  recentSpoken: string[];
  constraints: { maxSentences: number; maxCharacters: number; targetMinCharacters: number };
}

export const REASON_CODES = [
  'chat_reply',
  'game_event',
  'idle_comment',
  'no_new_information',
  'uncertain',
  'unsafe_input',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface RawDecision {
  speak: boolean;
  utterance: string;
  reply_to_ids: string[];
  observation_id: string;
  reason_code: ReasonCode;
}

export interface ProviderUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  imageTokens: number;
  ttsCharacters: number;
  /** 已知費率時為數字；未知為 'UNKNOWN'，不填 0 */
  usd: number | 'UNKNOWN';
}

export interface ModelResult {
  decision: unknown; // 尚未驗證，型別未知
  usage: { inputTokens: number; outputTokens: number; imageTokens: number };
}

export interface ModelProvider {
  readonly id: string;
  decide(input: DecisionInput, signal: AbortSignal): Promise<ModelResult>;
  usage(): ProviderUsage;
}

export interface TtsRequest {
  text: string;
  voiceId: string | null;
  rate?: number;
}

export interface TtsResult {
  audio: Buffer;
  mediaType: 'audio/wav' | 'audio/mpeg';
  durationMs: number;
}

export interface TtsProvider {
  readonly id: string;
  synthesize(req: TtsRequest, signal: AbortSignal): Promise<TtsResult>;
  usage(): ProviderUsage;
}

export interface PlaybackRecord {
  startedAt: number;
  endedAt: number;
  stopped: boolean;
}

export interface PlaybackHandle {
  startedAt: number;
  /** 播放結束（自然結束或被 stopNow 中止）時 resolve */
  done: Promise<PlaybackRecord>;
}

export interface AudioPlayer {
  open(deviceId: string | null): Promise<void>;
  /**
   * 同時只允許一個播放；重疊呼叫 reject OverlapError。
   * 回傳的 Promise 在「聲音真的開始播」時 resolve；開不了就 reject（DeviceError）。
   */
  play(audio: Buffer, mediaType: string, durationMs: number, signal: AbortSignal): Promise<PlaybackHandle>;
  /** 立即停止，不得成為阻塞其他取消的無限 await。 */
  stopNow(): Promise<void>;
  isPlaying(): boolean;
}

export interface Observation {
  observationId: string;
  sequence: number;
  capturedAt: number;
  receivedAt: number;
  frameRef: string | null;
  frameHash: string | null;
  videoTimeMs: number | null;
  chatIds: string[]; // dedup key: source:messageId
  sourceHealth: { frames: SourceHealth; chat: SourceHealth };
  sessionGeneration: number;
  contextVersion: number;
  trigger: 'chat' | 'game_event' | 'idle';
}

export type DirectorState =
  | 'STOPPED'
  | 'IDLE'
  | 'GENERATING'
  | 'SYNTHESIZING'
  | 'PLAYING'
  | 'PAUSED'
  | 'ERROR';

// ---- 錯誤 ----
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceError';
  }
}
export class ModelTimeoutError extends Error {
  constructor(message = 'model timeout') {
    super(message);
    this.name = 'ModelTimeoutError';
  }
}
export class RateLimitError extends Error {
  constructor(public retryAfterMs: number | null) {
    super('rate limited');
    this.name = 'RateLimitError';
  }
}
export class SpendLimitError extends Error {
  constructor(message = 'enforced_spend_limit_reached') {
    super(message);
    this.name = 'SpendLimitError';
  }
}
export class TtsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsError';
  }
}
export class DeviceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceError';
  }
}
export class OverlapError extends Error {
  constructor() {
    super('playback overlap');
    this.name = 'OverlapError';
  }
}
export class IllegalTransitionError extends Error {
  constructor(from: DirectorState, to: DirectorState) {
    super(`illegal transition ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
  }
}
export class AbortedError extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'AbortedError';
  }
}
