/**
 * 回播 harness：把 fixture、mock providers、Director 組起來，用 VirtualClock 加速跑完整段場景。
 * 場景時間與 wall time 分開報告。
 */
import { join } from 'node:path';
import { VirtualClock, RealClock, type Clock } from './clock.js';
import type { RuntimeConfig } from './config.js';
import { EventLog } from './log/events.js';
import { loadPersona, loadReference } from './context/persona.js';
import { MockChatSource, MockFrameSource, loadTimeline } from './sources/mock.js';
import { FaultSchedule } from './providers/faults.js';
import { MockModelProvider } from './providers/mock-model.js';
import { MockTtsProvider } from './providers/mock-tts.js';
import { OfflinePlayer } from './audio/offline-player.js';
import { Director } from './director/director.js';
import type { Timeline } from './fixtures/generate.js';

export interface ReplayOptions {
  scenarioDir: string;
  config: RuntimeConfig;
  outPath: string | null;
  injectEstops: number;
  resumeAfterMs: number;
  realtime: boolean;
  seed: number;
  renderFrames: boolean;
  /** 只跑前 N 毫秒場景時間（測試用） */
  limitMs?: number;
}

export interface ReplayResult {
  scenarioMs: number;
  wallMs: number;
  events: number;
  logPath: string | null;
  director: Director;
  log: EventLog;
  timeline: Timeline;
}

export function buildDirector(clock: Clock, opts: ReplayOptions, log: EventLog): { director: Director; timeline: Timeline } {
  const timeline = loadTimeline(opts.scenarioDir);
  const cfg = opts.config;
  if (cfg.mode !== 'mock') throw new Error('replay 只支援 mode=mock');
  const faults = new FaultSchedule(timeline.providerFaults, clock.now());
  const persona = loadPersona(opts.config.persona_path.startsWith('/') ? opts.config.persona_path : join(process.cwd(), opts.config.persona_path));
  const reference = loadReference(cfg.reference_path ? join(process.cwd(), cfg.reference_path) : null, cfg.director.max_reference_characters);
  const director = new Director({
    clock,
    config: cfg,
    persona,
    reference,
    planNotes: [],
    frames: new MockFrameSource(clock, opts.scenarioDir, timeline, opts.renderFrames),
    chat: new MockChatSource(clock, opts.scenarioDir, timeline),
    model: new MockModelProvider(clock, faults, { baseLatencyMs: 1200, jitterMs: 1500, timeoutMs: cfg.model.timeout_ms, seed: opts.seed }),
    tts: new MockTtsProvider(clock, faults),
    player: new OfflinePlayer(clock, faults),
    log,
  });
  return { director, timeline };
}

export async function runReplay(opts: ReplayOptions, onTick?: (director: Director, t: number) => Promise<void> | void): Promise<ReplayResult> {
  const clock: Clock = opts.realtime ? new RealClock() : new VirtualClock(0);
  const log = new EventLog(clock, opts.outPath);
  const { director, timeline } = buildDirector(clock, opts, log);
  const total = Math.min(timeline.durationMs, opts.limitMs ?? Number.POSITIVE_INFINITY);
  const estopTimes = new Set<number>(timeline.estops);
  if (opts.injectEstops > 0) {
    const step = Math.floor(total / (opts.injectEstops + 1));
    for (let i = 1; i <= opts.injectEstops; i++) estopTimes.add(i * step);
  }
  const tick = opts.config.director.tick_ms;
  const wall0 = Date.now();
  const t0 = clock.now();
  log.emit('replay_start', { scenario: opts.scenarioDir, minutes: timeline.minutes, seed: timeline.seed, estops: [...estopTimes].sort((a, b) => a - b), realtime: opts.realtime });
  await director.start();
  const pendingResume: number[] = [];
  let elapsed = 0;
  while (elapsed < total && director.state !== 'STOPPED') {
    elapsed = clock.now() - t0;
    for (const et of [...estopTimes]) {
      if (elapsed >= et) {
        estopTimes.delete(et);
        await director.emergencyStop();
        pendingResume.push(clock.now() + opts.resumeAfterMs);
      }
    }
    for (const rt of [...pendingResume]) {
      if (clock.now() >= rt) {
        pendingResume.splice(pendingResume.indexOf(rt), 1);
        await director.resume();
      }
    }
    await director.tick();
    if (onTick) await onTick(director, elapsed);
    if (clock instanceof VirtualClock) await clock.advance(tick);
    else await clock.sleep(tick);
  }
  if (director.state !== 'STOPPED') await director.stop('replay_end');
  // 讓晚到的計時器（例如 model_late）有機會回來並被丟棄
  if (clock instanceof VirtualClock) await clock.advance(60_000);
  const wallMs = Date.now() - wall0;
  log.emit('replay_end', { scenarioMs: clock.now() - t0, wallMs });
  return { scenarioMs: clock.now() - t0, wallMs, events: log.events().length, logPath: opts.outPath, director, log, timeline };
}
