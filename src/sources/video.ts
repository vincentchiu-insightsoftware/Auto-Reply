/**
 * VideoFrameSource：從影片檔依「播放頭」位置抽畫面（ffmpeg）。
 * 播放頭由瀏覽器回報（currentTime、playing、loop），伺服器用時間差推算目前位置。
 * 同一次 ffmpeg 輸出兩個結果：送模型的 JPEG，與判斷「畫面有沒有明顯變化」的灰階縮圖。
 */
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Clock } from '../clock.js';
import { SourceError, type Frame, type FrameSource, type SourceHealth } from '../types.js';
import { shortHash } from '../util/hash.js';

export interface Playhead {
  videoTimeMs: number;
  reportedAt: number;
  playing: boolean;
  loop: number;
}

export class VideoFrameSource implements FrameSource {
  readonly id = 'video-file';
  playhead: Playhead | null = null;
  private lastThumb: Buffer | null = null;
  private eventKey = 'start';
  private h: SourceHealth = { state: 'offline', lastOkAt: null, consecutiveFailures: 0, reason: 'no playhead yet' };
  constructor(
    private clock: Clock,
    private videoPath: string,
    private durationMs: number,
    private opts: { width: number; jpegQuality: number; changeThreshold: number; staleMs: number; ffmpeg: string },
  ) {}
  async start(): Promise<void> {}
  ended(): boolean {
    return false; // 測試台由瀏覽器循環播放
  }
  health(): SourceHealth {
    return this.h;
  }
  async stop(): Promise<void> {}

  currentVideoTimeMs(): number | null {
    const p = this.playhead;
    if (!p) return null;
    if (!p.playing) return p.videoTimeMs;
    return Math.min(this.durationMs - 100, p.videoTimeMs + (this.clock.now() - p.reportedAt));
  }

  async grab(): Promise<Frame> {
    const p = this.playhead;
    if (!p || this.clock.now() - p.reportedAt > this.opts.staleMs) {
      this.h = { state: 'offline', lastOkAt: this.h.lastOkAt, consecutiveFailures: this.h.consecutiveFailures + 1, reason: 'browser not reporting' };
      throw new SourceError('no recent playhead');
    }
    if (!p.playing) {
      this.h = { state: 'degraded', lastOkAt: this.h.lastOkAt, consecutiveFailures: 0, reason: 'video paused' };
      throw new SourceError('video paused');
    }
    const t = this.currentVideoTimeMs()!;
    const thumbPath = join(tmpdir(), `arb-thumb-${process.pid}.raw`);
    const args = [
      '-v', 'error', '-ss', (t / 1000).toFixed(3), '-i', this.videoPath,
      '-filter_complex', `[0:v]split=2[a][b];[a]scale=${this.opts.width}:-2[a1];[b]scale=48:27,format=gray[b1]`,
      '-map', '[a1]', '-frames:v', '1', '-q:v', String(this.opts.jpegQuality), '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1',
      '-map', '[b1]', '-frames:v', '1', '-f', 'rawvideo', '-y', thumbPath,
    ];
    const jpeg = await new Promise<Buffer>((resolve, reject) => {
      const ps = spawn(this.opts.ffmpeg, args);
      const chunks: Buffer[] = [];
      let err = '';
      ps.stdout.on('data', (c: Buffer) => chunks.push(c));
      ps.stderr.on('data', (c: Buffer) => (err += c.toString()));
      ps.on('error', reject);
      ps.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new SourceError(`ffmpeg exit ${code}: ${err.slice(0, 200)}`))));
    }).catch((e) => {
      this.h = { state: 'offline', lastOkAt: this.h.lastOkAt, consecutiveFailures: this.h.consecutiveFailures + 1, reason: (e as Error).message };
      throw e instanceof SourceError ? e : new SourceError((e as Error).message);
    });
    let thumb: Buffer | null = null;
    try {
      thumb = readFileSync(thumbPath);
      unlinkSync(thumbPath);
    } catch {
      thumb = null;
    }
    // 明顯變化偵測：灰階縮圖平均差
    let changed = false;
    if (thumb && this.lastThumb && thumb.length === this.lastThumb.length) {
      let sum = 0;
      for (let i = 0; i < thumb.length; i++) sum += Math.abs(thumb[i]! - this.lastThumb[i]!);
      changed = sum / thumb.length > this.opts.changeThreshold;
    }
    if (thumb) this.lastThumb = thumb;
    if (changed) this.eventKey = `evt:${Math.round(t)}`;
    const size = jpegSize(jpeg) ?? { width: this.opts.width, height: Math.round((this.opts.width * 9) / 16) };
    this.h = { state: 'ok', lastOkAt: this.clock.now(), consecutiveFailures: 0 };
    return {
      frameRef: `video:${Math.round(t)}`,
      bytes: jpeg,
      mediaType: 'image/jpeg',
      width: size.width,
      height: size.height,
      frameHash: shortHash(jpeg),
      capturedAt: this.clock.now(),
      videoTimeMs: t,
      segment: p.loop,
      eventKey: this.eventKey,
    };
  }
}

/** 讀 JPEG SOF 取得尺寸 */
export function jpegSize(buf: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null;
    const marker = buf[i + 1]!;
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}
