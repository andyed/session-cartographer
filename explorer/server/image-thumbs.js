import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { ArtifactError } from './session-artifacts.js';

// Wall covers. A 7-day window names ~400 existing images with a median of
// 452 KB and a 90th percentile of 3 MB (measured 2026-10-29), so a wall that
// drew originals would decode hundreds of megabytes before it could pan.
//
// macOS ships `sips`, which resizes through ImageIO with no dependency. Other
// platforms get null and the caller serves the original: slower, never wrong.
// It cannot write WebP, so a thumbnail is JPEG when the source has no alpha
// channel and PNG when it may.
export const THUMB_WIDTHS = [160, 320, 640];
const SMALL_ENOUGH_BYTES = 192 * 1024;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PASSTHROUGH = new Set(['image/svg+xml', 'image/gif', 'image/x-icon']);

export function defaultThumbnailDir() {
  if (process.env.CARTOGRAPHER_THUMBNAIL_DIR) return process.env.CARTOGRAPHER_THUMBNAIL_DIR;
  const base = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Caches') : process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache');
  return path.join(base, 'session-cartographer', 'thumbnails');
}

const run = (file, args) => new Promise((resolve, reject) => {
  execFile(file, args, { timeout: 20_000, maxBuffer: 1 << 20 }, error => (error ? reject(error) : resolve()));
});

/** Nearest supported width at or above the request, so caches stay few and small. */
export function snapThumbWidth(value) {
  const width = Number(value);
  if (!Number.isFinite(width) || width <= 0) return 0;
  return THUMB_WIDTHS.find(w => w >= width) || THUMB_WIDTHS.at(-1);
}

export function createThumbnailer({ dir = defaultThumbnailDir(), sips = '/usr/bin/sips', platform = process.platform, concurrency = 3, exec = run } = {}) {
  const enabled = platform === 'darwin' && fs.existsSync(sips);
  const inflight = new Map();
  let active = 0;
  const waiting = [];
  const slot = () => new Promise(resolve => { if (active < concurrency) { active += 1; resolve(); } else waiting.push(resolve); });
  const release = () => { const next = waiting.shift(); if (next) next(); else active -= 1; };

  if (enabled) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Thumbnails of private images: prune what has not been served for a month.
    void fs.promises.readdir(dir).then(names => Promise.all(names.map(async name => {
      const file = path.join(dir, name);
      try { if (Date.now() - (await fs.promises.stat(file)).mtimeMs > MAX_AGE_MS) await fs.promises.unlink(file); } catch { /* raced */ }
    }))).catch(() => {});
  }

  /**
   * `opened` is an authorized `{ artifact, stat, mime, dimensions }`; the
   * caller keeps ownership of its fd. Returns `{ file, mime, etag }` or null
   * when the original should be served as is.
   */
  async function thumbnail(opened, width) {
    const { artifact, stat, mime, dimensions } = opened;
    if (!enabled || !width || PASSTHROUGH.has(mime) || stat.size <= SMALL_ENOUGH_BYTES) return null;
    if (dimensions && Math.max(dimensions.width, dimensions.height) <= width) return null;
    const jpeg = mime === 'image/jpeg' || (dimensions && dimensions.alpha === false);
    const key = createHash('sha256').update([artifact.path, stat.dev, stat.ino, stat.size, stat.mtimeMs, width].join('\0')).digest('hex').slice(0, 32);
    const file = path.join(dir, `${key}.${jpeg ? 'jpg' : 'png'}`);
    const result = { file, mime: jpeg ? 'image/jpeg' : 'image/png', etag: `"${key}"` };
    try {
      const now = new Date();
      await fs.promises.utimes(file, now, now);
      return result;
    } catch { /* not generated yet */ }
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        await slot();
        const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
        try {
          // An absolute path cannot be read as an option; argv, never a shell.
          await exec(sips, ['-Z', String(width), '-s', 'format', jpeg ? 'jpeg' : 'png', ...(jpeg ? ['-s', 'formatOptions', '80'] : []), artifact.path, '--out', temp]);
          const after = fs.lstatSync(artifact.path);
          if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
            throw new ArtifactError(409, 'Image changed while its thumbnail was made; retry.');
          }
          fs.renameSync(temp, file);
        } finally {
          fs.rmSync(temp, { force: true });
          release();
          inflight.delete(key);
        }
      })());
    }
    await inflight.get(key);
    return result;
  }

  return { enabled, dir, thumbnail };
}
