/**
 * The facts contract.
 *
 * `/api/recall` answers "which records are relevant to this phrase." This
 * answers "what is true of the corpus." They are different questions with
 * different loss functions, and conflating them is not a tuning problem:
 * a ranking engine asked a census question — "what happened yesterday" — has no
 * relevance gradient to work with, so it returns *an* answer with no way for
 * the caller to know it is not *the* answer. The measured case: FrakBot's daily
 * pulse surfaced 1 event from a window that deterministically contained 736
 * events across 22 sessions and 20 commits.
 *
 * So the split is deliberate. Ranking owns judgment about relevance. Facts own
 * counting, and counting is not a judgment — it is either right or wrong, and
 * it must be checkable. Every bucket therefore carries a sample of the
 * `event_id`s it counted, so the caller can verify any number with
 * `cartographer-search.sh --get` instead of trusting it. A deterministic answer
 * that is silently wrong is strictly worse than a slow one.
 */

export const FACTS_CONTRACT_VERSION = 1;

/** The questions this endpoint will answer. Anything else is rejected, not guessed. */
export const FACTS_VERBS = Object.freeze(['census', 'tempo', 'delta']);

export class FactsContractError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'FactsContractError';
    this.status = status;
  }
}

// Matches RECALL_PROJECT_MAX. `project` is not one name: callers pass a
// pipe-delimited alternation of every alias a project expands to, and FrakBot's
// feed alone expands 20 names into 37 aliases packing to 576 characters. A
// tighter bound here would reject the exact caller this endpoint is for.
export const FACTS_PROJECT_MAX = 2048;

// Buckets returned per dimension. Generous enough to cover every project in the
// corpus at once (the registry is well under this), bounded so a response
// cannot grow with the corpus.
export const FACTS_TOP_MAX = 200;

// Ceiling on the event ids attached to each bucket as an audit sample. The
// request default is 3 — enough to spot check a count, cheap enough to attach
// to every bucket of every dimension. This is the most a caller may ask for.
export const FACTS_SAMPLE_MAX = 10;

// Events returned by one `delta` call. The cursor advances only past what is
// returned, so a saturated delta is resumable rather than lossy — this is a
// page size, not a ceiling on what can be recovered.
export const FACTS_DELTA_BUDGET_MAX = 2000;

function requireString(value, field, { allowEmpty = false, max = 4096 } = {}) {
  if (typeof value !== 'string') {
    throw new FactsContractError(`${field} must be a string`);
  }
  if (!allowEmpty && value.trim() === '') {
    throw new FactsContractError(`${field} must not be empty`);
  }
  if (value.length > max) {
    throw new FactsContractError(`${field} is too long`);
  }
  return value;
}

