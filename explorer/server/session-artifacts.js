import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { normalizeTranscriptEntries } from './transcripts.js';
import { literalToolInputs } from './memory-transcript.js';
import { firstResolved } from '../../scripts/sentinels.js';

const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
const DOCUMENT_EXT = /\.(?:md|markdown|txt|html?|pdf|docx?|rtf|odt|csv|tsv|xlsx?|ods|pptx?|odp|tex|rst|ipynb)$/i;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
export class ArtifactError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function localArtifactPath(raw, extension, cwd = '') {
  if (typeof raw !== 'string') return null;
  let value = raw.trim().replace(/^<|>$/g, '');
  try {
    if (value.startsWith('file:')) {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return null;
      value = fileURLToPath(url);
    }
    else if (/%[0-9a-f]{2}/i.test(value)) value = decodeURIComponent(value);
  } catch { return null; }
  if (value.startsWith('\\\\') || value.startsWith('//')) return null;
  if (value.startsWith('~/')) value = path.join(homedir(), value.slice(2));
  if (!path.isAbsolute(value) && path.isAbsolute(cwd)) value = path.resolve(cwd, value);
  if (!path.isAbsolute(value) || !extension.test(value) || /[\0\r\n$`*?]/.test(value)) return null;
  return path.resolve(value);
}
const localImagePath = raw => localArtifactPath(raw, IMAGE_EXT);

function textImagePaths(text, markdownOnly = false) {
  if (typeof text !== 'string') return [];
  const candidates = [];
  for (const match of text.matchAll(/!?\[[^\]\n]*\]\((<[^>\n]+>|[^)\n]+)\)/g)) {
    candidates.push(match[1].replace(/\s+["'][^"']*["']$/, ''));
  }
  if (!markdownOnly) {
    for (const match of text.matchAll(/["'`]([^"'`\r\n]+)["'`]/g)) candidates.push(match[1]);
    for (const match of text.matchAll(/(?:^|[\s("'`])((?:\/|~\/|[A-Za-z]:[\\/])[^\s"'`<>()]+?\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico))(?=$|[\s"'`<>),;:])/gim)) candidates.push(match[1]);
  }
  return [...new Set(candidates.map(localImagePath).filter(Boolean))];
}

function outputTexts(value) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object') return [value, ...outputTexts(parsed)];
    } catch { /* plain tool output */ }
    return [value];
  }
  if (Array.isArray(value)) return value.flatMap(outputTexts);
  if (!value || typeof value !== 'object' || /image|audio|encrypted|base64/.test(value.type || '')) return [];
  return Object.entries(value).filter(([key]) => !['data', 'signature', 'encrypted_content'].includes(key)).flatMap(([, item]) => outputTexts(item));
}

// A deliberately narrow recorded-output form: an absolute, literal output
// directory assignment and an identify listing of that very variable. The
// result supplies each basename; no shell evaluation or directory scan occurs.
function listedOutputDirectory(call) {
  let input = call.input;
  if (typeof input === 'string') { try { input = JSON.parse(input); } catch { return null; } }
  const command = input?.command || input?.cmd;
  if (typeof command !== 'string') return null;
  const assignments = [...command.matchAll(/^([A-Za-z_][A-Za-z_0-9]*)=(?:"([^"\n]+)"|'([^'\n]+)'|([^\s;\n]+))\s*$/gm)];
  for (const match of assignments) {
    const directory = match[2] || match[3] || match[4];
    if (!path.isAbsolute(directory) || /[$`*?\0]/.test(directory)) continue;
    // Reassignment anywhere makes this reference ambiguous.
    if ([...command.matchAll(new RegExp(`(?:^|[;\\n])\\s*${match[1]}=`, 'g'))].length !== 1) continue;
    const reference = `"$${match[1]}"/*.png`;
    if (command.split('\n').some(line => /^\s*(?:magick\s+)?identify\s/.test(line) && line.includes(reference))) return path.resolve(directory);
  }
  return null;
}

function fileSignature(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(buffer.toString('ascii', 0, 6))) return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buffer.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(buffer.toString('ascii', 8, 32))) return 'image/avif';
  if (buffer.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (buffer.subarray(0, 4).equals(Buffer.from([0, 0, 1, 0]))) return 'image/x-icon';
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/i.test(text)) return 'image/svg+xml';
  return null;
}

function assertNoSymlink(file) {
  let current = file;
  while (true) {
    if (fs.lstatSync(current).isSymbolicLink()) throw new ArtifactError(403, 'Symlink artifacts are not available.');
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

export function openArtifactFile(file) {
  let fd;
  try {
    assertNoSymlink(file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new ArtifactError(403, 'Only regular image files are available.');
    if (!stat.size || stat.size > MAX_IMAGE_BYTES) throw new ArtifactError(415, 'Image is empty or exceeds the 64 MiB preview limit.');
    assertNoSymlink(file);
    const current = fs.lstatSync(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw new ArtifactError(409, 'Artifact changed while opening.');
    const header = Buffer.alloc(Math.min(4096, stat.size));
    fs.readSync(fd, header, 0, header.length, 0);
    const mime = fileSignature(header);
    if (!mime) throw new ArtifactError(415, 'Recorded file is not a supported image.');
    return { fd, stat, mime };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof ArtifactError) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ArtifactError(404, 'Recorded image is no longer available.');
    throw new ArtifactError(403, 'Recorded image cannot be opened safely.');
  }
}

function openDocumentFile(file) {
  let fd;
  try {
    assertNoSymlink(file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new ArtifactError(403, 'Only regular documents can be downloaded.');
    if (stat.size > MAX_IMAGE_BYTES) throw new ArtifactError(413, 'Document exceeds the 64 MiB download limit.');
    assertNoSymlink(file);
    const current = fs.lstatSync(file);
    if (current.ino !== stat.ino || current.dev !== stat.dev) throw new ArtifactError(409, 'Document changed while opening.');
    return { fd, stat };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    if (error instanceof ArtifactError) throw error;
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') throw new ArtifactError(404, 'Recorded document is no longer available.');
    throw new ArtifactError(403, 'Recorded document cannot be opened safely.');
  }
}

function openDerivedDocument(derived, id) {
  const document = derived.documents.find(item => item.id === id && ['created', 'edited'].includes(item.source));
  if (!document) throw new ArtifactError(404, 'Document is not recorded as created or edited by this session.');
  return { document, ...openDocumentFile(document.path) };
}

export function openSessionDocument(entries, id) {
  return openDerivedDocument(discoverSessionArtifacts(entries, { inspect: false }), id);
}

export function documentHeaders({ document, stat }) {
  const name = encodeURIComponent(document.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'Content-Type': 'application/octet-stream', 'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${name}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}

function inputObject(input) {
  if (typeof input !== 'string') return input;
  try { return JSON.parse(input); } catch { return input; }
}

function toolInputs(call) {
  const name = call.name.split('__').at(-1).split('.').at(-1);
  if (name === 'exec' && typeof call.input === 'string') return literalToolInputs(call.input);
  return [{ name, input: inputObject(call.input) }];
}

function transcriptDocuments(normalized, entries) {
  const documents = new Map();
  const results = new Map(normalized.messages.flatMap(message => message.blocks.filter(b => b.type === 'tool_result').map(block => [block.id, { message, block }])));
  let cwd = normalized.identity.cwd;
  const directories = entries.map(entry => {
    const candidate = entry.cwd || (['session_meta', 'turn_context'].includes(entry.type) ? entry.payload?.cwd : '');
    if (typeof candidate === 'string' && path.isAbsolute(candidate)) cwd = candidate;
    return cwd;
  });
  for (const message of normalized.messages) for (const block of message.blocks) {
    if (block.type !== 'tool_call' || block.status === 'error') continue;
    const recorded = block.resultIds.map(id => results.get(id)).filter(Boolean);
    const texts = recorded.flatMap(result => outputTexts(result.block.output));
    if (texts.some(text => /(?:^|\n)(?:Error:|Failed to find expected lines|apply_patch verification failed)/.test(text))) continue;
    const returned = recorded.length > 0;
    for (const tool of toolInputs(block)) {
      const candidates = [];
      if (['Write', 'Edit', 'MultiEdit', 'write_file', 'edit_file'].includes(tool.name) && tool.input && typeof tool.input === 'object') {
        candidates.push({ file: tool.input.file_path || tool.input.path || tool.input.filePath, operation: 'edited' });
      } else if (tool.name === 'apply_patch' && typeof tool.input === 'string') {
        for (const match of tool.input.matchAll(/^\*\*\* (Add File|Update File|Move to): (.+)\r?$/gm)) candidates.push({ file: match[2].trim(), operation: match[1] === 'Add File' ? 'created' : 'edited' });
      }
      for (const candidate of candidates) {
        const file = localArtifactPath(candidate.file, DOCUMENT_EXT, tool.input?.workdir || directories[message.sourceIndex] || '');
        if (!file) continue;
        let operation = returned ? candidate.operation : 'referenced';
        if (returned && ['Write', 'write_file'].includes(tool.name) && texts.some(text => [...text.matchAll(/^File created successfully at:\s*(.+)$/gim)].some(match => localArtifactPath(match[1], DOCUMENT_EXT, directories[message.sourceIndex] || '') === file))) operation = 'created';
        if (!documents.has(file)) documents.set(file, { id: `document-${createHash('sha256').update(file).digest('hex').slice(0, 24)}`, path: file, name: path.basename(file), extension: path.extname(file).slice(1).toLowerCase(), source: operation, operations: [], reviewUrl: null, evidence: [] });
        const document = documents.get(file);
        if (operation === 'created' || (operation === 'edited' && document.source === 'referenced')) document.source = operation;
        if (!document.operations.includes(operation)) document.operations.push(operation);
        const provenance = [{ message, block }, ...recorded];
        for (const item of provenance) if (!document.evidence.some(e => e.blockId === item.block.id)) document.evidence.push({ messageId: item.message.uuid, blockId: item.block.id, callId: block.callId, source: item.block.type === 'tool_call' ? 'tool-input' : 'tool-output', label: `${tool.name} ${item.block.type === 'tool_call' ? 'request' : 'result'}`, operation });
      }
    }
  }
  return [...documents.values()];
}

function transcriptCommits(normalized) {
  const calls = new Map(normalized.messages.flatMap(m => m.blocks.filter(b => b.type === 'tool_call').map(b => [b.id, b])));
  const commits = [];
  for (const message of normalized.messages) for (const block of message.blocks) {
    if (block.type !== 'tool_result') continue;
    const call = calls.get(block.callBlockId);
    if (!call) continue;
    const ranCommit = toolInputs(call).some(tool => {
      const command = tool.input?.command || tool.input?.cmd;
      return typeof command === 'string' && /(?:^|\n|&&|\|\||;)\s*git\s+(?:-C\s+(?:"[^"]+"|'[^']+'|\S+)\s+)?commit(?:\s|$)/.test(command);
    });
    if (!ranCommit) continue;
    for (const text of outputTexts(block.output)) for (const match of text.matchAll(/^\[[^\]\r\n]+? ([0-9a-f]{7,40})\]\s+([^\r\n]+)$/gim)) commits.push({ hash: match[1].toLowerCase(), subject: match[2].trim(), timestamp: message.timestamp || '', source: 'transcript', evidence: [{ messageId: message.uuid, blockId: block.id, callId: block.callId, source: 'tool-output', label: 'Recorded git commit output' }] });
  }
  return commits;
}

function mergeCommits(recorded, events, sessionId) {
  const canonical = [];
  if (sessionId) for (const event of events) {
    if (event.type !== 'git_commit' || firstResolved([event.session_id, event.session, event.sessionId], '') !== sessionId) continue;
    const summary = String(event.summary || event.description || '');
    const parsed = summary.match(/^(?:\[[^\]]+\]\s*)?Commit ([0-9a-f]{7,40}):\s*(.*?)(?:\s*\| files:.*)?$/i);
    const hash = String(event.commit_hash || event.commit_sha || parsed?.[1] || '').toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(hash)) continue;
    canonical.push({ hash, subject: event.subject || event.commit_subject || parsed?.[2] || summary, timestamp: event.timestamp || '', source: 'event', evidence: [{ eventId: event.event_id || '', source: 'event', label: 'Recorded git_commit event' }] });
  }
  const result = [];
  for (const commit of [...canonical, ...recorded]) {
    const matches = result.filter(existing => existing.hash.startsWith(commit.hash) || commit.hash.startsWith(existing.hash));
    let existing = result.find(existing => existing.hash === commit.hash) || (matches.length === 1 ? matches[0] : null);
    if (!existing) { existing = { ...commit, evidence: [] }; result.push(existing); }
    if (commit.hash.length > existing.hash.length) existing.hash = commit.hash;
    for (const evidence of commit.evidence) if (!existing.evidence.some(item => item.source === evidence.source && item.eventId === evidence.eventId && item.blockId === evidence.blockId)) existing.evidence.push(evidence);
  }
  return result.map(commit => ({ ...commit, id: `commit-${commit.hash}`, shortHash: commit.hash.slice(0, 7) }));
}

export function canonicalSessionArtifacts(events, sessionId) {
  if (!sessionId) return null;
  const sameSession = events.filter(event => firstResolved([event.session_id, event.session, event.sessionId], '') === sessionId);
  if (!sameSession.length) return null;
  return {
    path: null,
    identity: {
      sessionId,
      provider: firstResolved(sameSession.map(event => event.provider), ''),
      title: firstResolved(sameSession.flatMap(event => [event.session_title, event.sessionTitle]), ''),
      cwd: firstResolved(sameSession.map(event => event.cwd), ''),
    },
    artifacts: [], documents: [], commits: mergeCommits([], sameSession, sessionId),
  };
}

export function discoverSessionArtifacts(entries, { transcriptPath = '', inspect = true, events = [] } = {}) {
  const normalized = normalizeTranscriptEntries(entries);
  const artifacts = new Map();
  const calls = new Map(normalized.messages.flatMap(m => m.blocks.filter(b => b.type === 'tool_call').map(b => [b.id, b])));
  const add = (file, message, block, source, label, operation = 'referenced') => {
    file = localImagePath(file);
    if (!file) return;
    if (!artifacts.has(file)) artifacts.set(file, { id: createHash('sha256').update(file).digest('hex').slice(0, 24), path: file, name: path.basename(file), source: operation, evidence: [], lastIndex: message.sourceIndex });
    const artifact = artifacts.get(file);
    if (operation === 'created') artifact.source = 'created';
    artifact.lastIndex = message.sourceIndex;
    if (!artifact.evidence.some(e => e.blockId === block.id && e.source === source)) artifact.evidence.push({ messageId: message.uuid, blockId: block.id, ...(block.callId ? { callId: block.callId } : {}), source, label, operation });
  };
  for (const message of normalized.messages) for (const block of message.blocks) {
    if (block.type === 'tool_call') {
      let input = block.input;
      if (typeof input === 'string') { try { input = JSON.parse(input); } catch { continue; } }
      if (!input || typeof input !== 'object' || !/(?:^|[._])(?:Read|Write|view_image|SendUserFile|read_file|write_file)$/i.test(block.name)) continue;
      for (const file of [input.file_path, input.path, input.filePath, ...(Array.isArray(input.files) ? input.files : [])]) add(file, message, block, 'tool-input', `${block.name} reference`);
    } else if (block.type === 'tool_result') {
      const texts = outputTexts(block.output);
      for (const text of texts) for (const file of textImagePaths(text)) add(file, message, block, 'tool-output', `${block.name} output`);
      const call = calls.get(block.callBlockId);
      const directory = call && listedOutputDirectory(call);
      if (directory) for (const text of texts) for (const line of text.split('\n')) {
        const match = line.trim().match(/^\d+x\d+\s+([^/\\]+\.png)$/i);
        if (match) add(path.join(directory, match[1]), message, block, 'tool-output', 'Recorded image listing');
      }
      if (call && /(?:^|[._])(?:Write|write_file)$/i.test(call.name) && !block.isError) {
        let input = call.input;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = null; } }
        const file = localImagePath(input?.file_path || input?.path || input?.filePath);
        const confirmed = file && texts.some(text => /(?:^|\n)(?:File (?:created|written) successfully at:|Successfully (?:created|wrote)(?: file)?(?: at| to)?:?)\s+/i.test(text) && textImagePaths(text).includes(file));
        if (confirmed) add(file, message, block, 'tool-output', 'Recorded file creation', 'created');
      }
    } else if (block.type === 'text' && message.role === 'assistant') {
      for (const file of textImagePaths(block.text, true)) add(file, message, block, 'assistant-link', 'Assistant image link');
    }
  }
  const list = [...artifacts.values()].sort((a, b) => b.lastIndex - a.lastIndex || a.name.localeCompare(b.name));
  const derived = {
    identity: normalized.identity, artifacts: list.map(({ lastIndex, ...artifact }) => artifact),
    documents: transcriptDocuments(normalized, entries),
    commits: mergeCommits(transcriptCommits(normalized), events, normalized.identity.sessionId),
  };
  return inspect ? inspectArtifacts(derived, transcriptPath) : derived;
}

function inspectArtifacts(derived, transcriptPath) {
  const artifacts = derived.artifacts.map(artifact => {
    let metadata = { status: 'unavailable', previewUrl: null };
    try {
      const { fd, stat, mime } = openArtifactFile(artifact.path);
      fs.closeSync(fd);
      metadata = { status: 'available', mime, size: stat.size, modifiedAt: stat.mtime.toISOString(), previewUrl: `/api/session/artifact?${new URLSearchParams({ path: transcriptPath, id: artifact.id })}` };
    } catch (error) { metadata.reason = error.message; metadata.status = error.status === 404 ? 'missing' : 'unavailable'; }
    return { ...artifact, ...metadata };
  }).sort((a, b) => Number(b.status === 'available') - Number(a.status === 'available'));
  const documents = (derived.documents || []).map(document => {
    try {
      assertNoSymlink(document.path);
      const stat = fs.lstatSync(document.path);
      if (!stat.isFile()) return { ...document, status: 'unavailable', downloadUrl: null, reason: 'Recorded document is not a regular file.' };
      return { ...document, status: 'current', size: stat.size, modifiedAt: stat.mtime.toISOString(), downloadUrl: ['created', 'edited'].includes(document.source) && stat.size <= MAX_IMAGE_BYTES ? `/api/session/document?${new URLSearchParams({ path: transcriptPath, id: document.id })}` : null };
    } catch (error) { return { ...document, status: ['ENOENT', 'ENOTDIR'].includes(error.code) ? 'missing' : 'unavailable', downloadUrl: null }; }
  });
  return { identity: derived.identity, artifacts, documents, commits: derived.commits || [] };
}

// Re-discover against the authorized transcript on every read. The client can
// select an ID, never supply a second arbitrary filesystem path to serve.
export function openSessionArtifact(entries, id) {
  const artifact = discoverSessionArtifacts(entries, { inspect: false }).artifacts.find(item => item.id === id);
  if (!artifact) throw new ArtifactError(404, 'Image is not referenced by this session.');
  return { artifact, ...openArtifactFile(artifact.path) };
}

function readEntries(file) {
  return fs.readFileSync(file, 'utf8').split('\n').flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : []; } catch { return []; }
  });
}

// Cache only derived paths, identity and provenance, never raw transcripts or
// tool bodies. Each request checks source identity; image availability and
// descriptors are independently revalidated even when the source is unchanged.
export function createSessionArtifactCache({ maxEntries = 16, maxBytes = 4 * 1024 * 1024, loadEntries = readEntries } = {}) {
  const cache = new Map();
  let bytes = 0;
  const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
  const remove = key => { const entry = cache.get(key); if (entry) bytes -= entry.bytes; cache.delete(key); };
  function derived(transcriptPath) {
    const canonical = fs.realpathSync(transcriptPath);
    const before = fs.statSync(canonical);
    if (!before.isFile()) throw new ArtifactError(403, 'Transcript is not a regular file.');
    const stamp = signature(before);
    const previous = cache.get(canonical);
    if (previous?.stamp === stamp) { cache.delete(canonical); cache.set(canonical, previous); return previous.value; }
    remove(canonical);
    const value = discoverSessionArtifacts(loadEntries(canonical), { inspect: false });
    if (signature(fs.statSync(canonical)) !== stamp) throw new ArtifactError(409, 'Transcript changed while discovering images; retry the request.');
    const size = Buffer.byteLength(JSON.stringify(value));
    if (maxEntries > 0 && size <= maxBytes) {
      while (cache.size >= maxEntries || bytes + size > maxBytes) remove(cache.keys().next().value);
      cache.set(canonical, { stamp, value, bytes: size }); bytes += size;
    }
    return value;
  }
  return {
    list(transcriptPath, { events = [] } = {}) {
      const value = derived(transcriptPath);
      return inspectArtifacts({ ...value, commits: mergeCommits(value.commits, events, value.identity.sessionId) }, transcriptPath);
    },
    open(transcriptPath, id) {
      const artifact = derived(transcriptPath).artifacts.find(item => item.id === id);
      if (!artifact) throw new ArtifactError(404, 'Image is not referenced by this session.');
      return { artifact, ...openArtifactFile(artifact.path) };
    },
    openDocument(transcriptPath, id) { return openDerivedDocument(derived(transcriptPath), id); },
    clear() { cache.clear(); bytes = 0; },
  };
}

export function artifactHeaders({ artifact, stat, mime }) {
  const name = encodeURIComponent(artifact.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    'Content-Type': mime, 'Content-Length': stat.size,
    'Content-Disposition': `inline; filename*=UTF-8''${name}`,
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}
