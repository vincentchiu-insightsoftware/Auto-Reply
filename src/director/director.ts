/**
 * Director：串行的「採集 → 候選槽 → 生成 → 驗證 → 合成 → 播放」。
 * - 候選槽最多一筆；同時最多一個生成、一個播放；採集持續進行。
 * - sessionGeneration + jobId 防護所有非同步完成；contextVersion 讓換局後舊內容失效。
 * - 所有失敗都不重試本事件。
 */
import type { Clock } from '../clock.js';
import type { RuntimeConfig } from '../config.js';
import type { EventLog } from '../log/events.js';
import {
  AbortedError, DeviceError, ModelTimeoutError, OverlapError, RateLimitError, SourceError, SpendLimitError, TtsError,
  type AudioPlayer, type ChatMessage, type ChatSource, type DecisionInput, type DirectorState, type Frame, type FrameSource,
  type ModelProvider, type Observation, type Persona, type PlanNote, type TtsProvider,
} from '../types.js';
import { Deduper } from '../context/dedup.js';
import { ShortTermMemory } from '../context/memory.js';
import { classifyChat } from './classify.js';
import { validateDecision } from './validator.js';
import { Budget, type Reservation } from './budget.js';
import { StateMachine } from './state.js';
import { countChars } from '../util/text.js';

export interface DirectorDeps {
  clock: Clock;
  config: RuntimeConfig;
  persona: Persona;
  reference: string[];
  planNotes: PlanNote[];
  frames: FrameSource;
  chat: ChatSource;
  model: ModelProvider;
  tts: TtsProvider;
  player: AudioPlayer;
  log: EventLog;
}

interface PendingChat {
  key: string;
  msg: ChatMessage;
}

interface Candidate {
  trigger: 'chat' | 'game_event' | 'idle';
  chats: PendingChat[];
  frame: Frame | null;
  contextVersion: number;
  createdAt: number;
  eventAt: number;
}

interface Job {
  id: number;
  generation: number;
  contextVersion: number;
  observationId: string;
  trigger: Candidate['trigger'];
  chats: PendingChat[];
  frame: Frame | null;
  reservation: Reservation | null;
  t: { event: number; modelSent: number; modelRecv?: number; audioReady?: number; playStart?: number; playEnd?: number };
}

export class Director {
  readonly sm: StateMachine;
  sessionGeneration = 0;
  contextVersion = 0;
  private activeJob: Job | null = null;
  private abortCtl: AbortController | null = null;
  private slot: Candidate | null = null;
  private pending: PendingChat[] = [];
  readonly deduper = new Deduper();
  private memory: ShortTermMemory;
  private budget: Budget | null;
  private lastFrameEventKey: string | null = null;
  private lastSegment: number | null = null;
  private lastFrameGrabAt = -Infinity;
  private lastChatPollAt = -Infinity;
  private lastModelCallAt = -Infinity;
  private callTimes: number[] = [];
  private cooldownUntil = 0;
  private consecutiveFailures = 0;
  private paidDisabled = false;
  private lastSpeechEndAt = 0;
  private lastIdleAt = -Infinity;
  private errorSince: number | null = null;
  private sequence = 0;
  private jobSeq = 0;
  private lastFrameHealth: string | null = null;
  private lastChatHealth: string | null = null;
  private throttleLogged = false;
  private sourceCtl = new AbortController();
  cancelledJobs = 0;

  constructor(private d: DirectorDeps) {
    this.sm = new StateMachine((from, to) => this.d.log.emit('state', { from, to, generation: this.sessionGeneration }));
    this.memory = new ShortTermMemory(d.config.director.recent_spoken_count);
    const b = d.config.budget;
    this.budget = b.billing_mode === 'unconfigured' ? null : new Budget(b.price_table, b.hourly_usd_limit, b.session_usd_limit, () => d.clock.now());
  }

  get state(): DirectorState {
    return this.sm.state;
  }
  get now(): number {
    return this.d.clock.now();
  }

