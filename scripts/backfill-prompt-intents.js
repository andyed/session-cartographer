#!/usr/bin/env node
/**
 * backfill-prompt-intents.js — Tag already-indexed transcript turns with a
 * prompt-intent, without re-embedding.
 *
 * reconstruct-history.js classifies turns as it indexes them, but turns that
 * were indexed before that wiring landed carry no `prompt_intent`. This script
 * patches them in place:
 *
 *   1. Scroll Qdrant for every `source: transcript` point → event_id → point_id.
 *   2. Walk the raw transcripts, reproduce reconstruct-history.js's turn
 *      boundaries exactly (each `user` message with content opens a turn),
 *      classify the human's opening prompt for each turn.
 *   3. Group matched point ids by intent and PUT the `prompt_intent` payload
 *      field via Qdrant's set-payload API — vectors are untouched, so the
 *      embeddings service is not required.
 *
 * Idempotent: re-running reclassifies and overwrites. Turns whose event_id is
 * not in the index (never indexed, or body too short to index) are skipped.
 *
 * Usage:
 *   node scripts/backfill-prompt-intents.js [--dry-run]
 *
 * Environment:
 *   CARTOGRAPHER_QDRANT_URL      — default: http://localhost:6333
 *   CARTOGRAPHER_COLLECTION      — default: session-cartographer
 *   CARTOGRAPHER_TRANSCRIPTS_DIR — default: ~/.claude/projects
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { classifyPromptIntent } from './classify-prompt-intent.js';

const DRY_RUN = process.argv.includes('--dry-run');
const QDRANT = process.env.CARTOGRAPHER_QDRANT_URL || 'http://localhost:6333';
const COLLECTION = process.env.CARTOGRAPHER_COLLECTION || 'session-cartographer';
const TRANSCRIPTS_DIR = process.env.CARTOGRAPHER_TRANSCRIPTS_DIR
  || path.join(process.env.HOME, '.claude/projects');

const SCROLL_PAGE = 10000;   // points per scroll request
const PAYLOAD_CHUNK = 500;   // point ids per set-payload request

async function qdrant(pathSuffix, body) {
  const res = await fetch(`${QDRANT}${pathSuffix}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Qdrant ${pathSuffix} → ${res.status} ${await res.text()}`);
  }
  return res.json();
}

// Scroll every transcript-turn point and map its event_id to its numeric id.
async function loadIndexedTurns() {
  const map = new Map();
  let offset = null;
  let pages = 0;
  do {
    const body = {
      limit: SCROLL_PAGE,
      with_payload: ['event_id'],
      with_vector: false,
      filter: { must: [{ key: 'source', match: { value: 'transcript' } }] },
    };
    if (offset != null) body.offset = offset;
    const { result } = await qdrant(
      `/collections/${COLLECTION}/points/scroll`, body);
    for (const pt of result.points) {
      const eid = pt.payload && pt.payload.event_id;
      if (eid) map.set(eid, pt.id);
    }
    offset = result.next_page_offset;
    pages++;
  } while (offset != null);
  console.log(`Scrolled ${map.size} transcript-turn points (${pages} page(s)).`);
  return map;
}

// Walk one transcript, yielding { eventId, intent } for each turn that has a
// human prompt. Turn boundaries mirror reconstruct-history.js: turnIdx is
// incremented for every `user` message that carries message.content.
function classifyTranscript(filePath, onTurn) {
  return new Promise((resolve) => {
    const sessionId = path.basename(filePath, '.jsonl');
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    let turnIdx = 0;
    let pendingEventId = null;
    let turnPrompt = '';

    const finalize = () => {
      if (pendingEventId && turnPrompt.trim()) {
        onTurn(pendingEventId, classifyPromptIntent(turnPrompt).key);
      }
      turnPrompt = '';
    };

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let entry;
      try { entry = JSON.parse(line); } catch { return; }

      // Only `user` messages with content open a turn and advance turnIdx.
      if (entry.type !== 'user' || !entry.message || !entry.message.content) return;

      finalize();
      turnIdx++;
      pendingEventId = `turn-${sessionId}-${turnIdx}`;

      // The human's prompt text — string content, or the joined text blocks.
      // tool_result blocks (Claude Code records tool output as a `user`
      // message) are neither text nor tool_use, so they leave the prompt
      // empty and the turn stays untagged.
      const content = entry.message.content;
      if (typeof content === 'string') {
        turnPrompt = content;
      } else if (Array.isArray(content)) {
        turnPrompt = content
          .filter((b) => b.type === 'text' && b.text)
          .map((b) => b.text)
          .join(' ');
      }
    });

    rl.on('close', () => { finalize(); resolve(); });
  });
}

async function run() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    console.error(`Transcripts dir not found: ${TRANSCRIPTS_DIR}`);
    process.exit(1);
  }

  let indexed;
  try {
    indexed = await loadIndexedTurns();
  } catch (e) {
    console.error(`Could not read Qdrant at ${QDRANT}: ${e.message}`);
    process.exit(1);
  }
  if (indexed.size === 0) {
    console.error('No transcript-turn points in the index — nothing to backfill.');
    process.exit(1);
  }

  // pointId → intent for every indexed turn we can classify.
  const idToIntent = new Map();
  let turnsSeen = 0;
  let turnsUnindexed = 0;

  const onTurn = (eventId, intent) => {
    turnsSeen++;
    const pointId = indexed.get(eventId);
    if (pointId === undefined) { turnsUnindexed++; return; }
    idToIntent.set(pointId, intent);
  };

  const projects = fs.readdirSync(TRANSCRIPTS_DIR);
  let fileCount = 0;
  for (const proj of projects) {
    const projPath = path.join(TRANSCRIPTS_DIR, proj);
    let stat;
    try { stat = fs.statSync(projPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(projPath)) {
      if (!file.endsWith('.jsonl')) continue;
      fileCount++;
      try {
        await classifyTranscript(path.join(projPath, file), onTurn);
      } catch (e) {
        console.warn(`  skip ${file}: ${e.message}`);
      }
    }
  }

  console.log(`Walked ${fileCount} transcripts — ${turnsSeen} turns with a prompt, ` +
    `${idToIntent.size} matched to indexed points, ${turnsUnindexed} not indexed (skipped).`);

  // Bucket point ids by intent for batched set-payload calls.
  const byIntent = new Map();
  for (const [pointId, intent] of idToIntent) {
    if (!byIntent.has(intent)) byIntent.set(intent, []);
    byIntent.get(intent).push(pointId);
  }

  const distribution = [...byIntent.entries()].sort((a, b) => b[1].length - a[1].length);
  console.log('\nIntent distribution:');
  for (const [intent, ids] of distribution) {
    const pct = (100 * ids.length / idToIntent.size).toFixed(1);
    console.log(`  ${intent.padEnd(22)} ${String(ids.length).padStart(7)}  (${pct}%)`);
  }

  if (DRY_RUN) {
    console.log('\n[dry-run] No payloads written. Re-run without --dry-run to apply.');
    return;
  }

  console.log('\nWriting prompt_intent payloads...');
  let patched = 0;
  let calls = 0;
  for (const [intent, ids] of byIntent) {
    for (let i = 0; i < ids.length; i += PAYLOAD_CHUNK) {
      const chunk = ids.slice(i, i + PAYLOAD_CHUNK);
      await qdrant(`/collections/${COLLECTION}/points/payload?wait=true`, {
        payload: { prompt_intent: intent },
        points: chunk,
      });
      patched += chunk.length;
      calls++;
    }
  }
  console.log(`Done — patched ${patched} points across ${calls} set-payload call(s).`);
}

run();
