// Generates the PWA PNG icons (rounded square + "F" glyph) without any image
// dependencies: raw RGBA -> zlib -> hand-assembled PNG chunks.
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

const BLUE = [0x2a, 0x78, 0xd6, 255];
const WHITE = [255, 255, 255, 255];
const CLEAR = [0, 0, 0, 0];

function crc32b(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32b(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixelFn) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function iconPixel(opaqueCorners) {
  return (x, y, size) => {
    const s = size / 512;
    const r = 96 * s;
    // rounded-rect test
    const cx = Math.min(Math.max(x, r), size - r);
    const cy = Math.min(Math.max(y, r), size - r);
    const inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
    if (!inside) return opaqueCorners ? BLUE : CLEAR;
    // "F" glyph rectangles in 512-space
    const inRect = (rx, ry, rw, rh) =>
      x >= rx * s && x < (rx + rw) * s && y >= ry * s && y < (ry + rh) * s;
    if (
      inRect(168, 128, 64, 256) ||
      inRect(168, 128, 192, 60) ||
      inRect(168, 242, 152, 56)
    )
      return WHITE;
    return BLUE;
  };
}

writeFileSync("public/icon-512.png", png(512, iconPixel(false)));
writeFileSync("public/icon-192.png", png(192, iconPixel(false)));
// apple-touch-icon: square (iOS applies its own mask), 180px
writeFileSync("public/apple-touch-icon.png", png(180, iconPixel(true)));
console.log("icons written");
