import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ArtifactError, discoverSessionArtifacts, openArtifactFile } from './session-artifacts.js';
import { createGuardedInspector } from './guarded-open.js';
import { CORPUS_ROOT } from './jsonl.js';
import { isNonProject } from '../../scripts/non-projects.js';

// A Wunderkammer collection (wunderkammer.collection v1) of the images the
// sessions in a window wrote or named. The wall itself is Wunderkammer's; this
// module only decides which files belong on it and what each one says.
//
// "Wrote" is inferred, not recorded: no hook sees a binary image being written
// (Write never carries one, so session-artifacts' `created` was 0 of 1,572
// existing images over 30 days), but the commands that make images name them
// in their output. A file whose current mtime falls inside the span of a
// session that names it was last written while that session ran. A file
// written before or after every naming session was only named.
export const IMAGE_WALL_DAYS = [1, 7, 30, 90];
export const IMAGE_WALL_SCOPES = ['changed', 'named'];
const DAY_MS = 24 * 60 * 60 * 1000;
// Message stamps lag a tool's write by its run time at most, and some
// providers stamp at turn granularity.
const SPAN_SLACK_MS = 2 * 60 * 1000;
const TITLE_MAX = 80;

const AGENTS = { claude: 'Claude Code', codex: 'Codex', hermes: 'Hermes' };
const FORMATS = { 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/gif': 'GIF', 'image/webp': 'WebP', 'image/svg+xml': 'SVG', 'image/avif': 'AVIF', 'image/bmp': 'BMP', 'image/x-icon': 'ICO' };

function readEntries(file) {
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

/** How a piece of evidence named the image, in words a facet can show. */
export function namedBy(evidence) {
  if (evidence.source === 'assistant-link') return 'reply link';
  if (evidence.label === 'Recorded image listing') return 'listing';
  if (evidence.operation === 'created') return 'Write';
  const tool = String(evidence.label || '').replace(/ (?:reference|output)$/, '').split('__').at(-1).split('.').at(-1);
  if (/^(?:SendUserFile)$/i.test(tool)) return 'sent to user';
  if (evidence.source === 'tool-input') return /^(?:Write|write_file)$/i.test(tool) ? 'Write' : 'read';
  return 'tool output';
}

/**
 * One transcript → the compact record the wall caches: identity, time span,
 * and for each image its path, naming times and how it was named. No tool
 * bodies or message text survive this.
 */
export function scanTranscriptImages(file) {
  const stat = fs.statSync(file);
  const derived = discoverSessionArtifacts(readEntries(file), { inspect: false, imagesOnly: true });
  const { sessionId = '', provider = '', title = '', cwd = '' } = derived.identity || {};
  return {
    stamp: { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs },
    identity: { sessionId, provider, title, cwd },
    span: derived.span,
    images: derived.artifacts.map(artifact => ({
      id: artifact.id, path: artifact.path, name: artifact.name,
      firstAt: artifact.firstAt, lastAt: artifact.lastAt,
      named: [...new Set(artifact.evidence.map(namedBy))],
      // The first naming is usually the command that produced it.
      link: artifact.evidence[0] ? { messageId: artifact.evidence[0].messageId, blockId: artifact.evidence[0].blockId } : null,
    })),
  };
}

function runWorker(files) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./image-wall-worker.js', import.meta.url), { workerData: { files } });
    let settled = false;
    worker.once('message', message => { settled = true; resolve(message); });
    worker.once('error', error => { settled = true; reject(error); });
    worker.once('exit', code => { if (!settled) reject(new Error(`Image scan worker exited with code ${code}`)); });
  });
}

/**
 * Parse transcripts off the request thread. A 30-day window is ~400
 * transcripts and 25 s of parsing on one core (one Codex rollout is 29 MB), so
 * misses are split across a few workers; the machine is usually busy, so few.
 */
