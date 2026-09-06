export const RECALL_CONTRACT_VERSION = 1;

export class RecallContractError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'RecallContractError';
    this.status = status;
  }
}

function requireString(value, field, { allowEmpty = false, max = 4096 } = {}) {
  if (typeof value !== 'string') {
    throw new RecallContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw new RecallContractError(`${field} must not be empty`);
  }
  if (value.length > max) {
    throw new RecallContractError(`${field} is too long`);
  }
  return value;
}

// The ceiling tracks the largest limit a real caller asks for, not a round
// number. cartographer-feed.sh fans out across every active project and clamps
// its own search limit to 200; a ceiling of 100 rejected every feed run since
// Turbo shipped, and each rejection fell back to an ~11 s portable search. A
// rejection is the correct response to a limit above this, but the ceiling has
// to admit the callers that exist.
export const RECALL_LIMIT_MAX = 200;

// `project` is not one name: callers pass a pipe-delimited alternation of every
// alias a project expands to, and the bound has to cover the widest real
// allowlist rather than the widest single name. FrakBot's daily feed expands 20
// project names into 37 aliases packing to 576 characters — over the original
// 512-character cap, so the feed failed the contract on `project` even after
// the result ceiling was raised, and fell back to the ~11 s portable search
// exactly as before. This admits the whole project registry several times over
// and still sits far below the 1 MB request-body limit.
export const RECALL_PROJECT_MAX = 2048;

export function normalizeRecallRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RecallContractError('request body must be an object');
  }
  if (raw.contract_version !== RECALL_CONTRACT_VERSION) {
    throw new RecallContractError(
      `unsupported contract_version ${String(raw.contract_version)}`,
      409,
    );
  }

  const limit = Number(raw.limit ?? 15);
  if (!Number.isInteger(limit) || limit < 1 || limit > RECALL_LIMIT_MAX) {
    throw new RecallContractError(`limit must be an integer from 1 to ${RECALL_LIMIT_MAX}`);
  }


  const excluded = raw.excluded_event_ids ?? [];
  if (!Array.isArray(excluded) || excluded.length > 500) {
    throw new RecallContractError('excluded_event_ids must be an array of at most 500 ids');
  }
  const excludedEventIds = excluded.map((id) =>
    requireString(id, 'excluded_event_ids[]', { max: 512 }));

  const purpose = requireString(raw.purpose ?? 'remember', 'purpose', { max: 64 });
  if (!/^[A-Za-z0-9_-]+$/.test(purpose)) {
    throw new RecallContractError('purpose contains unsupported characters');
  }

  return {
    contract_version: RECALL_CONTRACT_VERSION,
    call_id: requireString(raw.call_id, 'call_id', { max: 160 }),
    query: requireString(raw.query, 'query'),
    project: requireString(raw.project ?? '', 'project', { allowEmpty: true, max: RECALL_PROJECT_MAX }),
    since: requireString(raw.since ?? '', 'since', { allowEmpty: true, max: 128 }),
    before: requireString(raw.before ?? '', 'before', { allowEmpty: true, max: 128 }),
    limit,
    purpose,
    session_id: requireString(raw.session_id ?? '', 'session_id', { allowEmpty: true, max: 256 }),
    provider: requireString(raw.provider ?? 'unknown', 'provider', { max: 64 }),
    // Optional corpus assertion. The warm service indexes one corpus, fixed when
    // it spawned, but it is reached by a fixed loopback port — so a caller that
    // set CARTOGRAPHER_DEV_DIR to a different corpus was silently answered from
    // the shared one. Wrong-corpus results are worse than slow results: they look
    // authoritative. Callers that know which corpus they mean say so, and old
    // callers that omit it keep working.
    corpus_root: requireString(raw.corpus_root ?? '', 'corpus_root', { allowEmpty: true, max: 4096 }),
    excluded_event_ids: [...new Set(excludedEventIds)],
  };
}

export function validateRecallResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RecallContractError('response body must be an object', 502);
  }
  if (raw.contract_version !== RECALL_CONTRACT_VERSION) {
    throw new RecallContractError('response contract_version mismatch', 502);
  }
  if (raw.backend !== 'explorer') {
    throw new RecallContractError('response backend must be explorer', 502);
  }
  if (!Array.isArray(raw.results)) {
    throw new RecallContractError('response results must be an array', 502);
  }
  for (const [index, result] of raw.results.entries()) {
    if (!result || typeof result !== 'object' || typeof result.event_id !== 'string') {
      throw new RecallContractError(`response result ${index} has no event_id`, 502);
    }
  }
  if (!raw.stages_ms || typeof raw.stages_ms.total !== 'number') {
    throw new RecallContractError('response stages_ms.total is required', 502);
  }
  return raw;
}
