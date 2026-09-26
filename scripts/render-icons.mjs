import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const body = Buffer.concat([name, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function insideRoundRect(x, y, size, inset, radius) {
  const left = inset;
  const right = size - inset - 1;
  const top = inset;
  const bottom = size - inset - 1;
  if (x < left || x > right || y < top || y > bottom) return false;
  const centers = [
    [left + radius, top + radius],
    [right - radius, top + radius],
    [left + radius, bottom - radius],
    [right - radius, bottom - radius],
  ];
  const inCorner =
    (x < left + radius && y < top + radius) ||
    (x > right - radius && y < top + radius) ||
    (x < left + radius && y > bottom - radius) ||
    (x > right - radius && y > bottom - radius);
  if (!inCorner) return true;
  return centers.some(([cx, cy]) => (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2);
}

function dumbbell(x, y, size) {
  const cx = size / 2;
  const cy = size / 2;
  const radius = size * 0.075;
  const offset = size * 0.13;
  const left = (x - (cx - offset)) ** 2 + (y - cy) ** 2 <= radius ** 2;
  const right = (x - (cx + offset)) ** 2 + (y - cy) ** 2 <= radius ** 2;
  const bar = Math.abs(y - cy) <= size * 0.028 && Math.abs(x - cx) <= size * 0.16;
  return left || right || bar;
}

function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const inset = Math.round(size * 0.08);
  const radius = Math.round(size * 0.22);
  for (let y = 0; y < size; y += 1) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x += 1) {
      const index = row + 1 + x * 4;
      if (!insideRoundRect(x, y, size, inset, radius)) {
        raw[index + 3] = 0;
        continue;
      }
      if (dumbbell(x, y, size)) {
        raw[index] = 255;
        raw[index + 1] = 255;
        raw[index + 2] = 255;
      } else {
        raw[index] = 0x2f;
        raw[index + 1] = 0x6f;
        raw[index + 2] = 0xed;
      }
      raw[index + 3] = 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync(join(root, "pwa-192.png"), png(192));
writeFileSync(join(root, "pwa-512.png"), png(512));
