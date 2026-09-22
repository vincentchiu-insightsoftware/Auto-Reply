import type { Fault, FaultKind } from '../fixtures/generate.js';

/** 依場景時間查詢目前生效的故障 */
export class FaultSchedule {
  constructor(
    private faults: Fault[],
    private startAt: number,
  ) {}
  active(now: number, kinds: readonly FaultKind[]): FaultKind | null {
    const e = now - this.startAt;
    for (const f of this.faults) if (kinds.includes(f.kind) && e >= f.atMs && e < f.atMs + f.durationMs) return f.kind;
    return null;
  }
}
