// The facts contract is the only thing standing between a caller and a
// confidently wrong number. These tests assert the boundary refuses rather than
// guesses: a version it does not understand, a verb it cannot answer, a filter
// it would have to ignore, and above all a cursor it cannot verify.
//
// Hermetic by construction. CARTOGRAPHER_DEV_DIR is pointed at an empty temp
// directory before anything reads it, and the session-id chain is cleared —
// delta serving is real, and a harness that inherits a live session id changes
// what the code under test does. (CLAUDE.md: "Test harnesses must unset the
// session vars.")

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-facts-contract-'));
process.env.CARTOGRAPHER_DEV_DIR = FIXTURE_DIR;
process.on('exit', () => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

// Dynamic import: jsonl.js resolves LOG_FILES at module load from
// CARTOGRAPHER_DEV_DIR, and static imports are hoisted above the assignment
// above. Everything imported here must be imported after the env is set.
const {
  FACTS_CONTRACT_VERSION,
  FACTS_VERBS,
  FACTS_PROJECT_MAX,
  FACTS_TOP_MAX,
  FACTS_SAMPLE_MAX,
  FACTS_DELTA_BUDGET_MAX,
  FactsContractError,
  decodeCursor,
  encodeCursor,
  normalizeFactsRequest,
  validateFactsResponse,
} = await import('../../explorer/server/facts-contract.js');

function request(overrides = {}) {
  return {
    contract_version: FACTS_CONTRACT_VERSION,
    verb: 'census',
    call_id: 'call-facts-test',
    ...overrides,
  };
}

/** Assert `fn` throws a FactsContractError, and return it for further checks. */
function rejects(fn, message = 'expected a contract rejection') {
  let thrown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, message);
  assert.ok(thrown instanceof FactsContractError, `expected FactsContractError, got ${thrown?.name}: ${thrown?.message}`);
  return thrown;
}

// --------------------------------------------------------------------------
// Request shape
// --------------------------------------------------------------------------

test('a contract_version mismatch is 409, not 400', () => {
  // 400 says "you sent something malformed"; 409 says "we do not agree on what
  // these fields mean". Only the second tells a caller to upgrade rather than
  // retry, so the distinction is load-bearing, not cosmetic.
  for (const version of [FACTS_CONTRACT_VERSION + 1, FACTS_CONTRACT_VERSION - 1, '1', undefined, null]) {
    const error = rejects(() => normalizeFactsRequest(request({ contract_version: version })),
      `contract_version ${String(version)} should be rejected`);
    assert.equal(error.status, 409, `contract_version ${String(version)} must be 409`);
    assert.match(error.message, /contract_version/);
  }
});

test('a request body that is not an object is rejected', () => {
  for (const body of [null, undefined, 'census', 42, ['census']]) {
    const error = rejects(() => normalizeFactsRequest(body));
    assert.equal(error.status, 400);
  }
});

test('an unsupported verb is rejected and the error names the supported verbs', () => {
  const error = rejects(() => normalizeFactsRequest(request({ verb: 'histogram' })));
  assert.equal(error.status, 400);
  assert.match(error.message, /histogram/);
  for (const verb of FACTS_VERBS) {
    assert.ok(error.message.includes(verb), `error should name the '${verb}' verb: ${error.message}`);
  }
  assert.deepEqual([...FACTS_VERBS], ['census', 'tempo', 'delta']);
});

test('an empty or missing verb is rejected', () => {
  rejects(() => normalizeFactsRequest(request({ verb: '' })));
  rejects(() => normalizeFactsRequest(request({ verb: undefined })));
  rejects(() => normalizeFactsRequest(request({ verb: 42 })));
});

test('call_id is required', () => {
  rejects(() => normalizeFactsRequest({ contract_version: FACTS_CONTRACT_VERSION, verb: 'census' }));
});

test('delta with since or before is rejected rather than silently ignored', () => {
  // A silently discarded filter is how a caller ends up trusting a narrowing
  // that never ran. The cursor IS the window for delta.
  for (const window of [{ since: '7d' }, { before: '2026-01-01' }, { since: '7d', before: '2026-01-01' }]) {
    const error = rejects(() => normalizeFactsRequest(request({ verb: 'delta', ...window })),
      `delta + ${JSON.stringify(window)} should be rejected`);
    assert.equal(error.status, 400);
    assert.match(error.message, /cursor/);
    assert.match(error.message, /since\/before/);
  }
  // ...and delta without a window is fine.
  const ok = normalizeFactsRequest(request({ verb: 'delta' }));
  assert.equal(ok.verb, 'delta');
  assert.equal(ok.since, '');
  assert.equal(ok.before, '');
});

test('a cursor passed to census or tempo is rejected', () => {
  const cursor = encodeCursor({ corpusRoot: FIXTURE_DIR, positions: { changelog: { offset: 10, boundary: 'abc' } } });
  for (const verb of ['census', 'tempo']) {
    const error = rejects(() => normalizeFactsRequest(request({ verb, cursor })));
    assert.equal(error.status, 400);
    assert.match(error.message, new RegExp(verb));
    assert.match(error.message, /cursor/);
  }
  // The same cursor is accepted for delta.
  assert.equal(normalizeFactsRequest(request({ verb: 'delta', cursor })).cursor, cursor);
});

