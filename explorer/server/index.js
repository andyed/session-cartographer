import express from 'express';
import { readAllEvents, watchFiles, LOG_FILES, readJsonlFile, isHighSignal } from './jsonl.js';
import { buildIndex, addToIndex } from './bm25.js';
import { hybridSearch } from './search.js';
import { statSync } from 'fs';
import { resolve, normalize } from 'path';
import { homedir } from 'os';

const PORT = parseInt(process.env.CARTOGRAPHER_API_PORT || '2526', 10);
const app = express();

// ─── Load events + build BM25 index ───
console.log('Loading events...');
const events = readAllEvents();
const index = buildIndex(events);
console.log(`Loaded ${events.length} events, ${index.docs.size} docs in BM25 corpus (avgdl: ${index.avgdl.toFixed(1)} tokens).`);

// ─── SSE clients ───
const sseClients = new Set();

// ─── Watch for new events ───
const stopWatching = watchFiles((newEvents) => {
  for (const event of newEvents) {
    events.unshift(event); // newest first
    addToIndex(index, event);
  }

  // Push high-signal events to SSE clients
  const highSignal = newEvents.filter(isHighSignal);
  for (const res of sseClients) {
    for (const event of highSignal) {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  }
});

process.on('SIGINT', () => {
  stopWatching();
  process.exit(0);
});

// ─── Endpoints ───

app.get('/api/health', async (_req, res) => {
  const files = {};
  for (const [source, path] of Object.entries(LOG_FILES)) {
    try {
      statSync(path);
      files[source] = true;
    } catch {
      files[source] = false;
    }
  }

  let qdrant = false;
  try {
    const r = await fetch(
      `${process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333'}/collections/${process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer'}`
    );
    qdrant = r.ok;
  } catch {}

  let embed = false;
  try {
    const r = await fetch(
      (process.env.CARTOGRAPHER_EMBED_URL || 'http://localhost:8890/v1/embeddings').replace('/v1/embeddings', '/health')
    );
    embed = r.ok;
  } catch {}

  res.json({ status: 'ok', events: events.length, files, qdrant, embed });
});

app.get('/api/events', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const offset = parseInt(req.query.offset || '0', 10);
  const project = req.query.project || '';
  const showAll = req.query.all === 'true';

  let filtered = events;
  if (!showAll) {
    filtered = filtered.filter(isHighSignal);
  }
  if (project) {
    filtered = filtered.filter(e =>
      (e.project || '').toLowerCase().includes(project.toLowerCase())
    );
  }

  res.json({
    events: filtered.slice(offset, offset + limit),
    total: filtered.length,
  });
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q || '';
  const project = req.query.project || '';
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 100);

  // No query and no project filter — return empty
  if (!query.trim() && !project) {
    return res.json({ results: [], meta: { query: '', keyword_count: 0, semantic_count: 0, fused_count: 0, duration_ms: 0 } });
  }

  const start = Date.now();
  let results;

  if (!query.trim() && project) {
    // Project-only filter: return recent events for that project (no BM25 needed)
    const filtered = events
      .filter(e => (e.project || '').toLowerCase().includes(project.toLowerCase()))
      .filter(isHighSignal)
      .slice(0, limit)
      .map(e => ({ ...e, _score: 0, _sources: 'browse' }));
    results = { items: filtered, keywordCount: 0, semanticCount: 0 };
  } else {
    results = await hybridSearch(index, query, { project, limit });
  }

  const duration = Date.now() - start;

  res.json({
    results: results.items,
    meta: {
      query,
      keyword_count: results.keywordCount,
      semantic_count: results.semanticCount,
      fused_count: results.items.length,
      duration_ms: duration,
    },
  });
});

app.get('/api/projects', (_req, res) => {
  const projects = new Set();
  for (const event of events) {
    if (event.project) projects.add(event.project);
  }
  res.json({ projects: [...projects].sort() });
});

app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Heartbeat every 30s to keep connection alive
  const heartbeat = setInterval(() => {
    res.write(':\n\n');
  }, 30000);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
    clearInterval(heartbeat);
  });
});

// ─── Transcript viewer ───
const TRANSCRIPTS_DIR = resolve(
  process.env.CARTOGRAPHER_TRANSCRIPTS_DIR || `${homedir()}/.claude/projects`
);

app.get('/api/transcript', (req, res) => {
  const rawPath = req.query.path || '';
  if (!rawPath) return res.status(400).json({ error: 'path required' });

  // Path traversal protection
  const resolved = resolve(rawPath.replace(/^~/, homedir()));
  if (!resolved.startsWith(TRANSCRIPTS_DIR)) {
    return res.status(403).json({ error: 'path outside transcripts directory' });
  }

  const entries = readJsonlFile(resolved);
  if (entries.length === 0) {
    return res.status(404).json({ error: 'transcript not found or empty' });
  }

  // Filter to conversation entries (user, assistant, tool results)
  const messages = entries.filter(e =>
    e.type === 'user' || e.type === 'assistant' || e.type === 'progress'
  ).map(e => ({
    uuid: e.uuid,
    type: e.type,
    timestamp: e.timestamp,
    role: e.message?.role || e.type,
    content: typeof e.message?.content === 'string'
      ? e.message.content
      : Array.isArray(e.message?.content)
        ? e.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
        : e.data?.type || '',
    model: e.message?.model || '',
    toolUseID: e.toolUseID || '',
    parentToolUseID: e.parentToolUseID || '',
  })).filter(m => m.content);

  res.json({ path: resolved, messages, total: messages.length });
});

// ─── Start ───
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Cartographer API: http://127.0.0.1:${PORT}`);
  console.log(`Health: http://127.0.0.1:${PORT}/api/health`);
});