  // ---------- 生命週期 ----------
  async start(): Promise<void> {
    await this.d.frames.start(this.sourceCtl.signal);
    await this.d.chat.start(this.sourceCtl.signal);
    await this.d.player.open(this.d.config.audio.device_id);
    this.lastSpeechEndAt = this.now;
    this.sm.transition('IDLE');
    this.d.log.emit('started', { mode: this.d.config.mode, persona: this.d.persona.id, model: this.d.model.id, tts: this.d.tts.id });
  }

  /** 暫停：遞增 generation、中止進行中的工作、停聲音、清槽。晚到結果一律丟棄。 */
  pause(reason = 'manual'): void {
    if (!this.sm.can('PAUSED')) return;
    this.invalidateInflight();
    void this.d.player.stopNow();
    this.sm.transition('PAUSED');
    this.d.log.emit('paused', { reason, generation: this.sessionGeneration });
  }

  /** 急停：同 pause，另記錄實際靜音時間。 */
  async emergencyStop(): Promise<{ silenceMs: number; cancelledJobs: number }> {
    const t0 = this.now;
    const wasPlaying = this.d.player.isPlaying();
    const cancelled = this.activeJob ? 1 : 0;
    this.invalidateInflight();
    // stopNow 不得阻塞：以急停目標時間為上限等待
    await Promise.race([this.d.player.stopNow(), this.d.clock.sleep(this.d.config.audio.emergency_stop_target_ms)]);
    const silenceMs = this.d.player.isPlaying() ? Number.POSITIVE_INFINITY : this.now - t0;
    if (this.sm.can('PAUSED')) this.sm.transition('PAUSED');
    this.d.log.emit('emergency_stop', { silenceMs, wasPlaying, cancelledJobs: cancelled, generation: this.sessionGeneration });
    return { silenceMs, cancelledJobs: cancelled };
  }

  /** 恢復：從現在起收，不處理暫停期間的留言，不受舊工作污染。 */
  async resume(): Promise<void> {
    if (this.sm.state !== 'PAUSED' && this.sm.state !== 'ERROR') return;
    const backlog = await this.safePoll();
    if (backlog.length > 0) this.d.log.emit('drop', { reason: 'resume_backlog', count: backlog.length });
    this.pending = [];
    this.slot = null;
    this.throttleLogged = false;
    this.lastSpeechEndAt = this.now;
    this.sm.transition('IDLE');
    this.d.log.emit('resumed', { generation: this.sessionGeneration });
  }

  async stop(reason = 'manual'): Promise<void> {
    if (this.sm.state === 'STOPPED') return;
    this.invalidateInflight();
    await Promise.race([this.d.player.stopNow(), this.d.clock.sleep(this.d.config.audio.emergency_stop_target_ms)]);
    this.sourceCtl.abort();
    await this.d.frames.stop();
    await this.d.chat.stop();
    this.sm.transition('STOPPED');
    this.d.log.emit('stopped', { reason, generation: this.sessionGeneration, model_usage: this.d.model.usage(), tts_usage: this.d.tts.usage(), budget: this.budget?.snapshot() ?? null, dedup: this.deduper.stats() });
  }

  private invalidateInflight(): void {
    this.sessionGeneration++;
    if (this.activeJob) this.cancelledJobs++;
    this.abortCtl?.abort();
    this.abortCtl = null;
    this.activeJob = null;
    this.slot = null;
  }

  status(): Record<string, unknown> {
    return {
      state: this.sm.state,
      generation: this.sessionGeneration,
      contextVersion: this.contextVersion,
      pending: this.pending.length,
      slot: this.slot ? { trigger: this.slot.trigger, chats: this.slot.chats.length } : null,
      activeJob: this.activeJob ? { id: this.activeJob.id, observationId: this.activeJob.observationId } : null,
      paidDisabled: this.paidDisabled,
      cooldownUntil: this.cooldownUntil,
      budget: this.budget?.snapshot() ?? null,
      model: this.d.model.usage(),
      tts: this.d.tts.usage(),
    };
  }

