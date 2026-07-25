#!/usr/bin/env node
/**
 * semantic-search.js — Search session events via Qdrant vector similarity.
 *
 * Usage:
 *   node scripts/semantic-search.js "what was the shader fix"
 *   node scripts/semantic-search.js "foveation paper" --project scrutinizer --limit 10
 *
 * Environment:
 *   CARTOGRAPHER_EMBED_URL    — embedding endpoint (default: http://localhost:8890/v1/embeddings)
 *   CARTOGRAPHER_EMBED_MODEL  — model name (default: mxbai-embed-large)
 *   CARTOGRAPHER_QDRANT_URL   — Qdrant endpoint (default: http://localhost:6333)
 *   CARTOGRAPHER_COLLECTION   — collection name (default: session-cartographer)
 */

const EMBED_URL = process.env.CARTOGRAPHER_EMBED_URL || 'http://localhost:8890/v1/embeddings';
const EMBED_MODEL = process.env.CARTOGRAPHER_EMBED_MODEL || 'mxbai-embed-large';
const QDRANT_URL = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';

// Parse args
const args = process.argv.slice(2);
let query = '';
let project = '';
let limit = 10;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project' && args[i + 1]) { project = args[++i]; }
  else if (args[i] === '--limit' && args[i + 1]) { limit = parseInt(args[++i], 10); }
  else if (!args[i].startsWith('--')) { query = args[i]; }
}

if (!query) {
  console.error('Usage: semantic-search.js "<query>" [--project NAME] [--limit N]');
  process.exit(1);
}

async function getEmbedding(text) {
  const response = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: `Represent this sentence for retrieval: ${text}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Embedding failed: ${response.status}`);
  }
  const data = await response.json();
  return data.data[0].embedding;
}

async function search(vector) {
  const body = {
    vector,
    limit,
    with_payload: true,
  };

  if (project) {
    body.filter = {
      must: [{ key: 'project', match: { value: project } }],
    };
  }

  const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Search failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.result || [];
}

async function main() {
  const vector = await getEmbedding(query);
  const results = await search(vector);

  if (results.length === 0) {
    console.log('No results found.');
    return;
  }

  console.log(`=== ${results.length} results for: "${query}" ===\n`);

  for (const hit of results) {
    const p = hit.payload;
    const score = hit.score.toFixed(3);
    const ts = p.timestamp || '?';
    const proj = p.project || '?';
    const src = p.source || '?';

    console.log(`[${ts}] [${src}] ${p.event_id || 'no-id'}  (score: ${score})`);
    console.log(`  ${p.summary || p.url || p.type || '?'}`);
    console.log(`  project: ${proj}`);
    if (p.url) console.log(`  url: ${p.url}`);
    if (p.deeplink) console.log(`  deeplink: ${p.deeplink}`);
    if (p.transcript_path) console.log(`  transcript: ${p.transcript_path}`);
    console.log('');
  }
}

main().catch(err => {
  console.error(err.message);
  process.exit(1);
});