function requireInt(value, field, { min, max, fallback }) {
  const raw = value ?? fallback;
  // `Number()` alone is not the type check the error message promises: it turns
  // `[5]` into 5, `true` into 1, and `[]` into 0, so a caller passing the wrong
  // shape gets a silently invented value inside the valid range rather than a
  // rejection. Bounds would still hold; the request would just not be the one
  // the caller wrote.
  if (typeof raw !== 'number' && typeof raw !== 'string') {
    throw new FactsContractError(`${field} must be an integer from ${min} to ${max}`);
  }
  if (typeof raw === 'string' && raw.trim() === '') {
    throw new FactsContractError(`${field} must be an integer from ${min} to ${max}`);
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new FactsContractError(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

/**
 * Encode a delta cursor.
 *
 * The cursor is opaque on purpose. It is a set of per-log byte offsets plus the
 * boundary fingerprints that prove those offsets still mean what they meant,
 * and a caller that parsed and edited it would be constructing a claim about
 * the logs that nothing verified. Callers store the token and hand it back.
 *
 * It carries `corpus_root` because the offsets are meaningless against a
 * different corpus, and a wrong-corpus delta would look authoritative — the
 * same failure `corpus_root` guards against in the recall contract.
 */
export function encodeCursor({ corpusRoot, positions }) {
  const payload = JSON.stringify({ v: FACTS_CONTRACT_VERSION, corpus: corpusRoot, pos: positions });
  return Buffer.from(payload, 'utf-8').toString('base64url');
}

/** Decode a delta cursor, or throw. A malformed cursor is never treated as "start from now". */
export function decodeCursor(token, { corpusRoot }) {
  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf-8'));
  } catch {
    throw new FactsContractError('cursor is not a valid facts cursor');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new FactsContractError('cursor is not a valid facts cursor');
  }
  if (decoded.v !== FACTS_CONTRACT_VERSION) {
    throw new FactsContractError(`cursor contract_version ${String(decoded.v)} is not supported`, 409);
  }
  // Silently answering from the wrong corpus is the failure mode worth being
  // loud about: the offsets would resolve, the response would validate, and the
  // numbers would describe someone else's machine.
  if (decoded.corpus && corpusRoot && decoded.corpus !== corpusRoot) {
    throw new FactsContractError(
      `cursor was issued for ${decoded.corpus}, but this service indexes ${corpusRoot}`,
      409,
    );
  }
  if (!decoded.pos || typeof decoded.pos !== 'object' || Array.isArray(decoded.pos)) {
    throw new FactsContractError('cursor carries no positions');
  }
  for (const [source, position] of Object.entries(decoded.pos)) {
    if (!position || typeof position.offset !== 'number' || position.offset < 0) {
      throw new FactsContractError(`cursor position for ${source} is malformed`);
    }
  }
  return decoded.pos;
}

export function normalizeFactsRequest(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FactsContractError('request body must be an object');
  }
  if (raw.contract_version !== FACTS_CONTRACT_VERSION) {
    throw new FactsContractError(
      `unsupported contract_version ${String(raw.contract_version)}`,
      409,
    );
  }

  const verb = requireString(raw.verb ?? '', 'verb', { max: 32 });
  if (!FACTS_VERBS.includes(verb)) {
    throw new FactsContractError(
      `unsupported verb '${verb}'; this service answers ${FACTS_VERBS.join(', ')}`,
    );
  }

  const purpose = requireString(raw.purpose ?? 'facts', 'purpose', { max: 64 });
  if (!/^[A-Za-z0-9_-]+$/.test(purpose)) {
    throw new FactsContractError('purpose contains unsupported characters');
  }

  const request = {
    contract_version: FACTS_CONTRACT_VERSION,
    verb,
    call_id: requireString(raw.call_id, 'call_id', { max: 160 }),
    project: requireString(raw.project ?? '', 'project', { allowEmpty: true, max: FACTS_PROJECT_MAX }),
    since: requireString(raw.since ?? '', 'since', { allowEmpty: true, max: 128 }),
    before: requireString(raw.before ?? '', 'before', { allowEmpty: true, max: 128 }),
    top: requireInt(raw.top, 'top', { min: 1, max: FACTS_TOP_MAX, fallback: 20 }),
    sample: requireInt(raw.sample, 'sample', { min: 0, max: FACTS_SAMPLE_MAX, fallback: 3 }),
    budget: requireInt(raw.budget, 'budget', { min: 1, max: FACTS_DELTA_BUDGET_MAX, fallback: 200 }),
    purpose,
    corpus_root: requireString(raw.corpus_root ?? '', 'corpus_root', { allowEmpty: true, max: 4096 }),
    cursor: requireString(raw.cursor ?? '', 'cursor', { allowEmpty: true, max: 65536 }),
  };

  // A window is meaningless for `delta` — the cursor *is* the window, and
  // accepting both would invite a caller to believe a `since` narrowed a delta
  // when it did not. Reject rather than ignore: a silently discarded parameter
  // is how a caller ends up trusting a filter that never ran.
  if (verb === 'delta' && (request.since || request.before)) {
    throw new FactsContractError(
      'delta is bounded by cursor, not by since/before; omit the time window',
    );
  }
  if (verb !== 'delta' && request.cursor) {
    throw new FactsContractError(`cursor is only meaningful for delta, not ${verb}`);
  }

  return request;
}

export function validateFactsResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FactsContractError('response body must be an object', 502);
  }
  if (raw.contract_version !== FACTS_CONTRACT_VERSION) {
    throw new FactsContractError('response contract_version mismatch', 502);
  }
  if (raw.backend !== 'explorer') {
    throw new FactsContractError('response backend must be explorer', 502);
  }
  if (!FACTS_VERBS.includes(raw.verb)) {
    throw new FactsContractError('response verb is not a supported fact', 502);
  }
  if (!raw.facts || typeof raw.facts !== 'object') {
    throw new FactsContractError('response carries no facts', 502);
  }
  if (!raw.stages_ms || typeof raw.stages_ms.total !== 'number') {
    throw new FactsContractError('response stages_ms.total is required', 502);
  }
  if (raw.verb === 'delta' && typeof raw.facts.cursor !== 'string') {
    throw new FactsContractError('delta response carries no cursor', 502);
  }
  return raw;
}