  // ---------- 主循環 ----------
  async tick(): Promise<void> {
    const s = this.sm.state;
    if (s === 'STOPPED') return;
    if (s === 'ERROR') {
      await this.tryRecover();
      return;
    }
    if (s === 'PAUSED') return;

    await this.pollChat();
    await this.grabFrame();
    if (this.sm.state === 'STOPPED') return;
    this.expire();
    this.updateSlot();
    if (this.sm.state === 'IDLE' && this.slot) this.maybeStart();
  }

  private async tryRecover(): Promise<void> {
    const after = this.d.config.recovery.auto_reset_error_after_ms;
    if (after === null || this.errorSince === null || this.now - this.errorSince < after) return;
    try {
      await this.d.player.open(this.d.config.audio.device_id);
      this.invalidateInflight();
      this.pending = [];
      this.errorSince = null;
      this.sm.transition('IDLE');
      this.lastSpeechEndAt = this.now;
      this.d.log.emit('error_reset', { generation: this.sessionGeneration });
    } catch (e) {
      this.errorSince = this.now;
      this.d.log.emit('error_reset_failed', { error: (e as Error).message });
    }
  }

  private async safePoll(): Promise<ChatMessage[]> {
    try {
      return await this.d.chat.poll(this.sourceCtl.signal);
    } catch (e) {
      this.d.log.emit('chat_source_error', { error: (e as Error).message });
      return [];
    }
  }

  private async pollChat(): Promise<void> {
    if (this.now - this.lastChatPollAt < this.d.config.capture.chat_interval_ms) return;
    this.lastChatPollAt = this.now;
    const msgs = await this.safePoll();
    const h = this.d.chat.health();
    if (h.state !== this.lastChatHealth) {
      this.d.log.emit('source_health', { source: 'chat', ...h });
      this.lastChatHealth = h.state;
    }
    for (const m of msgs) {
      const { key, isNew } = this.deduper.admit(m);
      if (!isNew) {
        this.d.log.emit('drop', { reason: 'resend_duplicate', key });
        continue;
      }
      const cls = classifyChat(m, { maxChars: this.d.config.speech.max_input_message_characters, skipIdentity: this.d.config.identity.skip_identity_questions });
      this.d.log.emit('chat_received', { key, source: m.source, messageId: m.messageId, author: m.author ?? null, chars: countChars(m.text), class: cls, receivedAt: m.receivedAt });
      if (cls === 'eligible') this.pending.push({ key, msg: m });
      else this.d.log.emit('drop', { reason: cls, key });
    }
    if (this.pending.length > this.d.config.director.max_chat_messages) {
      const dropped = this.pending.splice(0, this.pending.length - this.d.config.director.max_chat_messages);
      for (const p of dropped) this.d.log.emit('drop', { reason: 'pending_overflow', key: p.key });
    }
  }

  private async grabFrame(): Promise<void> {
    if (this.now - this.lastFrameGrabAt < this.d.config.capture.frame_interval_ms) return;
    this.lastFrameGrabAt = this.now;
    if (this.d.frames.ended()) {
      this.d.log.emit('video_ended', {});
      await this.stop('video_ended');
      return;
    }
    let frame: Frame;
    try {
      frame = await this.d.frames.grab(this.sourceCtl.signal);
    } catch (e) {
      if (e instanceof SourceError) this.d.log.emit('frame_source_error', { error: e.message });
      else throw e;
      this.reportFrameHealth();
      return;
    }
    this.reportFrameHealth();
    // 換局：contextVersion 遞增，舊觀測與候選失效
    if (this.lastSegment !== null && frame.segment !== this.lastSegment) {
      this.contextVersion++;
      this.d.log.emit('context_change', { from: this.lastSegment, to: frame.segment, contextVersion: this.contextVersion });
      if (this.slot && this.slot.contextVersion !== this.contextVersion) {
        this.d.log.emit('drop', { reason: 'context_changed', stage: 'slot', trigger: this.slot.trigger });
        this.slot = null;
      }
      this.memory.clearFrame();
      this.lastFrameEventKey = null;
    }
    this.lastSegment = frame.segment;
    const usable = this.d.frames.health().state === 'ok';
    if (!usable) return; // 黑畫面等：不更新有效畫面，不觸發畫面事件
    this.memory.setFrame(frame, this.now);
    const key = frame.eventKey ?? frame.frameHash;
    if (this.lastFrameEventKey !== null && key !== this.lastFrameEventKey) {
      this.pendingGameEvent = frame;
      this.d.log.emit('game_event', { frameRef: frame.frameRef, videoTimeMs: frame.videoTimeMs, segment: frame.segment });
    }
    this.lastFrameEventKey = key;
  }
  private pendingGameEvent: Frame | null = null;