test('census and tempo keep their time window', () => {
  const normalized = normalizeFactsRequest(request({ verb: 'tempo', since: '7d', before: '2026-01-01' }));
  assert.equal(normalized.since, '7d');
  assert.equal(normalized.before, '2026-01-01');
});

// --------------------------------------------------------------------------
// Bounds
// --------------------------------------------------------------------------

test('project spec is accepted at FACTS_PROJECT_MAX and rejected above it', () => {
  // Callers pass a pipe-delimited alternation of every alias a family expands
  // to, so the bound has to admit a genuinely long spec.
  const atMax = 'a'.repeat(FACTS_PROJECT_MAX);
  assert.equal(normalizeFactsRequest(request({ project: atMax })).project.length, FACTS_PROJECT_MAX);
  const overMax = 'a'.repeat(FACTS_PROJECT_MAX + 1);
  const error = rejects(() => normalizeFactsRequest(request({ project: overMax })));
  assert.equal(error.status, 400);
  assert.match(error.message, /project/);
  // An empty project means "no scope", not a malformed one.
  assert.equal(normalizeFactsRequest(request({ project: '' })).project, '');
  rejects(() => normalizeFactsRequest(request({ project: 12 })));
});

const BOUNDS = [
  { field: 'top', min: 1, max: FACTS_TOP_MAX, fallback: 20 },
  { field: 'sample', min: 0, max: FACTS_SAMPLE_MAX, fallback: 3 },
  { field: 'budget', min: 1, max: FACTS_DELTA_BUDGET_MAX, fallback: 200 },
];

for (const { field, min, max, fallback } of BOUNDS) {
  test(`${field} is bounded at [${min}, ${max}]`, () => {
    assert.equal(normalizeFactsRequest(request({ [field]: min }))[field], min, `${field} min must be accepted`);
    assert.equal(normalizeFactsRequest(request({ [field]: max }))[field], max, `${field} max must be accepted`);
    assert.equal(normalizeFactsRequest(request({}))[field], fallback, `${field} should default to ${fallback}`);

    for (const bad of [max + 1, min - 1, min + 0.5, 'many', NaN, Infinity, {}]) {
      const error = rejects(() => normalizeFactsRequest(request({ [field]: bad })),
        `${field}=${String(bad)} should be rejected`);
      assert.equal(error.status, 400);
      assert.match(error.message, new RegExp(`^${field} must be an integer from ${min} to ${max}$`));
    }
  });
}

test('purpose is constrained to an identifier', () => {
  assert.equal(normalizeFactsRequest(request({ purpose: 'daily-pulse' })).purpose, 'daily-pulse');
  assert.equal(normalizeFactsRequest(request({})).purpose, 'facts');
  rejects(() => normalizeFactsRequest(request({ purpose: 'daily pulse; rm -rf' })));
});

// --------------------------------------------------------------------------
// Cursor
// --------------------------------------------------------------------------

test('encodeCursor -> decodeCursor round-trips positions exactly', () => {
  const positions = {
    changelog: { offset: 12345, boundary: 'a'.repeat(40) },
    research: { offset: 0, boundary: '' },
    milestones: { offset: 7, boundary: 'deadbeef' },
    'tool-use': { offset: 999999, boundary: 'cafebabe' },
    prompts: { offset: 1, boundary: 'f00d' },
  };
  const token = encodeCursor({ corpusRoot: FIXTURE_DIR, positions });
  assert.equal(typeof token, 'string');
  assert.doesNotMatch(token, /[^A-Za-z0-9_-]/, 'cursor should be base64url and URL-safe');
  assert.deepEqual(decodeCursor(token, { corpusRoot: FIXTURE_DIR }), positions);
});

test('a cursor issued for a different corpus_root is rejected 409', () => {
  const token = encodeCursor({
    corpusRoot: '/somewhere/else',
    positions: { changelog: { offset: 5, boundary: 'x' } },
  });
  const error = rejects(() => decodeCursor(token, { corpusRoot: FIXTURE_DIR }));
  assert.equal(error.status, 409);
  assert.match(error.message, /somewhere\/else/);
  assert.ok(error.message.includes(FIXTURE_DIR));
});

test('a cursor with an unsupported version is rejected 409', () => {
  for (const version of [FACTS_CONTRACT_VERSION + 1, 0, '1', null, undefined]) {
    const token = Buffer.from(
      JSON.stringify({ v: version, corpus: FIXTURE_DIR, pos: { changelog: { offset: 1, boundary: '' } } }),
      'utf-8',
    ).toString('base64url');
    const error = rejects(() => decodeCursor(token, { corpusRoot: FIXTURE_DIR }),
      `cursor version ${String(version)} should be rejected`);
    assert.equal(error.status, 409, `cursor version ${String(version)} must be 409`);
    assert.match(error.message, /contract_version/);
  }
});

