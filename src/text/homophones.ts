/**
 * 替字表：送語音合成前，把容易唸錯的詞換成同音字（例如 垃圾 → 樂色）。
 * 對任何供應商都有效，不依賴廠商的音標功能。只影響送去唸的文字，不影響字幕或日誌。
 */
import { readFileSync } from 'node:fs';

export interface Homophones {
  version: number;
  locale: string;
  entries: Record<string, string>;
}

export function loadHomophones(path: string | null): Homophones | null {
  if (!path) return null;
  const h = JSON.parse(readFileSync(path, 'utf8')) as Homophones;
  if (typeof h.entries !== 'object' || h.entries === null) throw new Error('homophones.entries missing');
  return h;
}

/** 長詞優先，避免「垃圾桶」被「垃圾」切壞。回傳替換後文字與命中的詞。 */
export function applyHomophones(text: string, h: Homophones | null | undefined): { text: string; hits: string[] } {
  if (!h || Object.keys(h.entries).length === 0) return { text, hits: [] };
  const words = Object.keys(h.entries).sort((a, b) => b.length - a.length);
  let out = '';
  const hits: string[] = [];
  let i = 0;
  outer: while (i < text.length) {
    for (const w of words) {
      if (text.startsWith(w, i)) {
        out += h.entries[w]!;
        hits.push(w);
        i += w.length;
        continue outer;
      }
    }
    out += text[i]!;
    i++;
  }
  return { text: out, hits };
}