  private reportFrameHealth(): void {
    const h = this.d.frames.health();
    if (h.state !== this.lastFrameHealth) {
      this.d.log.emit('source_health', { source: 'frames', ...h });
      this.lastFrameHealth = h.state;
    }
  }

  private expire(): void {
    const ttl = this.d.config.director.chat_ttl_ms;
    const keep: PendingChat[] = [];
    for (const p of this.pending) {
      if (this.now - p.msg.receivedAt > ttl) this.d.log.emit('drop', { reason: 'chat_expired', key: p.key, stage: 'pending' });
      else keep.push(p);
    }
    this.pending = keep;
    if (this.pendingGameEvent && this.now - this.pendingGameEvent.capturedAt > this.d.config.director.game_event_ttl_ms) {
      this.d.log.emit('drop', { reason: 'game_event_expired', frameRef: this.pendingGameEvent.frameRef });
      this.pendingGameEvent = null;
    }
    if (this.slot) {
      const ttlSlot = this.slot.trigger === 'chat' ? ttl : this.d.config.director.game_event_ttl_ms;
      if (this.now - this.slot.eventAt > ttlSlot) {
        this.d.log.emit('drop', { reason: 'slot_expired', trigger: this.slot.trigger, chats: this.slot.chats.map((c) => c.key) });
        this.slot = null;
      }
    }
  }

  private currentFrame(): Frame | null {
    const f = this.memory.lastValidFrame;
    if (!f || this.memory.lastValidFrameAt === null) return null;
    if (this.now - this.memory.lastValidFrameAt > this.d.config.director.game_event_ttl_ms) return null;
    return f;
  }

  /** 候選槽：最多一筆，優先 留言 > 畫面事件 > 空檔；新事件替換舊的。 */
  private updateSlot(): void {
    const frame = this.currentFrame();
    if (this.pending.length > 0) {
      const chats = this.pending.slice(-this.d.config.director.max_chat_messages);
      this.slot = { trigger: 'chat', chats, frame, contextVersion: this.contextVersion, createdAt: this.now, eventAt: Math.min(...chats.map((c) => c.msg.receivedAt)) };
      return;
    }
    if (this.pendingGameEvent && frame) {
      if (!this.slot || this.slot.trigger !== 'chat') {
        this.slot = { trigger: 'game_event', chats: [], frame, contextVersion: this.contextVersion, createdAt: this.now, eventAt: this.pendingGameEvent.capturedAt };
      }
      this.pendingGameEvent = null;
      return;
    }
    if (!this.slot && frame && this.sm.state === 'IDLE') {
      const iv = this.d.config.director.idle_comment_interval_ms;
      if (this.now - this.lastSpeechEndAt >= iv && this.now - this.lastIdleAt >= iv) {
        this.lastIdleAt = this.now;
        this.slot = { trigger: 'idle', chats: [], frame, contextVersion: this.contextVersion, createdAt: this.now, eventAt: this.now };
      }
    }
  }

