import fs from 'node:fs';

// Pixel size from a file's header, read through an fd the caller already
// opened and authorized. No decoding: these are fixed header fields, so a
// truncated or hostile file yields null rather than a guess.
// JPEG can push its frame header past a large EXIF block, hence 256 KiB.
const HEAD_BYTES = { 'image/jpeg': 256 * 1024 };
const DEFAULT_HEAD = 64;

function readHead(fd, size, mime) {
  const length = Math.min(size, HEAD_BYTES[mime] || DEFAULT_HEAD);
  const buffer = Buffer.alloc(length);
  const read = fs.readSync(fd, buffer, 0, length, 0);
  return buffer.subarray(0, read);
}

const valid = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0;

function png(b) {
  if (b.length < 26 || b.toString('ascii', 12, 16) !== 'IHDR') return null;
  // Colour types 4 and 6 carry alpha; 3 (palette) may through tRNS, so treat it as possible.
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), alpha: [3, 4, 6].includes(b[25]) };
}

function gif(b) {
  return b.length < 10 ? null : { width: b.readUInt16LE(6), height: b.readUInt16LE(8), alpha: true };
}

function bmp(b) {
  return b.length < 26 ? null : { width: Math.abs(b.readInt32LE(18)), height: Math.abs(b.readInt32LE(22)), alpha: false };
}

function webp(b) {
  if (b.length < 30) return null;
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, alpha: false };
  if (chunk === 'VP8L') {
    const [b0, b1, b2, b3] = [b[21], b[22], b[23], b[24]];
    return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)), alpha: true };
  }
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3), alpha: Boolean(b[20] & 0x10) };
  return null;
}

function jpeg(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5), alpha: false };
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

const PARSERS = { 'image/png': png, 'image/gif': gif, 'image/bmp': bmp, 'image/webp': webp, 'image/jpeg': jpeg };

/** `{ width, height, alpha }` for PNG, JPEG, GIF, WebP and BMP; null otherwise. */
export function imageDimensions(fd, size, mime) {
  const parse = PARSERS[mime];
  if (!parse) return null;
  try {
    const found = parse(readHead(fd, size, mime));
    return found && valid(found.width, found.height) ? found : null;
  } catch { return null; }
}
