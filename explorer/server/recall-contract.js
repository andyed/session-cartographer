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
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RecallContractError('limit must be an integer from 1 to 100');
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
    project: requireString(raw.project ?? '', 'project', { allowEmpty: true, max: 512 }),
    since: requireString(raw.since ?? '', 'since', { allowEmpty: true, max: 128 }),
    before: requireString(raw.before ?? '', 'before', { allowEmpty: true, max: 128 }),
    limit,
    purpose,
    session_id: requireString(raw.session_id ?? '', 'session_id', { allowEmpty: true, max: 256 }),
    provider: requireString(raw.provider ?? 'unknown', 'provider', { max: 64 }),
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
