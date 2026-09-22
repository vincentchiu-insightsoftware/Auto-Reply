/**
 * 去重。穩定 ID 的鍵為 source:messageId；seen、selected、spoken 三個集合分開。
 * 無穩定 ID 時以 正規化文字+作者+時間窗口 產生 synthetic 鍵，窗口外相同文字視為新留言。
 */
import type { ChatMessage } from '../types.js';
import { normalize } from '../util/text.js';
import { shortHash } from '../util/hash.js';

export function chatKey(m: ChatMessage): string {
  return `${m.source}:${m.messageId}`;
}

export class Deduper {
  private seen = new Set<string>();
  private selected = new Set<string>();
  private spoken = new Map<string, number>(); // key → 播放次數
  private synthetic: { sig: string; at: number }[] = [];
  constructor(private syntheticWindowMs = 8000) {}

  /** 回傳 true 表示是新留言（首次看到）。 */
  admit(m: ChatMessage): { key: string; isNew: boolean } {
    if (m.idStability === 'synthetic') {
      const sig = `${m.source}:${m.author ?? ''}:${normalize(m.text)}`;
      this.synthetic = this.synthetic.filter((x) => m.receivedAt - x.at < this.syntheticWindowMs);
      const dup = this.synthetic.find((x) => x.sig === sig);
      if (dup) return { key: `${m.source}:synthetic:${shortHash(sig + dup.at)}`, isNew: false };
      this.synthetic.push({ sig, at: m.receivedAt });
      const key = `${m.source}:synthetic:${shortHash(sig + m.receivedAt)}`;
      this.seen.add(key);
      return { key, isNew: true };
    }
    const key = chatKey(m);
    if (this.seen.has(key)) return { key, isNew: false };
    this.seen.add(key);
    return { key, isNew: true };
  }
  markSelected(keys: string[]): void {
    for (const k of keys) this.selected.add(k);
  }
  /** 播放開始時記錄；回傳這次之前已播過的鍵（應為空）。 */
  markSpoken(keys: string[]): string[] {
    const dup: string[] = [];
    for (const k of keys) {
      const n = this.spoken.get(k) ?? 0;
      if (n > 0) dup.push(k);
      this.spoken.set(k, n + 1);
    }
    return dup;
  }
  wasSpoken(key: string): boolean {
    return (this.spoken.get(key) ?? 0) > 0;
  }
  wasSelected(key: string): boolean {
    return this.selected.has(key);
  }
  stats(): { seen: number; selected: number; spoken: number; duplicatePlaybacks: number } {
    let dupPlay = 0;
    for (const n of this.spoken.values()) if (n > 1) dupPlay += n - 1;
    return { seen: this.seen.size, selected: this.selected.size, spoken: this.spoken.size, duplicatePlaybacks: dupPlay };
  }
}