export async function scanInWorkers(files, { workers = Math.max(1, Math.min(3, os.availableParallelism() - 1)) } = {}) {
  if (!files.length) return [];
  const sorted = files.map(file => { try { return [file, fs.statSync(file).size]; } catch { return [file, 0]; } }).sort((a, b) => b[1] - a[1]);
  const shards = Array.from({ length: Math.min(workers, sorted.length) }, () => ({ files: [], bytes: 0 }));
  for (const [file, size] of sorted) { const shard = shards.reduce((a, b) => (b.bytes < a.bytes ? b : a)); shard.files.push(file); shard.bytes += size; }
  const results = await Promise.all(shards.map(shard => runWorker(shard.files)));
  return results.flat();
}

const sameFile = (stat, stamp) => stat.dev === stamp.dev && stat.ino === stamp.ino;

function folderOf(file, home = os.homedir()) {
  const p = file.split(path.sep).join('/');
  const h = home.split(path.sep).join('/');
  if (/\/(?:worktrees)\//.test(p)) return 'worktree';
  if (/^\/(?:private\/)?(?:tmp|var\/folders)\//.test(p) || p.startsWith(os.tmpdir().split(path.sep).join('/') + '/')) return 'temporary';
  if (/\/\.(?:claude|codex|hermes)\//.test(p)) return 'agent data';
  for (const name of ['Desktop', 'Downloads', 'Pictures']) if (p.startsWith(`${h}/${name}/`)) return name;
  if (p.startsWith(`${h}/Documents/`)) return 'Documents';
  if (p.startsWith(`${h}/`)) return 'home';
  return 'elsewhere';
}

// The image's own path names its project more reliably than its session: 385
// of 570 images written in one 7-day window came from sessions filed under
// the workspace root. A linked worktree resolves to its repository through
// the gitdir line in its .git file; `.claude/worktrees/` sits inside the repo.
const worktreeRepos = new Map();
function worktreeRepo(dir) {
  if (!worktreeRepos.has(dir)) {
    let repo = '';
    try {
      const gitdir = fs.readFileSync(path.join(dir, '.git'), 'utf8').match(/^gitdir:\s*(.+?)\s*$/m)?.[1] || '';
      const marker = `${path.sep}.git${path.sep}worktrees${path.sep}`;
      if (gitdir.includes(marker)) repo = path.basename(gitdir.slice(0, gitdir.indexOf(marker)));
    } catch { /* a plain directory, or its own repository */ }
    worktreeRepos.set(dir, repo || path.basename(dir));
  }
  return worktreeRepos.get(dir);
}

export function projectOfPath(file, { devDir = CORPUS_ROOT, home = os.homedir() } = {}) {
  const codex = path.relative(path.join(home, '.codex', 'worktrees'), file).split(path.sep);
  if (codex[0] && codex[0] !== '..' && codex.length > 2 && !isNonProject(codex[1])) return codex[1];
  const parts = path.relative(devDir, file).split(path.sep);
  if (!parts[0] || parts[0] === '..' || path.isAbsolute(parts[0]) || parts.length < 2) return '';
  const name = parts[0] === 'worktrees' && parts.length > 2 ? worktreeRepo(path.join(devDir, parts[0], parts[1])) : parts[0];
  return isNonProject(name) ? '' : name;
}

function sessionProject(session) {
  if (!session) return '';
  if (!isNonProject(session.project)) return session.project;
  return (session.projects || []).find(name => !isNonProject(name)) || '';
}

const shapeOf = d => (!d ? 'unknown' : d.width === d.height ? 'square' : d.width > d.height ? 'landscape' : 'portrait');
const displayPath = (file, home = os.homedir()) => (file.startsWith(home + path.sep) ? `~${file.slice(home.length)}` : file);
const kb = bytes => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const within = (ms, span) => {
  const start = Date.parse(span?.start || ''), end = Date.parse(span?.end || '');
  return Number.isFinite(start) && Number.isFinite(end) && ms >= start - SPAN_SLACK_MS && ms <= end + SPAN_SLACK_MS;
};

function sessionLabel(naming) {
  const title = String(naming.record.identity.title || '').replace(/\s+/g, ' ').trim();
  const id = String(naming.session?.session_id || naming.record.identity.sessionId || '').slice(0, 8);
  if (!title) return `${AGENTS[naming.session?.provider] || 'session'} ${id}`.trim();
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX - 1)}…` : title;
}

export function createImageWall({ scan = scanInWorkers, inspector = createGuardedInspector(), now = Date.now } = {}) {
  const records = new Map();
  const pending = new Map();

  /** Canonical transcript paths → current records, scanning only what changed. */
  async function load(files) {
    const out = new Map(), misses = [];
    for (const file of new Set(files)) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      const cached = records.get(file);
      if (cached && sameFile(stat, cached.stamp) && stat.size === cached.stamp.size && stat.mtimeMs === cached.stamp.mtimeMs) out.set(file, cached);
      else misses.push(file);
    }
    const fresh = misses.filter(file => !pending.has(file));
    if (fresh.length) {
      const job = scan(fresh).then(results => {
        for (const { file, record } of results) if (record) records.set(file, record);
        return results;
      });
      for (const file of fresh) pending.set(file, job);
      job.finally(() => { for (const file of fresh) if (pending.get(file) === job) pending.delete(file); }).catch(() => {});
    }
    const failed = [];
    for (const job of new Set(misses.map(file => pending.get(file)).filter(Boolean))) {
      for (const result of await job) if (result.error && misses.includes(result.file)) failed.push(result.file);
    }
    for (const file of misses) if (records.has(file)) out.set(file, records.get(file));
    return { records: out, scanned: fresh.length, failed: failed.length };
  }

  /**
   * `transcripts` are `{ path, session }` pairs whose paths the caller has
   * already canonicalized and authorized. `fileUrl(path, id, width)` and
   * `transcriptUrl(path, link)` build the clip's links.
   */
  async function collection({ transcripts, days, scope, fileUrl, transcriptUrl }) {
    const started = Date.now();
    const bySession = new Map(transcripts.map(item => [item.path, item.session]));
    const { records: loaded, scanned, failed } = await load(transcripts.map(item => item.path));
    const files = new Map();
    for (const [transcript, record] of loaded) for (const image of record.images) {
      if (!files.has(image.path)) files.set(image.path, []);
      files.get(image.path).push({ transcript, record, image, session: bySession.get(transcript) });
    }
    const cutoff = now() - days * DAY_MS;
    const counts = { named: files.size, missing: 0, unavailable: 0, blocked: 0, namedOnly: 0, outside: 0 };
    const found = await inspector.inspect([...files.keys()]);
    const clips = [];
    for (const [file, namings] of files) {
      const result = found.get(file) || { status: 'unavailable' };
      if (result.status !== 'available') { counts[result.status] += 1; continue; }
      const { mime, dimensions } = result;
      const stat = { size: result.size };
      const mtime = result.mtimeMs;
      const writers = namings.filter(n => within(mtime, n.record.span));
      const latest = list => list.reduce((a, b) => (Date.parse(b.image.lastAt || 0) > Date.parse(a.image.lastAt || 0) ? b : a));
      const writer = writers.length ? latest(writers) : null;
      if (!writer) counts.namedOnly += 1;
      if (scope === 'changed' && !writer) continue;
      const primary = writer || latest(namings);
      const when = writer ? mtime : Date.parse(primary.image.lastAt || '');
      if (!(when >= cutoff)) { counts.outside += 1; continue; }
      const agent = AGENTS[primary.session?.provider || primary.record.identity.provider] || 'Other agent';
      const session = sessionLabel(primary);
      const sessionCount = new Set(namings.map(n => n.transcript)).size;
      const size = dimensions ? `${dimensions.width} × ${dimensions.height}` : '';
      const note = [
        writer ? `Written during ${agent} session “${session}”.` : `Named by ${sessionCount === 1 ? `${agent} session “${session}”` : `${sessionCount} sessions`}; written outside them.`,
        sessionCount > 1 && writer ? `Named by ${sessionCount} sessions.` : '',
        `${displayPath(file)} · ${[size, kb(stat.size)].filter(Boolean).join(' · ')}`,
      ].filter(Boolean).join(' ');
      clips.push({
        id: primary.image.id,
        url: `urn:session-cartographer:image:${primary.image.id}`,
        title: primary.image.name,
        cover: fileUrl(primary.transcript, primary.image.id, 320),
        detailCover: fileUrl(primary.transcript, primary.image.id, 0),
        ...(primary.image.link ? { sourceUrl: transcriptUrl(primary.transcript, primary.image.link), sourceLabel: 'Open in transcript ↗' } : {}),
        note,
        source: agent,
        captured: new Date(mtime).toISOString(),
        props: {
          project: projectOfPath(file) || sessionProject(primary.session) || 'unattributed',
          session,
          named: [...new Set(namings.flatMap(n => n.image.named))].sort(),
          location: folderOf(file),
          format: FORMATS[mime] || mime,
          shape: shapeOf(dimensions),
          day: localDay(mtime),
          ...(scope === 'named' ? { written: writer ? 'during a session' : 'outside sessions' } : {}),
        },
      });
    }
    clips.sort((a, b) => b.captured.localeCompare(a.captured) || a.title.localeCompare(b.title));
    const blockedRoots = [...new Set([...found.values()].filter(r => r.status === 'blocked').map(r => displayPath(r.root)))];
    const stats = { days, scope, transcripts: transcripts.length, scanned, failed, ...counts, blockedRoots, shown: clips.length, ms: Date.now() - started };
    if (!clips.length) return { collection: null, stats };
    const windowLabel = days === 1 ? '24 hours' : `${days} days`;
    const revision = createHash('sha256').update(clips.map(c => `${c.id}:${c.captured}`).join('\n')).digest('hex').slice(0, 16);
    return {
      stats,
      collection: {
        format: 'wunderkammer.collection',
        version: 1,
        corpus: { id: `session-cartographer:images:${scope}`, revision },
        ui: {
          title: scope === 'changed' ? `Images written in sessions · last ${windowLabel}` : `Images sessions named · last ${windowLabel}`,
          nouns: { item: 'image', items: 'images' },
          defaultGroup: 'project',
          // Listing a facet here keeps it groupable past the wall's 24-value default.
          facetOrder: ['project', 'session', 'source', 'named', 'location', 'format', 'shape', 'day', ...(scope === 'named' ? ['written'] : [])],
          facetLabels: { source: 'agent', named: 'named by', location: 'folder', day: 'last written' },
        },
        clips,
      },
    };
  }

  /**
   * Open an image the transcript names, for the wall's covers and detail
   * view. Transcripts only grow, so a record scanned from a shorter copy of
   * the same file still authorizes what it found; a replaced file is rescanned.
   */
  async function open(transcript, id) {
    let record = records.get(transcript);
    const stat = fs.statSync(transcript);
    if (!record || !sameFile(stat, record.stamp) || stat.size < record.stamp.size) record = (await load([transcript])).records.get(transcript);
    const image = record?.images.find(item => item.id === id);
    if (!image) throw new ArtifactError(404, 'Image is not named by this session.');
    // Open on this thread only what a worker opened without stalling.
    const result = await inspector.ensure(image.path);
    if (result?.status === 'blocked') throw new ArtifactError(503, result.reason);
    const opened = openArtifactFile(image.path);
    return { artifact: image, ...opened, dimensions: result?.key === `${opened.stat.dev}:${opened.stat.ino}:${opened.stat.size}:${opened.stat.mtimeMs}` ? result.dimensions : null };
  }

  return { collection, open, clear() { records.clear(); } };
}
