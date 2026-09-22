import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** RGB 畫布 → PNG（8-bit truecolor, no filter）。零依賴，供合成 fixture 用。 */
export class Canvas {
  readonly data: Buffer;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = Buffer.alloc(width * height * 3);
  }
  fill(r: number, g: number, b: number): void {
    for (let i = 0; i < this.data.length; i += 3) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
    }
  }
  rect(x: number, y: number, w: number, h: number, r: number, g: number, b: number): void {
    const x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(this.width, x + w), y1 = Math.min(this.height, y + h);
    for (let yy = y0; yy < y1; yy++) {
      let i = (yy * this.width + x0) * 3;
      for (let xx = x0; xx < x1; xx++) {
        this.data[i++] = r;
        this.data[i++] = g;
        this.data[i++] = b;
      }
    }
  }
  toPng(): Buffer {
    const rowLen = this.width * 3 + 1;
    const raw = Buffer.alloc(rowLen * this.height);
    for (let y = 0; y < this.height; y++) {
      raw[y * rowLen] = 0;
      this.data.copy(raw, y * rowLen + 1, y * this.width * 3, (y + 1) * this.width * 3);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(this.width, 0);
    ihdr.writeUInt32BE(this.height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // truecolor
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 0;
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 6 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

/** 5x7 點陣數字，用來在合成畫面畫局數與分數 */
const DIGITS: Record<string, string[]> = {
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  ':': ['00000', '00100', '00100', '00000', '00100', '00100', '00000'],
  'R': ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
};

export function drawText(c: Canvas, text: string, x: number, y: number, scale: number, r: number, g: number, b: number): void {
  let cx = x;
  for (const ch of text) {
    const glyph = DIGITS[ch];
    if (glyph) {
      for (let gy = 0; gy < 7; gy++) {
        const row = glyph[gy]!;
        for (let gx = 0; gx < 5; gx++) if (row[gx] === '1') c.rect(cx + gx * scale, y + gy * scale, scale, scale, r, g, b);
      }
    }
    cx += 6 * scale;
  }
}
