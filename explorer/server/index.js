import express from 'express';
import { readAllEvents, watchFiles, LOG_FILES } from './jsonl.js';
import { buildIndex, addToIndex } from './bm25.js';
import { hybridSearch } from './search.js';
import { statSync } from 'fs';

const PORT = parseInt(process.env.CARTOGRAPHER_API_PORT || '2526', 10);
const app = express();

// ─── Load events + build BM25 index ───
console.log('Loading events...');
const events = readAllEvents();
const index = buildIndex(events);
console.log(`Loaded ${events.length} events, BM25 index built.`);

// ─── SSE clients ───
const sseClients = new Set();

// ─── Watch for new events ───
const stopWatching = watchFiles((newEvents) => {
  for (const event of newEvents) {
    events.unshift(event); // newest first
    addToIndex(index, event);
  }

  // Push to SSE clients
  for (const res of sseClients) {
    for (const event of newEvents) {
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

  let filtered = events;
  if (project) {
    filtered = events.filter(e =>
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
  if (!query.trim()) {
    return res.json({ results: [], meta: { query: '', keyword_count: 0, semantic_count: 0, fused_count: 0, duration_ms: 0 } });
  }

  const project = req.query.project || '';
  const limit = Math.min(parseInt(req.query.limit || '15', 10), 100);

  const start = Date.now();
  const results = await hybridSearch(index, query, { project, limit });
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

// ─── Start ───
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Cartographer API: http://127.0.0.1:${PORT}`);
  console.log(`Health: http://127.0.0.1:${PORT}/api/health`);
});
