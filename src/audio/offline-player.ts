/** 離線播放器：以時間軸模擬播放；重疊呼叫 throw；stopNow 立即完成。 */
import type { Clock } from '../clock.js';
import { DeviceError, OverlapError, type AudioPlayer, type PlaybackHandle, type PlaybackRecord } from '../types.js';
import type { FaultSchedule } from '../providers/faults.js';

export class OfflinePlayer implements AudioPlayer {
  private current: { timer: number; resolve: (r: PlaybackRecord) => void; startedAt: number } | null = null;
  private opened = false;
  overlapAttempts = 0;
  constructor(
    private clock: Clock,
    private faults: FaultSchedule | null,
  ) {}
  async open(_deviceId: string | null): Promise<void> {
    if (this.faults?.active(this.clock.now(), ['device_lost'])) throw new DeviceError('device not found');
    this.opened = true;
  }
  isPlaying(): boolean {
    return this.current !== null;
  }
  play(_audio: Buffer, _mediaType: string, durationMs: number, signal: AbortSignal): Promise<PlaybackHandle> {
    if (this.current) {
      this.overlapAttempts++;
      return Promise.reject(new OverlapError());
    }
    if (!this.opened) return Promise.reject(new DeviceError('player not open'));
    if (this.faults?.active(this.clock.now(), ['device_lost'])) {
      this.opened = false;
      return Promise.reject(new DeviceError('device lost'));
    }
    if (signal.aborted) return Promise.reject(new DeviceError('aborted before start'));
    const startedAt = this.clock.now();
    const done = new Promise<PlaybackRecord>((resolve) => {
      const timer = this.clock.setTimeout(() => {
        this.current = null;
        resolve({ startedAt, endedAt: this.clock.now(), stopped: false });
      }, durationMs);
      this.current = { timer, resolve, startedAt };
      const onAbort = () => void this.stopNow();
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.resolve({ startedAt, done });
  }
  async stopNow(): Promise<void> {
    const c = this.current;
    if (!c) return;
    this.clock.clearTimeout(c.timer);
    this.current = null;
    c.resolve({ startedAt: c.startedAt, endedAt: this.clock.now(), stopped: true });
  }
}
