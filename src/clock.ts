/**
 * Clock 抽象。RealClock 走系統時間；VirtualClock 供 deterministic 回播，
 * 由 harness 逐步推進，所有 mock provider 的延遲都掛在它的計時器上。
 */
export interface Clock {
  now(): number;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** 回傳一個在 ms 後 resolve 的 Promise；signal 中止時 reject AbortedError。 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  readonly kind: 'real' | 'virtual';
}

import { AbortedError } from './types.js';

function sleepWith(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortedError());
      return;
    }
    const id = clock.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clock.clearTimeout(id);
      reject(new AbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class RealClock implements Clock {
  readonly kind = 'real' as const;
  private ids = new Map<number, NodeJS.Timeout>();
  private next = 1;
  now(): number {
    return Date.now();
  }
  setTimeout(cb: () => void, ms: number): number {
    const id = this.next++;
    const t = globalThis.setTimeout(() => {
      this.ids.delete(id);
      cb();
    }, ms);
    this.ids.set(id, t);
    return id;
  }
  clearTimeout(id: number): void {
    const t = this.ids.get(id);
    if (t) {
      globalThis.clearTimeout(t);
      this.ids.delete(id);
    }
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepWith(this, ms, signal);
  }
}

interface VTimer {
  id: number;
  at: number;
  seq: number;
  cb: () => void;
}

export class VirtualClock implements Clock {
  readonly kind = 'virtual' as const;
  private t: number;
  private timers: VTimer[] = [];
  private next = 1;
  private seq = 0;
  constructor(start = 0) {
    this.t = start;
  }
  now(): number {
    return this.t;
  }
  setTimeout(cb: () => void, ms: number): number {
    const id = this.next++;
    this.timers.push({ id, at: this.t + Math.max(0, ms), seq: this.seq++, cb });
    return id;
  }
  clearTimeout(id: number): void {
    this.timers = this.timers.filter((x) => x.id !== id);
  }
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return sleepWith(this, ms, signal);
  }
  pendingTimers(): number {
    return this.timers.length;
  }
  /** 讓 Promise 鏈在真實事件迴圈中跑完 */
  static flush(): Promise<void> {
    return new Promise((r) => setImmediate(r));
  }
  /** 推進到 target，依序觸發到期計時器，每個計時器之後 flush 一次。 */
  async advanceTo(target: number): Promise<void> {
    while (true) {
      let due: VTimer | null = null;
      for (const x of this.timers) {
        if (x.at <= target && (due === null || x.at < due.at || (x.at === due.at && x.seq < due.seq))) due = x;
      }
      if (!due) break;
      this.timers = this.timers.filter((x) => x.id !== due!.id);
      this.t = Math.max(this.t, due.at);
      due.cb();
      await VirtualClock.flush();
    }
    this.t = Math.max(this.t, target);
    await VirtualClock.flush();
  }
  async advance(ms: number): Promise<void> {
    await this.advanceTo(this.t + ms);
  }
}
