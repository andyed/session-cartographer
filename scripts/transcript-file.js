/**
 * transcript-file.js — read a transcript whether or not it is compressed.
 *
 * Why this exists. Codex Desktop zstd-compresses a rollout in place about a
 * week after its session: rollout-<ts>-<uuid>.jsonl becomes
 * rollout-<ts>-<uuid>.jsonl.zst, mtime kept. On 2026-11-13 that was 3,646 of
 * the 3,916 rollouts on this machine. A reader that opens the path it was
 * handed with readFileSync(path, 'utf8') turns a compressed transcript into
 * one unparseable line, and every caller of that reader then reports an empty
 * or missing transcript with no error anywhere.
 *
 * scripts/resolve-transcript.sh and codexSessionIndex() return the .zst path
 * when it is the only spelling on disk. Whatever opens a path they returned
 * reads it through this module, or says the transcript is compressed
 * (CompressedTranscriptError), never that it is absent.
 *
 * Node gained zlib zstd in 22.15. On an older Node `canReadZstd` is false and
 * both readers throw CompressedTranscriptError for a .zst path.
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

export const canReadZstd = typeof zlib.createZstdDecompress === 'function' && typeof zlib.zstdDecompressSync === 'function';

/** True for the compressed spelling of a transcript, by name alone. */
export function isCompressedTranscript(file) {
  return typeof file === 'string' && file.endsWith('.jsonl.zst');
}

export const COMPRESSED_UNREADABLE = `Transcript is zstd-compressed and Node ${process.versions.node} cannot read it (Node 22.15 or newer can).`;

/** A transcript that is on disk but cannot be decompressed by this process. */
export class CompressedTranscriptError extends Error {
  constructor(file, cause = null) {
    super(cause ? `Transcript is zstd-compressed and could not be decompressed: ${cause.message}` : COMPRESSED_UNREADABLE);
    this.name = 'CompressedTranscriptError';
    this.code = 'TRANSCRIPT_COMPRESSED';
    this.path = file;
    if (cause) this.cause = cause;
  }
}

/** The decoded bytes of an open or named transcript. `source` is a path or an fd. */
export function readTranscriptBuffer(source, { compressed = isCompressedTranscript(source), file = source } = {}) {
  const raw = fs.readFileSync(source);
  if (!compressed) return raw;
  if (!canReadZstd) throw new CompressedTranscriptError(file);
  try {
    return zlib.zstdDecompressSync(raw);
  } catch (error) {
    // A truncated or corrupt frame. Say so; an empty transcript would be a lie.
    throw new CompressedTranscriptError(file, error);
  }
}

/** The whole transcript as text, decompressed when its name says it is. */
export function readTranscriptText(file) {
  return isCompressedTranscript(file) ? readTranscriptBuffer(file).toString('utf8') : fs.readFileSync(file, 'utf8');
}

/** A utf8 stream of the transcript, for line readers that must not hold it whole. */
export function transcriptStream(file) {
  if (!isCompressedTranscript(file)) return fs.createReadStream(file, { encoding: 'utf8' });
  if (!canReadZstd) throw new CompressedTranscriptError(file);
  const source = fs.createReadStream(file);
  const decoded = source.pipe(zlib.createZstdDecompress());
  source.on('error', (error) => decoded.destroy(error));
  return decoded.setEncoding('utf8');
}