  private maybeStart(): void {
    const slot = this.slot!;
    if (this.paidDisabled) {
      this.d.log.emit('drop', { reason: 'paid_disabled', trigger: slot.trigger, chats: slot.chats.map((c) => c.key) });
      this.consumeSlot();
      return;
    }
    const cfg = this.d.config.director;
    if (this.now < this.cooldownUntil) return this.throttle('cooldown');
    if (this.now - this.lastModelCallAt < cfg.min_model_interval_ms) return this.throttle('min_interval');
    this.callTimes = this.callTimes.filter((t) => this.now - t < 60_000);
    if (this.callTimes.length >= cfg.max_calls_per_minute) return this.throttle('rate_capped');
    this.throttleLogged = false;
    this.slot = null;
    void this.runJob(slot);
  }

  private throttle(why: string): void {
    if (!this.throttleLogged) {
      this.d.log.emit('throttle', { why, trigger: this.slot?.trigger ?? null });
      this.throttleLogged = true;
    }
  }

  /** 把槽內留言標記為已選取並移出 pending（不論後續成功與否，本事件不重試） */
  private consumeSlot(): void {
    const slot = this.slot;
    this.slot = null;
    if (!slot) return;
    const keys = new Set(slot.chats.map((c) => c.key));
    this.pending = this.pending.filter((p) => !keys.has(p.key));
    this.deduper.markSelected([...keys]);
  }

