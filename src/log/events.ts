import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Clock } from '../clock.js';

export interface LogEvent {
  t: number; // 場景時間（clock.now）
  wall: number; // 實際牆鐘
  type: string;
  [k: string]: unknown;
}

export interface EventSink {
  write(ev: LogEvent): void;
  events(): LogEvent[];
}

/** JSONL 事件日誌。不記金鑰、不記完整瀏覽器狀態。 */
export class EventLog implements EventSink {
  private buf: LogEvent[] = [];
  constructor(
    private clock: Clock,
    private path: string | null,
  ) {
    if (path) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
    }
  }
  emit(type: string, fields: Record<string, unknown> = {}): LogEvent {
    const ev: LogEvent = { t: this.clock.now(), wall: Date.now(), type, ...fields };
    this.write(ev);
    return ev;
  }
  write(ev: LogEvent): void {
    this.buf.push(ev);
    if (this.path) appendFileSync(this.path, JSON.stringify(ev) + '\n');
  }
  events(): LogEvent[] {
    return this.buf;
  }
}
