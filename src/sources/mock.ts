/** Mock 畫面與留言來源：依 fixture 時間軸回放，掛在注入的 Clock 上。 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../clock.js';
import type { ChatMessage, ChatSource, Frame, FrameSource, SourceHealth } from '../types.js';
import { SourceError } from '../types.js';
import type { FixtureChat, FixtureFrame, Timeline } from '../fixtures/generate.js';
import { renderFrame, FRAME_W, FRAME_H } from '../fixtures/render.js';
import { shortHash } from '../util/hash.js';

export function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

export function loadTimeline(dir: string): Timeline {
  return JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8')) as Timeline;
}

export class MockFrameSource implements FrameSource {
  readonly id = 'mock-frames';
  private frames: FixtureFrame[];
  private startAt = 0;
  private cache = new Map<number, Buffer>();
  private h: SourceHealth = { state: 'ok', lastOkAt: null, consecutiveFailures: 0 };
  constructor(
    private clock: Clock,
    dir: string,
    private timeline: Timeline,
    private renderBytes = true,
  ) {
    this.frames = readJsonl<FixtureFrame>(join(dir, 'frames.jsonl'));
  }
  async start(): Promise<void> {
    this.startAt = this.clock.now();
  }
  private elapsed(): number {
    return this.clock.now() - this.startAt;
  }
  ended(): boolean {
    return this.elapsed() >= this.timeline.durationMs;
  }
  async grab(): Promise<Frame> {
    const e = this.elapsed();
    const idx = Math.min(this.frames.length - 1, Math.floor(e / this.timeline.frameIntervalMs));
    const f = this.frames[idx];
    if (!f) {
      this.h = { state: 'offline', lastOkAt: this.h.lastOkAt, consecutiveFailures: this.h.consecutiveFailures + 1, reason: 'no frame' };
      throw new SourceError('no frame');
    }
    let bytes = this.cache.get(idx);
    if (!bytes) {
      bytes = this.renderBytes ? renderFrame(f.facts, f.videoTimeMs) : Buffer.from(JSON.stringify(f.facts) + f.videoTimeMs);
      this.cache.set(idx, bytes);
      if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as number);
    }
    // frozen：畫面內容與前一張相同 → hash 相同（renderFrame 對 frozen 忽略時間）
    const hashSrc = f.facts.kind === 'frozen' ? `frozen:${f.facts.round}:${f.facts.scoreA}:${f.facts.scoreB}` : bytes;
    const black = f.facts.kind === 'black';
    this.h = black
      ? { state: 'degraded', lastOkAt: this.h.lastOkAt, consecutiveFailures: this.h.consecutiveFailures + 1, reason: 'black frame' }
      : { state: 'ok', lastOkAt: this.clock.now(), consecutiveFailures: 0 };
    return {
      frameRef: `frame:${idx}`,
      bytes,
      mediaType: 'image/png',
      width: FRAME_W,
      height: FRAME_H,
      frameHash: shortHash(hashSrc),
      capturedAt: this.clock.now(),
      videoTimeMs: f.videoTimeMs,
      segment: f.facts.round,
      eventKey: `${f.facts.round}:${f.facts.scoreA}:${f.facts.scoreB}:${f.facts.status}`,
      mockFacts: f.facts,
    };
  }
  health(): SourceHealth {
    return this.h;
  }
  async stop(): Promise<void> {}
}

export class MockChatSource implements ChatSource {
  readonly id = 'mock-chat';
  private msgs: FixtureChat[];
  private cursor = 0;
  private startAt = 0;
  private h: SourceHealth = { state: 'ok', lastOkAt: null, consecutiveFailures: 0 };
  constructor(
    private clock: Clock,
    dir: string,
    private timeline: Timeline,
  ) {
    this.msgs = readJsonl<FixtureChat>(join(dir, 'chat.jsonl'));
  }
  async start(): Promise<void> {
    this.startAt = this.clock.now();
  }
  async poll(): Promise<ChatMessage[]> {
    const e = this.clock.now() - this.startAt;
    const o = this.timeline.chatOutage;
    if (o && e >= o.fromMs && e < o.toMs) {
      this.h = { state: 'offline', lastOkAt: this.h.lastOkAt, consecutiveFailures: this.h.consecutiveFailures + 1, reason: 'fixture outage' };
      // 中斷期間的留言在恢復後不補送：重連預設從現在起收
      while (this.cursor < this.msgs.length && this.msgs[this.cursor]!.atMs < o.toMs && this.msgs[this.cursor]!.atMs <= e) this.cursor++;
      return [];
    }
    const out: ChatMessage[] = [];
    while (this.cursor < this.msgs.length && this.msgs[this.cursor]!.atMs <= e) {
      const m = this.msgs[this.cursor++]!;
      out.push({
        messageId: m.messageId,
        idStability: m.idStability,
        source: m.source,
        text: m.text,
        author: m.author,
        receivedAt: this.clock.now(),
        sourceTime: this.startAt + m.atMs,
      });
    }
    this.h = { state: 'ok', lastOkAt: this.clock.now(), consecutiveFailures: 0 };
    return out;
  }
  health(): SourceHealth {
    return this.h;
  }
  async stop(): Promise<void> {}
}