  // ---------- 工作 ----------
  private guard(job: Job): boolean {
    return job.generation === this.sessionGeneration && this.activeJob?.id === job.id;
  }
  private finish(job: Job): void {
    if (this.activeJob?.id === job.id) {
      this.activeJob = null;
      this.abortCtl = null;
    }
  }
  private async withTimeout<T>(p: Promise<T>, ms: number, ctl: AbortController, make: () => Error): Promise<T> {
    p.catch(() => {}); // 避免 race 之後的 rejection 變成 unhandled
    let timer: number | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = this.d.clock.setTimeout(() => {
        ctl.abort();
        reject(make());
      }, ms);
    });
    try {
      return await Promise.race([p, timeout]);
    } finally {
      if (timer !== null) this.d.clock.clearTimeout(timer);
    }
  }

  private async runJob(cand: Candidate): Promise<void> {
    const cfg = this.d.config;
    const keys = new Set(cand.chats.map((c) => c.key));
    this.pending = this.pending.filter((p) => !keys.has(p.key));
    this.deduper.markSelected([...keys]);

    if (cand.contextVersion !== this.contextVersion) {
      this.d.log.emit('drop', { reason: 'context_changed', stage: 'pre_model', trigger: cand.trigger, chats: [...keys] });
      return;
    }
    // TTL 關卡一：送模型前
    const chats = cand.chats.filter((c) => this.now - c.msg.receivedAt <= cfg.director.chat_ttl_ms);
    const frame = cand.frame && this.now - cand.frame.capturedAt <= cfg.director.game_event_ttl_ms ? cand.frame : null;
    if (chats.length === 0 && cand.trigger === 'chat') {
      this.d.log.emit('drop', { reason: 'chat_expired', stage: 'pre_model', chats: [...keys] });
      return;
    }
    if (!frame && cand.trigger !== 'chat') {
      this.d.log.emit('drop', { reason: 'game_event_expired', stage: 'pre_model' });
      return;
    }
    const observation: Observation = {
      observationId: `obs_${++this.sequence}_${this.sessionGeneration}`,
      sequence: this.sequence,
      capturedAt: frame?.capturedAt ?? this.now,
      receivedAt: this.now,
      frameRef: frame?.frameRef ?? null,
      frameHash: frame?.frameHash ?? null,
      videoTimeMs: frame?.videoTimeMs ?? null,
      chatIds: chats.map((c) => c.key),
      sourceHealth: { frames: this.d.frames.health(), chat: this.d.chat.health() },
      sessionGeneration: this.sessionGeneration,
      contextVersion: this.contextVersion,
      trigger: cand.trigger,
    };
    const input: DecisionInput = {
      observationId: observation.observationId,
      contextVersion: this.contextVersion,
      currentTime: this.now,
      persona: this.d.persona,
      referenceExcerpts: this.d.reference,
      planNotes: this.d.planNotes.filter((n) => frame && frame.videoTimeMs >= n.fromVideoMs && frame.videoTimeMs < n.toVideoMs),
      frames: frame ? [frame] : [],
      untrustedChat: chats.map((c) => c.msg),
      recentSpoken: this.memory.recentSpoken(),
      constraints: { maxSentences: cfg.speech.max_sentences, maxCharacters: cfg.speech.max_characters, targetMinCharacters: cfg.speech.target_min_characters },
    };
    // 預算：先預留
    let reservation: Reservation | null = null;
    if (this.budget) {
      let textTokens = 600 + JSON.stringify(this.d.persona).length / 2;
      for (const r of this.d.reference) textTokens += r.length / 1.5;
      for (const c of chats) textTokens += c.msg.text.length / 1.2 + 12;
      const img = frame ? this.budget.imageTokens(frame.width, frame.height) : 0;
      const est = this.budget.estimateModelUsd(Math.round(textTokens), img, cfg.model.max_output_tokens) + this.budget.ttsUsd(cfg.speech.max_characters);
      reservation = this.budget.reserve(est);
      if (!reservation) {
        this.paidDisabled = true;
        this.d.log.emit('drop', { reason: 'budget_stop', estimateUsd: est, budget: this.budget.snapshot(), chats: observation.chatIds });
        this.d.log.emit('paid_disabled', { why: 'budget_stop' });
        return;
      }
    }
    const job: Job = {
      id: ++this.jobSeq,
      generation: this.sessionGeneration,
      contextVersion: this.contextVersion,
      observationId: observation.observationId,
      trigger: cand.trigger,
      chats,
      frame,
      reservation,
      t: { event: cand.eventAt, modelSent: this.now },
    };
    this.activeJob = job;
    const ctl = new AbortController();
    this.abortCtl = ctl;
    this.sm.transition('GENERATING');
    this.lastModelCallAt = this.now;
    this.callTimes.push(this.now);
    this.d.log.emit('observation', { ...observation, jobId: job.id, frameRef: observation.frameRef, reservationUsd: reservation?.usd ?? null });

    // ---- 模型 ----
    let result;
    try {
      result = await this.withTimeout(this.d.model.decide(input, ctl.signal), cfg.model.timeout_ms, ctl, () => new ModelTimeoutError());
    } catch (e) {
      if (!this.guard(job)) {
        this.settle(job, null);
        this.d.log.emit('drop', { reason: 'late_result_discarded', stage: 'model_error', jobId: job.id, error: (e as Error).name });
        return;
      }
      this.settle(job, null);
      this.onProviderError(e as Error, job, 'model');
      return;
    }
    if (!this.guard(job)) {
      this.settle(job, this.actualUsd(result.usage));
      this.d.log.emit('drop', { reason: 'late_result_discarded', stage: 'model_result', jobId: job.id });
      return;
    }
    job.t.modelRecv = this.now;
    const modelUsd = this.actualUsd(result.usage);
    this.consecutiveFailures = 0;
    this.d.log.emit('model_result', { jobId: job.id, observationId: job.observationId, latencyMs: job.t.modelRecv - job.t.modelSent, usage: result.usage });

    const v = validateDecision(result.decision, {
      observationId: job.observationId,
      allowedChatIds: chats.map((c) => c.msg.messageId),
      recentSpoken: this.memory.recentSpoken(),
      maxSentences: cfg.speech.max_sentences,
      maxCharacters: cfg.speech.max_characters,
      targetMinCharacters: cfg.speech.target_min_characters,
      blockHumanClaims: cfg.identity.block_human_claims,
      avoidPhrases: this.d.persona.avoid_phrases,
    });
    if (!v.ok) {
      this.settle(job, modelUsd);
      this.d.log.emit('drop', { reason: `decision_rejected:${v.reason}`, jobId: job.id, detail: v.detail ?? null, chats: observation.chatIds });
      this.sm.transition('IDLE');
      this.finish(job);
      return;
    }
    if (v.kind === 'silence') {
      this.settle(job, modelUsd);
      this.d.log.emit('silence', { jobId: job.id, reason_code: v.decision.reason_code, chats: observation.chatIds });
      this.sm.transition('IDLE');
      this.finish(job);
      return;
    }
    // 結算：模型實際用量 + 這句 TTS 字數（TTS 之後失敗也不退費，保守計）
    this.settle(job, modelUsd === null ? null : modelUsd + (this.budget ? this.budget.ttsUsd(countChars(v.utterance)) : 0));
    // TTL / context 關卡二：送 TTS 前
    if (!this.stillValid(job, 'pre_tts')) return;
    this.sm.transition('SYNTHESIZING');
    let audio;
    try {
      audio = await this.withTimeout(
        this.d.tts.synthesize({ text: v.utterance, voiceId: this.d.persona.voice_id, rate: 1 }, ctl.signal),
        cfg.tts.timeout_ms, ctl, () => new TtsError('tts timeout'),
      );
    } catch (e) {
      if (!this.guard(job)) {
        this.d.log.emit('drop', { reason: 'late_result_discarded', stage: 'tts_error', jobId: job.id });
        return;
      }
      this.onProviderError(e as Error, job, 'tts');
      return;
    }
    if (!this.guard(job)) {
      this.d.log.emit('drop', { reason: 'late_result_discarded', stage: 'tts_result', jobId: job.id });
      return;
    }
    job.t.audioReady = this.now;
    // 關卡三：播放前
    if (!this.stillValid(job, 'pre_play')) return;
    this.sm.transition('PLAYING');
    let handle;
    try {
      handle = await this.d.player.play(audio.audio, audio.mediaType, audio.durationMs, ctl.signal);
    } catch (e) {
      if (!this.guard(job)) {
        this.d.log.emit('drop', { reason: 'late_result_discarded', stage: 'play_start_error', jobId: job.id });
        return;
      }
      this.onPlayerError(e as Error, job);
      return;
    }
    if (!this.guard(job)) {
      void this.d.player.stopNow();
      this.d.log.emit('drop', { reason: 'late_result_discarded', stage: 'play_started_after_cancel', jobId: job.id });
      return;
    }
    // 聲音真的開始了：此刻才記 spoken 與 playback_start
    const replyKeys = v.decision.reply_to_ids.map((id) => chats.find((c) => c.msg.messageId === id)?.key ?? id);
    const dup = this.deduper.markSpoken(replyKeys);
    if (dup.length > 0) this.d.log.emit('duplicate_playback', { keys: dup, jobId: job.id });
    this.memory.pushSpoken(v.utterance);
    job.t.playStart = handle.startedAt;
    this.d.log.emit('playback_start', {
      jobId: job.id, observationId: job.observationId, trigger: job.trigger, reason_code: v.decision.reason_code, utterance: v.utterance,
      chars: countChars(v.utterance), short: v.short, reply_keys: replyKeys, durationMs: audio.durationMs,
      t_event: job.t.event, t_model_sent: job.t.modelSent, t_model_recv: job.t.modelRecv, t_audio_ready: job.t.audioReady, t_play_start: job.t.playStart,
      contextVersion: job.contextVersion, generation: job.generation,
    });
    const rec = await handle.done;
    if (!this.guard(job)) {
      this.d.log.emit('playback_end', { jobId: job.id, stopped: true, late: true, endedAt: rec.endedAt });
      return;
    }
    job.t.playEnd = this.now;
    this.lastSpeechEndAt = this.now;
    this.d.log.emit('playback_end', { jobId: job.id, stopped: rec.stopped, startedAt: rec.startedAt, endedAt: rec.endedAt, t_play_end: job.t.playEnd });
    if (this.sm.state === 'PLAYING') this.sm.transition('IDLE');
    this.finish(job);
  }

  private stillValid(job: Job, stage: string): boolean {
    const cfg = this.d.config.director;
    if (job.contextVersion !== this.contextVersion) {
      this.d.log.emit('drop', { reason: 'context_changed', stage, jobId: job.id, chats: job.chats.map((c) => c.key) });
      this.sm.transition('IDLE');
      this.finish(job);
      return false;
    }
    const alive = job.trigger === 'chat' ? job.chats.some((c) => this.now - c.msg.receivedAt <= cfg.chat_ttl_ms) : job.frame !== null && this.now - job.frame.capturedAt <= cfg.game_event_ttl_ms;
    if (!alive) {
      this.d.log.emit('drop', { reason: 'expired', stage, jobId: job.id, trigger: job.trigger, chats: job.chats.map((c) => c.key) });
      this.sm.transition('IDLE');
      this.finish(job);
      return false;
    }
    return true;
  }

  private actualUsd(u: { inputTokens: number; outputTokens: number; imageTokens: number }): number | null {
    if (!this.budget) return null;
    try {
      return this.budget.estimateModelUsd(u.inputTokens, u.imageTokens, u.outputTokens);
    } catch {
      return null;
    }
  }
  private settle(job: Job, actual: number | null): void {
    if (job.reservation && this.budget) {
      const charged = this.budget.settle(job.reservation, actual);
      this.d.log.emit('budget_settled', { jobId: job.id, reservedUsd: job.reservation.usd, chargedUsd: charged, actualKnown: actual !== null, budget: this.budget.snapshot() });
    }
  }

  private onProviderError(e: Error, job: Job, which: 'model' | 'tts'): void {
    const rc = this.d.config.recovery;
    let reason = `${which}_error`;
    if (e instanceof ModelTimeoutError || (e instanceof AbortedError && which === 'model')) {
      reason = 'model_timeout';
      this.consecutiveFailures++;
      this.cooldownUntil = this.now + 5000;
    } else if (e instanceof RateLimitError) {
      reason = 'rate_limited';
      this.consecutiveFailures++;
      this.cooldownUntil = this.now + (e.retryAfterMs ?? 10_000);
    } else if (e instanceof SpendLimitError) {
      reason = 'spend_limit_reached';
      this.paidDisabled = true;
      this.d.log.emit('paid_disabled', { why: 'spend_limit_reached' });
    } else if (e instanceof TtsError) {
      reason = e.message.includes('timeout') ? 'tts_timeout' : 'tts_failed';
      this.consecutiveFailures++;
    } else {
      this.consecutiveFailures++;
    }
    this.d.log.emit('drop', { reason, jobId: job.id, which, error: e.message, chats: job.chats.map((c) => c.key), consecutiveFailures: this.consecutiveFailures });
    if (this.consecutiveFailures >= rc.consecutive_failures_before_pause) {
      this.cooldownUntil = this.now + rc.cooldown_ms;
      this.d.log.emit('source_paused', { which, untilT: this.cooldownUntil, failures: this.consecutiveFailures });
      this.consecutiveFailures = 0; // 冷卻後探測一次
    }
    if (this.sm.state === 'GENERATING' || this.sm.state === 'SYNTHESIZING') this.sm.transition('IDLE');
    this.finish(job);
  }

  private onPlayerError(e: Error, job: Job): void {
    if (e instanceof OverlapError) {
      this.d.log.emit('overlap', { jobId: job.id });
      this.d.log.emit('drop', { reason: 'overlap', jobId: job.id });
      if (this.sm.state === 'PLAYING') this.sm.transition('IDLE');
      this.finish(job);
      return;
    }
    if (e instanceof DeviceError) {
      this.d.log.emit('drop', { reason: 'device_error', jobId: job.id, error: e.message });
      this.invalidateInflight();
      this.errorSince = this.now;
      this.sm.transition('ERROR');
      this.d.log.emit('error', { why: 'device', error: e.message, generation: this.sessionGeneration });
      return;
    }
    this.d.log.emit('drop', { reason: 'player_error', jobId: job.id, error: e.message });
    if (this.sm.state === 'PLAYING') this.sm.transition('IDLE');
    this.finish(job);
  }
}