test('a garbage cursor is rejected outright, never read as "start from now"', () => {
  // The dangerous failure is not an exception, it is a shrug: a cursor that
  // cannot be decoded must not degrade into a fresh baseline, because that
  // silently drops everything appended since the caller's last real position
  // and reports it as "nothing new".
  const garbage = [
    ['empty string', ''],
    ['non-base64 text', '!!! not a cursor !!!'],
    ['plain word', 'cursor'],
    ['base64 of non-JSON', Buffer.from('this is not json', 'utf-8').toString('base64url')],
    ['base64 of a JSON array', Buffer.from('[1,2,3]', 'utf-8').toString('base64url')],
    ['base64 of JSON null', Buffer.from('null', 'utf-8').toString('base64url')],
    ['base64 of a JSON number', Buffer.from('5', 'utf-8').toString('base64url')],
    ['base64 of a JSON string', Buffer.from('"hello"', 'utf-8').toString('base64url')],
    ['truncated payload', encodeCursor({ corpusRoot: FIXTURE_DIR, positions: {} }).slice(0, 6)],
    ['no positions', Buffer.from(JSON.stringify({ v: FACTS_CONTRACT_VERSION, corpus: FIXTURE_DIR }), 'utf-8').toString('base64url')],
    ['positions is an array', Buffer.from(JSON.stringify({ v: FACTS_CONTRACT_VERSION, corpus: FIXTURE_DIR, pos: [] }), 'utf-8').toString('base64url')],
    ['negative offset', Buffer.from(JSON.stringify({ v: FACTS_CONTRACT_VERSION, corpus: FIXTURE_DIR, pos: { changelog: { offset: -1 } } }), 'utf-8').toString('base64url')],
    ['non-numeric offset', Buffer.from(JSON.stringify({ v: FACTS_CONTRACT_VERSION, corpus: FIXTURE_DIR, pos: { changelog: { offset: 'end' } } }), 'utf-8').toString('base64url')],
    ['null position', Buffer.from(JSON.stringify({ v: FACTS_CONTRACT_VERSION, corpus: FIXTURE_DIR, pos: { changelog: null } }), 'utf-8').toString('base64url')],
  ];

  for (const [label, token] of garbage) {
    let returned = Symbol('not-returned');
    let thrown = null;
    try {
      returned = decodeCursor(token, { corpusRoot: FIXTURE_DIR });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown, `${label}: must throw rather than return anything`);
    assert.ok(thrown instanceof FactsContractError, `${label}: should be a FactsContractError`);
    assert.equal(typeof returned, 'symbol', `${label}: must not return positions`);
  }
});

test('a well-formed cursor with no corpus claim is accepted against any corpus', () => {
  // Only a *conflicting* corpus is a 409; an unstamped legacy token still has
  // to decode, or every held cursor would break on upgrade.
  const token = Buffer.from(
    JSON.stringify({ v: FACTS_CONTRACT_VERSION, pos: { changelog: { offset: 3, boundary: '' } } }),
    'utf-8',
  ).toString('base64url');
  assert.deepEqual(decodeCursor(token, { corpusRoot: FIXTURE_DIR }), { changelog: { offset: 3, boundary: '' } });
});

// --------------------------------------------------------------------------
// Response validation
// --------------------------------------------------------------------------

function response(overrides = {}) {
  return {
    contract_version: FACTS_CONTRACT_VERSION,
    backend: 'explorer',
    verb: 'census',
    facts: { events: 0 },
    stages_ms: { scan: 0.1, total: 0.2 },
    ...overrides,
  };
}

test('a well-formed facts response validates', () => {
  const raw = response();
  assert.equal(validateFactsResponse(raw), raw);
  const deltaResponse = response({ verb: 'delta', facts: { cursor: 'abc', events: [] } });
  assert.equal(validateFactsResponse(deltaResponse), deltaResponse);
});

test('validateFactsResponse rejects a malformed response as 502', () => {
  const cases = [
    ['not an object', null],
    ['array body', []],
    ['wrong contract_version', response({ contract_version: FACTS_CONTRACT_VERSION + 1 })],
    ['missing contract_version', response({ contract_version: undefined })],
    ['wrong backend', response({ backend: 'qdrant' })],
    ['missing backend', response({ backend: undefined })],
    ['unsupported verb', response({ verb: 'histogram' })],
    ['missing facts', response({ facts: undefined })],
    ['non-object facts', response({ facts: 'lots' })],
    ['missing stages_ms', response({ stages_ms: undefined })],
    ['missing stages_ms.total', response({ stages_ms: { scan: 1 } })],
    ['non-numeric stages_ms.total', response({ stages_ms: { scan: 1, total: '2' } })],
    ['delta with no cursor', response({ verb: 'delta', facts: { events: [] } })],
    ['delta with a non-string cursor', response({ verb: 'delta', facts: { cursor: 12 } })],
  ];

  for (const [label, body] of cases) {
    const error = rejects(() => validateFactsResponse(body), `${label}: should be rejected`);
    assert.equal(error.status, 502, `${label}: a bad response from the backend is 502`);
  }
});
