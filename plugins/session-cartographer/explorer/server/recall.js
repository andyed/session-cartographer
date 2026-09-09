import { createHash } from 'node:crypto';
import { computeFacets, hybridSearch, parseTimeArg } from './search.js';
import { CORPUS_ROOT } from './jsonl.js';
import {
  RECALL_CONTRACT_VERSION,
  RecallContractError,
  normalizeRecallRequest,
} from './recall-contract.js';

export function recallIndexGeneration(events, index) {
  const first = events[0] || {};
  const last = events[events.length - 1] || {};
  return createHash('sha256')
    .update([
      events.length,
      index.docs.size,
      first.event_id || first.timestamp || '',
      last.event_id || last.timestamp || '',
    ].join(':'))
    .digest('hex')
    .slice(0, 16);
}

function parseBound(value, field) {
  if (!value) return null;
  const parsed = parseTimeArg(value);
  if (parsed === null) {
    throw new RecallContractError(`cannot parse ${field} value '${value}'`);
  }
  return parsed;
}

export async function executeRecall({ events, index }, rawRequest) {
  const request = normalizeRecallRequest(rawRequest);
  if (request.corpus_root && request.corpus_root !== CORPUS_ROOT) {
    throw new RecallContractError(
      `this service indexes ${CORPUS_ROOT}, not ${request.corpus_root}`,
      409,
    );
  }
  const sinceMs = parseBound(request.since, 'since');
  const beforeMs = parseBound(request.before, 'before');

  const search = await hybridSearch(index, request.query, {
    project: request.project,
    sinceMs,
    beforeMs,
  });

  // 16% of the warm index used to carry no event_id — 18,103 rows read straight
  // from ~/.claude/history.jsonl. That source is gone: the prompts projector
  // covers the same content with stable ids, so this count is normally 0 now.
  // The guard stays because it is the contract boundary, not a workaround for
  // one source: any future writer that omits event_id must fail here, visibly,
  // rather than downstream. A single id-less row in a result set failed response
  // validation at the client, which discarded the ENTIRE answer and fell back to
  // the ~11 s portable search. A result with no id also cannot be fetched,
  // touched, or threaded, so it can never complete the recall workflow it
  // interrupted. Drop them here, at the boundary that owns the contract, and
  // report how many so the loss is visible rather than silent.
  const identified = search.items.filter((item) => typeof item.event_id === 'string' && item.event_id !== '');
  const unidentified = search.items.length - identified.length;

  const excluded = new Set(request.excluded_event_ids);
  const eligible = identified.filter((item) => !excluded.has(item.event_id));
  const results = eligible.slice(0, request.limit);

  return {
    contract_version: RECALL_CONTRACT_VERSION,
    backend: 'explorer',
    call_id: request.call_id,
    index_generation: recallIndexGeneration(events, index),
    index_lag_ms: null,
    results,
    facets: computeFacets(eligible.slice(0, 500)),
    stages_ms: search.stagesMs,
    semantic_status: search.semanticStatus,
    meta: {
      query: request.query,
      keyword_count: search.keywordCount,
      semantic_count: search.semanticCount,
      fused_count: search.fusedCount,
      eligible_count: eligible.length,
      excluded_count: identified.length - eligible.length,
      unidentified_count: unidentified,
    },
  };
}

export function recallHealth({ events, index }) {
  return {
    status: 'ok',
    contract_version: RECALL_CONTRACT_VERSION,
    backend: 'explorer',
    corpus_root: CORPUS_ROOT,
    events: events.length,
    indexed_docs: index.docs.size,
    index_generation: recallIndexGeneration(events, index),
    process: {
      pid: process.pid,
      rss: process.memoryUsage().rss,
      heap_used: process.memoryUsage().heapUsed,
    },
  };
}
