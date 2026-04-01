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

  const normalizeTs = (ts) => typeof ts === 'number' ? new Date(ts).toISOString() : ts;

  const bySession = new Map();
  for (const e of events) {
    const sid = e.session_id || e.session || e.sessionId;
    if (!sid) continue;
    if (!bySession.has(sid)) bySession.set(sid, []);
    bySession.get(sid).push({ ...e, timestamp: normalizeTs(e.timestamp) });
  }

  const sessions = [];
  for (const [sid, evts] of bySession) {
    if (evts.length < 2) continue;
    let start = evts[0].timestamp, end = evts[0].timestamp;
    const projectCounts = {}, typeCounts = {}, quadrantCounts = {}, commitTypeCounts = {};
    let transcriptPath = '';

    for (const e of evts) {
      if (e.timestamp < start) start = e.timestamp;
      if (e.timestamp > end) end = e.timestamp;
      const p = e.project || '';
      if (p) projectCounts[p] = (projectCounts[p] || 0) + 1;
      const t = e.type || '';
      if (t) typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (e.diff_shape?.quadrant) quadrantCounts[e.diff_shape.quadrant] = (quadrantCounts[e.diff_shape.quadrant] || 0) + 1;
      if (e.diff_shape?.commit_type) commitTypeCounts[e.diff_shape.commit_type] = (commitTypeCounts[e.diff_shape.commit_type] || 0) + 1;
      if (!transcriptPath && e.transcript_path) transcriptPath = e.transcript_path;
    }

    if (end < cutoff) continue;
    const project = Object.entries(projectCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const highSignal = evts.filter(isHighSignal).slice(0, 200);

    sessions.push({
      session_id: sid, start, end, event_count: evts.length, project,
      projects: Object.keys(projectCounts), types: typeCounts, quadrants: quadrantCounts, commit_types: commitTypeCounts,
      transcript_path: transcriptPath,
      events: highSignal.map(e => ({
        event_id: e.event_id, timestamp: e.timestamp, type: e.type,
        project: e.project, summary: (e.summary || '').slice(0, 120),
      })),
    });
  }

  // Associate orphan commits (backfilled, no session_id) with sessions by project + time overlap
  const orphanCommits = events.filter(e => e.type === 'git_commit' && !e.session_id && !e.session && e.diff_shape);
  for (const commit of orphanCommits) {
    for (const s of sessions) {
      if (commit.timestamp >= s.start && commit.timestamp <= s.end && s.projects.includes(commit.project)) {
        if (commit.diff_shape.quadrant) s.quadrants[commit.diff_shape.quadrant] = (s.quadrants[commit.diff_shape.quadrant] || 0) + 1;
        if (commit.diff_shape.commit_type) s.commit_types[commit.diff_shape.commit_type] = (s.commit_types[commit.diff_shape.commit_type] || 0) + 1;
        break; // assign to first matching session
      }
    }
  }

  sessions.sort((a, b) => b.start.localeCompare(a.start));

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

  // Classify noise — system machinery that shouldn't dominate the conversation view
  function classifyNoise(content) {
    if (content.includes('<task-notification>')) return 'task-notification';
    if (content.includes('<command-name>')) return 'slash-command';
    if (content.includes('<local-command-caveat>')) return 'command-caveat';
    if (content.includes('<local-command-stdout>') || content.includes('<local-command-stderr>')) return 'command-output';
    if (content.startsWith('Base directory for this skill:')) return 'skill-injection';
    if (content.startsWith('Launching skill:')) return 'skill-launch';
    if (content.startsWith('This session is being continued')) return 'compaction-summary';
    return null;
  }

  // Extract a short label for collapsed noise rendering
  function noiseSummary(content, noiseType) {
    switch (noiseType) {
      case 'task-notification': {
        const status = content.match(/<status>([^<]+)/)?.[1] || '';
        const summary = content.match(/<summary>([^<]+)/)?.[1] || '';
        return `agent ${status}${summary ? ': ' + summary.slice(0, 80) : ''}`;
      }
      case 'slash-command': {
        const cmd = content.match(/<command-name>([^<]+)/)?.[1] || '';
        return cmd;
      }
      case 'command-caveat':
        return 'local command output follows';
      case 'command-output': {
        const text = content.replace(/<[^>]+>/g, '').trim();
        return text.slice(0, 80) || 'command output';
      }
      case 'skill-injection': {
        const name = content.match(/^Base directory for this skill:[^\n]*\n+#\s*(.+)/m)?.[1] || 'skill';
        return `skill loaded: ${name}`;
      }
      case 'skill-launch': {
        const skill = content.match(/^Launching skill:\s*(.+)/)?.[1] || '';
        return `launching ${skill}`;
      }
      case 'compaction-summary':
        return 'session continuation summary';
      default:
        return null;
    }
  }

  // Filter to conversation entries (user, assistant, tool results)
  const messages = entries.filter(e =>
    e.type === 'user' || e.type === 'assistant' || e.type === 'progress'
  ).map(e => {
    const content = typeof e.message?.content === 'string'
      ? e.message.content
      : Array.isArray(e.message?.content)
        ? e.message.content
            .filter(b => b.type === 'text')
            .map(b => b.text)
            .join('\n')
        : e.data?.type || '';
    const noise = classifyNoise(content);
    return {
      uuid: e.uuid,
      type: e.type,
      timestamp: e.timestamp,
      role: e.message?.role || e.type,
      content,
      model: e.message?.model || '',
      toolUseID: e.toolUseID || '',
      parentToolUseID: e.parentToolUseID || '',
      isSidechain: e.isSidechain ?? false,
      agentId: e.agentId || '',
      noise,
      noiseSummary: noise ? noiseSummary(content, noise) : null,
    };
  }).filter(m => m.content);

  res.json({ path: resolved, messages, total: messages.length });
});

