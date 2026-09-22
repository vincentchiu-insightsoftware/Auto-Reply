import { Canvas, drawText } from '../util/png.js';
import type { MockFrameFacts } from '../types.js';

export const FRAME_W = 960;
export const FRAME_H = 540;

/** 依 facts 畫一張假遊戲畫面。完全由程式生成，沒有真實截圖。 */
export function renderFrame(facts: MockFrameFacts, videoTimeMs: number): Buffer {
  const c = new Canvas(FRAME_W, FRAME_H);
  if (facts.kind === 'black') {
    c.fill(0, 0, 0);
    return c.toPng();
  }
  // 背景：依局數變色，讓 hash 隨局變化
  const hue = (facts.round * 37) % 255;
  c.fill(20 + (hue % 40), 40 + ((hue * 3) % 60), 60 + ((hue * 7) % 80));
  // 兩側分數面板
  c.rect(40, 40, 300, 120, 200, 60, 60);
  c.rect(FRAME_W - 340, 40, 300, 120, 60, 90, 200);
  drawText(c, String(facts.scoreA), 70, 70, 8, 255, 255, 255);
  drawText(c, String(facts.scoreB), FRAME_W - 310, 70, 8, 255, 255, 255);
  // 局數與計時
  drawText(c, `R${facts.round}`, FRAME_W / 2 - 60, 50, 6, 255, 230, 120);
  const sec = Math.floor(videoTimeMs / 1000) % 600;
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  drawText(c, `${mm}:${ss}`, FRAME_W / 2 - 90, 110, 6, 255, 255, 255);
  // 場中「角色」位置隨時間移動（frozen 時不動）
  const t = facts.kind === 'frozen' ? 0 : Math.floor(videoTimeMs / 2000);
  const px = 120 + ((t * 53) % (FRAME_W - 240));
  const py = 220 + ((t * 29) % 260);
  c.rect(px, py, 48, 48, 250, 200, 40);
  c.rect(FRAME_W - px - 48, FRAME_H - py - 20, 48, 48, 40, 220, 250);
  // 狀態列（以色塊表示狀態）
  const st = facts.status === 'clutch' ? [255, 80, 80] : facts.status === 'calm' ? [80, 200, 120] : [200, 200, 80];
  c.rect(0, FRAME_H - 30, FRAME_W, 30, st[0]!, st[1]!, st[2]!);
  return c.toPng();
}
