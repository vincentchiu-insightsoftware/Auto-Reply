/** 測試用的可腳本化 stub 與 harness（VirtualClock） */
import { readFileSync } from 'node:fs';
import { VirtualClock } from '../src/clock.js';
import { validateConfig, type RuntimeConfig } from '../src/config.js';
import { EventLog, type LogEvent } from '../src/log/events.js';
import { Director } from '../src/director/director.js';
import { OfflinePlayer } from '../src/audio/offline-player.js';
import {
  ModelTimeoutError, TtsError, type ChatMessage, type ChatSource, type DecisionInput, type Frame, type FrameSource, type ModelProvider, type ModelResult,
  type Persona, type ProviderUsage, type SourceHealth, type TtsProvider, type TtsRequest, type TtsResult, type RawDecision,
} from '../src/types.js';
import { silentWav } from '../src/providers/mock-tts.js';

export const PERSONA: Persona = {
  id: 'test', version: '0', language: 'zh-TW', name: '測', personality: ['親切'], speaking_style: ['短句'], catchphrases: [], avoid_phrases: ['根據截圖'], voice_id: null,
};

export function testConfig(overrides: Record<string, Record<string, unknown>> = {}): RuntimeConfig {
  const base = JSON.parse(readFileSync(new URL('../../config/runtime.example.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  for (const [k, v] of Object.entries(overrides)) base[k] = { ...(base[k] as Record<string, unknown>), ...v };
  return validateConfig(base);
}

export class StubFrameSource implements FrameSource {
  readonly id = 'stub-frames';
  segment = 1;
  eventKey = 'k0';
  usable = true;
  isEnded = false;
  grabs = 0;
  constructor(private clock: VirtualClock) {}
  async start(): Promise<void> {}
  async grab(): Promise<Frame> {
    this.grabs++;
    return {
      frameRef: `f${this.grabs}`, bytes: Buffer.alloc(16), mediaType: 'image/png', width: 960, height: 540, frameHash: `${this.eventKey}:${this.grabs}`,
      capturedAt: this.clock.now(), videoTimeMs: this.clock.now(), segment: this.segment, eventKey: this.eventKey,
    };
  }
  health(): SourceHealth {
    return this.usable ? { state: 'ok', lastOkAt: this.clock.now(), consecutiveFailures: 0 } : { state: 'degraded', lastOkAt: null, consecutiveFailures: 1, reason: 'black' };
  }
  ended(): boolean {
    return this.isEnded;
  }
  async stop(): Promise<void> {}
}

export class StubChatSource implements ChatSource {
  readonly id = 'stub-chat';
  private queue: { at: number; msg: Omit<ChatMessage, 'receivedAt'> }[] = [];
  private seq = 0;
  constructor(private clock: VirtualClock) {}
  /** 在場景時間 at 送出一則留言 */
  say(at: number, text: string, opts: { id?: string; source?: string; author?: string } = {}): string {
    const id = opts.id ?? `c${++this.seq}`;
    this.queue.push({ at, msg: { messageId: id, idStability: 'stable', source: opts.source ?? 's1', text, author: opts.author ?? 'v' } });
    return `${opts.source ?? 's1'}:${id}`;
  }
  async start(): Promise<void> {}
  async poll(): Promise<ChatMessage[]> {
    const now = this.clock.now();
    const due = this.queue.filter((q) => q.at <= now);
    this.queue = this.queue.filter((q) => q.at > now);
    return due.map((q) => ({ ...q.msg, receivedAt: now }));
  }
  health(): SourceHealth {
    return { state: 'ok', lastOkAt: this.clock.now(), consecutiveFailures: 0 };
  }
  async stop(): Promise<void> {}
}

export type Behavior =
  | { kind: 'reply'; text?: string; latency?: number; replyAll?: boolean }
  | { kind: 'silence'; latency?: number }
  | { kind: 'timeout' }
  | { kind: 'late'; latency: number; text?: string }
  | { kind: 'throw'; err: Error; latency?: number }
  | { kind: 'raw'; decision: unknown; latency?: number };

export class ScriptedModel implements ModelProvider {
  readonly id = 'scripted-model';
  script: Behavior[] = [];
  inflight = 0;
  maxInflight = 0;
  calls = 0;
  inputs: DecisionInput[] = [];
  defaultLatency = 1000;
  constructor(private clock: VirtualClock) {}
  usage(): ProviderUsage {
    return { calls: this.calls, inputTokens: 0, outputTokens: 0, imageTokens: 0, ttsCharacters: 0, usd: 'UNKNOWN' };
  }
  private mk(input: DecisionInput, text: string | undefined, replyAll: boolean): RawDecision {
    const chats = replyAll ? input.untrustedChat : input.untrustedChat.slice(-1);
    const utt = text ?? (chats.length > 0 ? `回覆${chats[chats.length - 1]!.text}，這波有戲。` : '這局節奏不錯，先看下一步。');
    return { speak: true, utterance: utt, reply_to_ids: chats.map((c) => c.messageId), observation_id: input.observationId, reason_code: chats.length ? 'chat_reply' : 'game_event' };
  }
  async decide(input: DecisionInput, signal: AbortSignal): Promise<ModelResult> {
    this.calls++;
    this.inputs.push(input);
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    const b: Behavior = this.script.shift() ?? { kind: 'reply' };
    const usage = { inputTokens: 1000, outputTokens: 50, imageTokens: input.frames.length * 700 };
    try {
      switch (b.kind) {
        case 'timeout':
          await this.clock.sleep(10 * 60_000, signal);
          throw new ModelTimeoutError();
        case 'late':
          await this.clock.sleep(b.latency); // 故意不理 abort
          return { decision: this.mk(input, b.text, false), usage };
        case 'throw':
          await this.clock.sleep(b.latency ?? this.defaultLatency, signal);
          throw b.err;
        case 'raw':
          await this.clock.sleep(b.latency ?? this.defaultLatency, signal);
          return { decision: b.decision, usage };
        case 'silence':
          await this.clock.sleep(b.latency ?? this.defaultLatency, signal);
          return { decision: { speak: false, utterance: '', reply_to_ids: [], observation_id: input.observationId, reason_code: 'no_new_information' }, usage };
        case 'reply':
        default:
          await this.clock.sleep(b.latency ?? this.defaultLatency, signal);
          return { decision: this.mk(input, b.text, b.replyAll ?? false), usage };
      }
    } finally {
      this.inflight--;
    }
  }
}

export class ScriptedTts implements TtsProvider {
  readonly id = 'scripted-tts';
  failNext = 0;
  calls = 0;
  latency = 400;
  constructor(private clock: VirtualClock) {}
  usage(): ProviderUsage {
    return { calls: this.calls, inputTokens: 0, outputTokens: 0, imageTokens: 0, ttsCharacters: 0, usd: 'UNKNOWN' };
  }
  async synthesize(req: TtsRequest, signal: AbortSignal): Promise<TtsResult> {
    this.calls++;
    await this.clock.sleep(this.latency, signal);
    if (this.failNext > 0) {
      this.failNext--;
      throw new TtsError('scripted failure');
    }
    return { audio: silentWav(100), mediaType: 'audio/wav', durationMs: Math.max(700, req.text.length * 200) };
  }
}

export class Harness {
  clock = new VirtualClock(0);
  log = new EventLog(this.clock, null);
  frames = new StubFrameSource(this.clock);
  chat = new StubChatSource(this.clock);
  model = new ScriptedModel(this.clock);
  tts = new ScriptedTts(this.clock);
  player: OfflinePlayer;
  director: Director;
  config: RuntimeConfig;
  constructor(overrides: Record<string, Record<string, unknown>> = {}) {
    this.config = testConfig(overrides);
    this.player = new OfflinePlayer(this.clock, null);
    this.director = new Director({
      clock: this.clock, config: this.config, persona: PERSONA, reference: ['規則：分數高者勝'], planNotes: [],
      frames: this.frames, chat: this.chat, model: this.model, tts: this.tts, player: this.player, log: this.log,
    });
  }
  async start(): Promise<void> {
    await this.director.start();
  }
  /** 推進 ms 場景時間，每 tick 呼叫 director.tick() */
  async run(ms: number): Promise<void> {
    const tick = this.config.director.tick_ms;
    const end = this.clock.now() + ms;
    while (this.clock.now() < end) {
      await this.director.tick();
      await this.clock.advance(tick);
    }
  }
  events(type?: string): LogEvent[] {
    return type ? this.log.events().filter((e) => e.type === type) : this.log.events();
  }
  drops(reason?: string): LogEvent[] {
    return this.events('drop').filter((e) => (reason ? (e.reason as string).startsWith(reason) : true));
  }
  played(): LogEvent[] {
    return this.events('playback_start');
  }
}