// ─── Transcript analysis (devtools-enriched metadata) ───────────────────────
//
// Returns token attribution, compaction events, and session summary for the
// Transcript Viewer enrichment UI. Degrades gracefully on any parse failure —
// the client treats a null summary as "no devtools data available."
//
// The three devtools-adapted modules are dynamically imported so a parse error
// in those modules won't take down the whole API server.

app.get('/api/transcript/analysis', async (req, res) => {
  const rawPath = req.query.path || '';
  if (!rawPath) return res.status(400).json({ error: 'path required' });

  const resolved = resolve(rawPath.replace(/^~/, homedir()));
  if (!resolved.startsWith(TRANSCRIPTS_DIR)) {
    return res.status(403).json({ error: 'path outside transcripts directory' });
  }

  try {
    const { parseJsonlFile, deduplicateByRequestId } = await import('../../src/lib/devtools-adapted/session-parser.js');
    const { computeTokenAttribution, estimateTokens } = await import('../../src/lib/devtools-adapted/token-attribution.js');
    const { detectCompactionPhases, checkMessagesOngoing } = await import('../../src/lib/devtools-adapted/compaction-detector.js');

    const messages = await parseJsonlFile(resolved);
    if (messages.length === 0) {
      return res.status(404).json({ error: 'transcript not found or empty' });
    }

    const attribution = computeTokenAttribution(messages);
    const { compactionCount, contextConsumption } = detectCompactionPhases(messages);

    // Walk messages to collect compaction event UUIDs with pre/post token counts.
    // The compaction summary is a user entry with isCompactSummary=true; the
    // preceding assistant message holds the pre-compaction token count.
    const compactionEvents = [];
    let lastAssistantInputTokens = 0;
    let awaitingPost = false;

    for (const msg of messages) {
      if (msg.isSidechain) continue;

      if (msg.type === 'assistant' && msg.model !== '<synthetic>') {
        const inputTokens =
          (msg.usage?.input_tokens ?? 0) +
          (msg.usage?.cache_read_input_tokens ?? 0) +
          (msg.usage?.cache_creation_input_tokens ?? 0);
        if (inputTokens > 0) {
          if (awaitingPost && compactionEvents.length > 0) {
            compactionEvents[compactionEvents.length - 1].postTokens = inputTokens;
            awaitingPost = false;
          }
          lastAssistantInputTokens = inputTokens;
        }
      }

      if (msg.isCompactSummary && msg.uuid) {
        compactionEvents.push({ uuid: msg.uuid, preTokens: lastAssistantInputTokens, postTokens: 0 });
        awaitingPost = true;
      }
    }

    // Per-message dominant category for sidebar filter.
    // Heuristic: assistant → thinkingText; user meta (tool results) → toolOutputs;
    // user with heavy system injections → claudeMd; otherwise → userMessages.
    const perMessageCategory = {};
    for (const msg of messages) {
      if (msg.isSidechain || !msg.uuid) continue;
      let cat = null;

      if (msg.type === 'assistant') {
        cat = 'thinkingText';
      } else if (msg.type === 'user') {
        if (msg.isMeta) {
          cat = 'toolOutputs';
        } else if (!msg.isCompactSummary) {
          const text = typeof msg.content === 'string'
            ? msg.content
            : Array.isArray(msg.content)
              ? msg.content.filter(b => b.type === 'text').map(b => b.text ?? '').join('')
              : '';
          const totalTok = estimateTokens(text);
          // Sum tokens inside <system-reminder>…</system-reminder> blocks
          const injectionTok = (text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/g) || [])
            .reduce((sum, s) => sum + estimateTokens(s), 0);
          cat = injectionTok > totalTok * 0.5 ? 'claudeMd' : 'userMessages';
        }
      }

      if (cat) perMessageCategory[msg.uuid] = cat;
    }

    // Session-level summary metrics
    const mainMessages = messages.filter(m => !m.isSidechain);
    const totalTurns = mainMessages.filter(m => m.type === 'user' || m.type === 'assistant').length;
    const toolCallCount = mainMessages.reduce((acc, msg) => {
      if (msg.type === 'assistant' && Array.isArray(msg.content)) {
        return acc + msg.content.filter(b => b.type === 'tool_use').length;
      }
      return acc;
    }, 0);

    // Timestamps are Date objects from session-parser
    const timestamps = mainMessages
      .map(m => m.timestamp)
      .filter(Boolean)
      .sort((a, b) => a - b);
    const duration = timestamps.length >= 2
      ? timestamps[timestamps.length - 1] - timestamps[0]
      : 0;

    const totalAttr = Object.values(attribution).reduce((a, b) => a + b, 0);
    const dominantCategory = totalAttr > 0
      ? Object.entries(attribution).sort((a, b) => b[1] - a[1])[0][0]
      : null;

    // Live session detection
    const isOngoing = checkMessagesOngoing(messages);

    // Cache hit ratio timeline — one entry per deduplicated assistant turn
    const dedupedAssistant = deduplicateByRequestId(
      messages.filter(m => !m.isSidechain && m.type === 'assistant')
    );
    const cacheTimeline = dedupedAssistant
      .filter(m => m.usage && (m.usage.input_tokens ?? 0) > 0)
      .map((m, i) => {
        const input = m.usage.input_tokens ?? 0;
        const cacheRead = m.usage.cache_read_input_tokens ?? 0;
        const cacheCreate = m.usage.cache_creation_input_tokens ?? 0;
        const total = input + cacheRead + cacheCreate;
        return { turn: i, ratio: total > 0 ? cacheRead / total : 0, inputTokens: input, cacheRead };
      });

    res.json({
      summary: {
        totalTurns,
        totalTokens: contextConsumption,
        dominantCategory,
        compactionCount,
        duration,
        toolCallCount,
      },
      attribution,
      compactionEvents,
      perMessageCategory,
      isOngoing,
      cacheTimeline,
    });
  } catch (err) {
    // Parse failure or missing devtools modules — return empty enrichment so
    // the Transcript Viewer falls back to its basic (unenriched) mode.
    console.error('[transcript/analysis]', err.message);
    res.json({ summary: null, attribution: null, compactionEvents: [], perMessageCategory: {} });
  }
});

// ─── Start ───
app.listen(PORT, '127.0.0.1', () => {
  console.log(`Cartographer API: http://127.0.0.1:${PORT}`);
  console.log(`Health: http://127.0.0.1:${PORT}/api/health`);
});
