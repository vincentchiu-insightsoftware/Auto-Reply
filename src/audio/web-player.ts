/**
 * WebPlayer：把合成好的聲音交給瀏覧器播。伺服器保留音檔，透過 SSE 通知網頁播放；
 * 播放結束以時長計時為主，瀏覽器回報結束可提早。stopNow 立即通知網頁停止。
 */
import type { Clock } from '../clock.js';
import { OverlapError, type AudioPlayer, type PlaybackHandle, type PlaybackRecord } from '../types.js';

export interface PlayEvent {
  type: 'play' | 'stop';
  id: string;
  durationMs?: number;
}

export class WebPlayer implements AudioPlayer {
  private audios = new Map<string, { bytes: Buffer; mediaType: string }>();
  private current: { id: string; timer: number; resolve: (r: PlaybackRecord) => void; startedAt: number } | null = null;
  private seq = 0;
  constructor(
    private clock: Clock,
    private broadcast: (ev: PlayEvent) => void,
  ) {}
  async open(): Promise<void> {}
  isPlaying(): boolean {
    return this.current !== null;
  }
  getAudio(id: string): { bytes: Buffer; mediaType: string } | undefined {
    return this.audios.get(id);
  }
  play(audio: Buffer, mediaType: string, durationMs: number, signal: AbortSignal): Promise<PlaybackHandle> {
    if (this.current) return Promise.reject(new OverlapError());
    const id = `a${++this.seq}`;
    this.audios.set(id, { bytes: audio, mediaType });
    if (this.audios.size > 30) this.audios.delete(this.audios.keys().next().value as string);
    const startedAt = this.clock.now();
    const done = new Promise<PlaybackRecord>((resolve) => {
      const timer = this.clock.setTimeout(() => this.finish(id, false), durationMs + 300);
      this.current = { id, timer, resolve, startedAt };
      signal.addEventListener('abort', () => void this.stopNow(), { once: true });
    });
    this.broadcast({ type: 'play', id, durationMs });
    return Promise.resolve({ startedAt, done });
  }
  /** 瀏覽器回報播完 */
  reportEnded(id: string): void {
    this.finish(id, false);
  }
  private finish(id: string, stopped: boolean): void {
    const c = this.current;
    if (!c || c.id !== id) return;
    this.clock.clearTimeout(c.timer);
    this.current = null;
    c.resolve({ startedAt: c.startedAt, endedAt: this.clock.now(), stopped });
  }
  async stopNow(): Promise<void> {
    const c = this.current;
    if (!c) return;
    this.broadcast({ type: 'stop', id: c.id });
    this.finish(c.id, true);
  }
}
