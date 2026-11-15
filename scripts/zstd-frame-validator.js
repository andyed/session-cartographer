/** Frame-boundary validation for Node 22's silent zstd truncation bug (#64592).
 * Payload/checksum validity stays with zlib. Only headers are retained.
 * https://github.com/facebook/zstd/blob/dev/doc/zstd_compression_format.md
 */
export class ZstdFrameValidator {
  constructor() { this.state = 'magic'; this.needed = 4; this.header = []; this.frames = 0; this.skip = 0; }
  transition(state, needed) { this.state = state; this.needed = needed; this.header = []; }
  payload(size, next, needed) {
    this.skip = size;
    this.afterSkip = [next, needed];
    if (!size) this.transition(next, needed);
  }
  write(bytes) {
    let offset = 0;
    while (offset < bytes.length) {
      if (this.skip) {
        const count = Math.min(this.skip, bytes.length - offset);
        offset += count; this.skip -= count;
        if (!this.skip) this.transition(...this.afterSkip);
        continue;
      }
      while (this.header.length < this.needed && offset < bytes.length) this.header.push(bytes[offset++]);
      if (this.header.length < this.needed) continue;
      const h = Buffer.from(this.header);
      switch (this.state) {
        case 'magic': {
          const magic = h.readUInt32LE();
          if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
            this.frames++; this.transition('skippable', 4);
          } else if (magic === 0xfd2fb528) {
            this.frames++; this.transition('descriptor', 1);
          } else throw new Error('Invalid zstd frame magic');
          break;
        }
        case 'skippable': this.payload(h.readUInt32LE(), 'magic', 4); break;
        case 'descriptor': {
          const d = h[0];
          if (d & 8) throw new Error('Reserved zstd frame bit');
          this.checksum = Boolean(d & 4);
          const single = Boolean(d & 32);
          const fcs = [single ? 1 : 0, 2, 4, 8][d >> 6];
          const dict = [0, 1, 2, 4][d & 3];
          this.payload((single ? 0 : 1) + fcs + dict, 'block', 3);
          break;
        }
        case 'block': {
          const b = h.readUIntLE(0, 3), type = (b >> 1) & 3;
          if (type === 3) throw new Error('Reserved zstd block type');
          const size = b >>> 3;
          if (size > 131072) throw new Error('Oversized zstd block');
          const last = Boolean(b & 1);
          this.payload(type === 1 ? 1 : size, last ? (this.checksum ? 'checksum' : 'magic') : 'block', last ? 4 : 3);
          break;
        }
        case 'checksum': this.transition('magic', 4); break;
      }
    }
  }
  finish() {
    if (!this.frames || this.skip || this.state !== 'magic' || this.header.length) throw new Error('Unexpected end of zstd frame');
  }
}
