import express from 'express';
import { readAllEvents, watchFiles, LOG_FILES, readJsonlFile, isHighSignal } from './jsonl.js';
import { buildIndex, addToIndex } from './bm25.js';
import { hybridSearch, computeFacets } from './search.js';
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

app.get('/api/autocomplete', (req, res) => {
  const prefix = (req.query.prefix || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (prefix.length < 2) return res.json({ suggestions: [] });

  const limit = Math.min(parseInt(req.query.limit || '8', 10), 20);
  const matches = [];

  for (const [term, df] of index.df) {
    if (term.startsWith(prefix) && term.length > prefix.length) {
      matches.push({ term, df });
    }
  }

  // Sort by document frequency (most common first), then alphabetically
  matches.sort((a, b) => b.df - a.df || a.term.localeCompare(b.term));

  res.json({ suggestions: matches.slice(0, limit).map(m => m.term) });
});

// Co-occurring terms: find docs containing the keyword, count other terms
app.get('/api/coterms', (req, res) => {
  const keyword = (req.query.term || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!keyword || !index.df.has(keyword)) return res.json({ terms: [] });

  const limit = Math.min(parseInt(req.query.limit || '6', 10), 20);
  const docCount = index.docs.size;
  const stopThreshold = docCount * 0.05; // terms in >5% of docs are stopwords
  const STOP = new Set(['the','and','for','this','that','with','from','was','are','not','but','has','had','have','will','been','can','its','all','also','into','our','your','com','www','http','https']);
  const coCount = new Map();

  for (const doc of index.docs.values()) {
    if (!doc.tf.has(keyword)) continue;
    for (const [term, count] of doc.tf) {
      if (term !== keyword && term.length > 2) {
        coCount.set(term, (coCount.get(term) || 0) + count);
      }
    }
  }

  // Score by co-occurrence frequency weighted down by global commonness
  // Filter stopwords (>15% of docs) and very rare terms (df=1)
  const scored = [...coCount.entries()]
    .filter(([term]) => {
      if (STOP.has(term)) return false;
      const df = index.df.get(term) || 0;
      return df > 1 && df < stopThreshold;
    })
    .map(([term, co]) => {
      const df = index.df.get(term) || 1;
      const score = co / Math.log2(df + 1);
      return { term, score, co };
    });
  scored.sort((a, b) => b.score - a.score);

  res.json({ terms: scored.slice(0, limit).map(s => s.term) });
});

app.get('/api/search', async (req, res) => {
  const query = req.query.q || '';
  const project = req.query.project || '';

  // No query and no project filter — return empty
  if (!query.trim() && !project) {
    return res.json({ results: [], meta: { query: '', keyword_count: 0, semantic_count: 0, fused_count: 0, duration_ms: 0, total_matches: 0 } });
  }

  const start = Date.now();
  let results;

  if (!query.trim() && project) {
    // Project-only filter: return recent events for that project (no BM25 needed)
    const filtered = events
      .filter(e => (e.project || '').toLowerCase().includes(project.toLowerCase()))
      .filter(isHighSignal);

    const allItems = filtered.slice(0, 500).map(e => ({ ...e, _score: 0, _sources: 'browse' }));
    results = { items: allItems, keywordCount: 0, semanticCount: 0, fusedCount: filtered.length, facets: computeFacets(allItems) };
  } else {
    results = await hybridSearch(index, query, { project });
  }

  const duration = Date.now() - start;

  res.json({
    results: results.items,
    facets: results.facets || null,
    meta: {
      query,
      keyword_count: results.keywordCount,
      semantic_count: results.semanticCount,
      fused_count: results.fusedCount,
      total_matches: results.keywordCount || results.fusedCount,
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

app.get('/api/sessions', (req, res) => {
  const days = Math.min(parseInt(req.query.days || '7', 10), 90);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  const bySession = new Map();
  for (const e of events) {
    const sid = e.session_id || e.session;
    if (!sid) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push(e);
  }

  const sessions = [];
  for (const [sid, evts] of bySession) {
    if (evts.length < 2) continue;
    let start = evts[0].timestamp, end = evts[0].timestamp;
    const projectCounts = {}, typeCounts = {};
    let transcriptPath = '';

    for (const e of evts) {
      if (e.timestamp < start) start = e.timestamp;
      if (e.timestamp > end) end = e.timestamp;
      const p = e.project || '';
      if (p) projectCounts[p] = (projectCounts[p] || 0) + 1;
      const t = e.type || '';
      if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (!transcriptPath && e.transcript_path) transcriptPath = e.transcript_path;
    }

    if (end < cutoff) continue;
    const project = Object.entries(projectCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const highSignal = evts.filter(isHighSignal).slice(0, 200);

    sessions.push({
      session_id: sid, start, end, event_count: evts.length, project,
      projects: Object.keys(projectCounts), types: typeCounts,
      transcript_path: transcriptPath,
      events: highSignal.map(e => ({
        event_id: e.event_id, timestamp: e.timestamp, type: e.type,
        project: e.project, summary: (e.summary || '').slice(0, 120),
      })),
    });
  }

  sessions.sort((a, b) => a.start.localeCompare(b.start));

  const overlaps = [];
  for (let i = 0; i < sessions.length; i++) {
    for (let j = i + 1; j < sessions.length; j++) {
      const a = sessions[i], b = sessions[j];
      if (a.start < b.end && b.start < a.end) {
        overlaps.push({
          sessions: [a.session_id, b.session_id],
          start: a.start > b.start ? a.start : b.start,
          end: a.end < b.end ? a.end : b.end,
        });
      }
    }
  }

  res.json({ sessions, overlaps });
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
