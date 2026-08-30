import { createHash } from 'node:crypto';
import { computeFacets, hybridSearch, parseTimeArg } from './search.js';
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
  const sinceMs = parseBound(request.since, 'since');
  const beforeMs = parseBound(request.before, 'before');

  const search = await hybridSearch(index, request.query, {
    project: request.project,
    sinceMs,
    beforeMs,
  });

  const excluded = new Set(request.excluded_event_ids);
  const eligible = search.items.filter((item) => !excluded.has(item.event_id));
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
      excluded_count: search.items.length - eligible.length,
    },
  };
}

export function recallHealth({ events, index }) {
  return {
    status: 'ok',
    contract_version: RECALL_CONTRACT_VERSION,
    backend: 'explorer',
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
