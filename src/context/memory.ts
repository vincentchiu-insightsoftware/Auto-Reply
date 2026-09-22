import type { Frame } from '../types.js';

/** 短期上下文：上一張有效畫面與最近 N 句已播放內容 */
export class ShortTermMemory {
  private spoken: string[] = [];
  lastValidFrame: Frame | null = null;
  lastValidFrameAt: number | null = null;
  constructor(private keep: number) {}
  pushSpoken(text: string): void {
    this.spoken.push(text);
    if (this.spoken.length > this.keep) this.spoken.shift();
  }
  recentSpoken(): string[] {
    return [...this.spoken];
  }
  setFrame(f: Frame, at: number): void {
    this.lastValidFrame = f;
    this.lastValidFrameAt = at;
  }
  /** 畫面過期或換版本後清掉，不再提供過期畫面事實 */
  clearFrame(): void {
    this.lastValidFrame = null;
    this.lastValidFrameAt = null;
  }
}
