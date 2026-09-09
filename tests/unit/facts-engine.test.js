// census/tempo/delta over synthetic fixtures. Counting is not a judgment call —
// it is either right or wrong — so these assert exact numbers, and above all
// that absence is reported as absence rather than folded into a bucket.
//
// Hermetic: CARTOGRAPHER_DEV_DIR is redirected to a temp directory before
// jsonl.js is imported (it resolves LOG_FILES at module load) and delta is
// always handed an explicit logFiles map. The session-id chain is cleared per
// CLAUDE.md — delta serving is real, and an inherited live session id changes
// what the code under test does.

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

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-facts-engine-'));
process.env.CARTOGRAPHER_DEV_DIR = FIXTURE_DIR;
process.on('exit', () => { try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }); } catch {} });

const { census, tempo, delta, executeFacts } = await import('../../explorer/server/facts.js');
const { normalizeFactsRequest, FactsContractError } = await import('../../explorer/server/facts-contract.js');
const { logPositions } = await import('../../explorer/server/jsonl.js');
const { utcDay } = await import('../../explorer/server/event-time.js');

function request(overrides = {}) {
  return normalizeFactsRequest({
    contract_version: 1,
    verb: 'census',
    call_id: 'call-facts-engine',
    ...overrides,
  });
}

const bucket = (list, name) => list.find((row) => row.name === name) || null;
const names = (list) => list.map((row) => row.name);

let caseCounter = 0;
function workspace() {
  caseCounter += 1;
  const dir = path.join(FIXTURE_DIR, `case-${caseCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --------------------------------------------------------------------------
// census
// --------------------------------------------------------------------------

test('census counts by project, type, source, and provider', () => {
  const events = [
    { event_id: 'e1', timestamp: '2026-05-10T12:00:00Z', project: 'alpha', type: 'git_commit', _source: 'changelog', provider: 'claude', session_id: 's1', summary: 'commit one' },
    { event_id: 'e2', timestamp: '2026-05-10T13:00:00Z', project: 'alpha', type: 'git_commit', _source: 'changelog', provider: 'claude', session_id: 's1', summary: 'commit two' },
    { event_id: 'e3', timestamp: '2026-05-11T12:00:00Z', project: 'alpha', type: 'web_fetch', _source: 'research', provider: 'codex', session_id: 's2' },
    { event_id: 'e4', timestamp: '2026-05-12T12:00:00Z', project: 'beta', type: 'web_fetch', _source: 'research', provider: 'codex', session_id: 's3' },
    { event_id: 'e5', timestamp: '2026-05-13T12:00:00Z', project: 'beta', type: 'file_edit', _source: 'tool-use', provider: 'claude', session_id: 's3' },
  ];

  const facts = census(events, request());
  assert.equal(facts.events, 5);
  assert.equal(facts.windowed_out, 0);
  assert.equal(facts.undated_dropped, 0);
  assert.deepEqual(facts.by_project.map((row) => [row.name, row.count]), [['alpha', 3], ['beta', 2]]);
  assert.deepEqual(facts.by_type.map((row) => [row.name, row.count]), [['git_commit', 2], ['web_fetch', 2], ['file_edit', 1]]);
  assert.deepEqual(facts.by_source.map((row) => [row.name, row.count]), [['changelog', 2], ['research', 2], ['tool-use', 1]]);
  assert.deepEqual(facts.by_provider.map((row) => [row.name, row.count]), [['claude', 3], ['codex', 2]]);
  assert.equal(facts.sessions.resolved, 3);
  // Every dimension census buckets on carries its own unattributed counter,
  // `source` included, so the buckets in each dimension always reconcile
  // against `facts.events`.
  assert.deepEqual(facts.unattributed, { project: 0, session: 0, provider: 0, type: 0, source: 0, event_id: 0 });
  assert.equal(facts.span.oldest, '2026-05-10T12:00:00.000Z');
  assert.equal(facts.span.newest, '2026-05-13T12:00:00.000Z');
  // git_* rows are the highest-confidence deterministic facts in the corpus.
  assert.deepEqual(facts.commits.map((row) => row.event_id), ['e1', 'e2']);
});

test('census counts a windowed subset and reports what fell outside', () => {
  const events = [
    { event_id: 'old', timestamp: '2026-04-01T12:00:00Z', project: 'alpha' },
    { event_id: 'inside', timestamp: '2026-05-10T12:00:00Z', project: 'alpha' },
    { event_id: 'later', timestamp: '2026-06-20T12:00:00Z', project: 'alpha' },
  ];
  const facts = census(events, request({ since: '2026-05-01', before: '2026-05-31' }));
  assert.equal(facts.events, 1);
  assert.equal(facts.windowed_out, 2);
  assert.equal(bucket(facts.by_project, 'alpha').count, 1);
});

test('sentinel session ids are unattributed, never a phantom session', () => {
  // CLAUDE.md: `"unknown"` is truthy and equal to itself, so a naive groupBy
  // merges every unattributed record into one phantom entity. Nothing errors;
  // the numbers are just wrong — that phantom overstated a recovery rate by 54%
  // during the 0.5.0 repair. All three spellings of absence must count as
  // absence, and none of them may become a bucket.
  const events = [
    { event_id: 'r1', timestamp: '2026-05-10T12:00:00Z', project: 'alpha', session_id: 'sess-real-a' },
    { event_id: 'r2', timestamp: '2026-05-10T12:01:00Z', project: 'alpha', session_id: 'sess-real-a' },
    { event_id: 'r3', timestamp: '2026-05-10T12:02:00Z', project: 'alpha', session_id: 'sess-real-b' },
    { event_id: 'u-empty', timestamp: '2026-05-10T12:03:00Z', project: 'alpha', session_id: '' },
    { event_id: 'u-unknown', timestamp: '2026-05-10T12:04:00Z', project: 'alpha', session_id: 'unknown' },
    { event_id: 'u-null', timestamp: '2026-05-10T12:05:00Z', project: 'alpha', session_id: null },
  ];

  const facts = census(events, request());
  assert.equal(facts.events, 6);
  assert.equal(
    facts.unattributed.session, 3,
    'session_id "", "unknown" and null must all count as unattributed',
  );
  assert.equal(
    facts.sessions.resolved, 2,
    'resolved sessions must exclude every spelling of absence — 3 would be the phantom',
  );
  // The session dimension must expose a count and nothing groupable by a
  // sentinel: no bucket list where "unknown" could appear as an entity.
  assert.deepEqual(Object.keys(facts.sessions), ['resolved']);
  assert.equal(JSON.stringify(facts.sessions).includes('unknown'), false);
});

test('sentinel project, provider, type and event_id values are unattributed, not buckets', () => {
  const events = [
    { event_id: 'e1', timestamp: '2026-05-10T12:00:00Z', project: 'alpha', provider: 'claude', type: 'git_commit' },
    { event_id: '', timestamp: '2026-05-10T12:01:00Z', project: '', provider: '', type: '' },
    { event_id: 'unknown', timestamp: '2026-05-10T12:02:00Z', project: 'unknown', provider: 'unknown', type: 'unknown' },
    { event_id: null, timestamp: '2026-05-10T12:03:00Z', project: null, provider: null, type: null },
  ];

  const facts = census(events, request());
  assert.equal(facts.events, 4);
  assert.equal(facts.unattributed.project, 3);
  assert.equal(facts.unattributed.provider, 3);
  assert.equal(facts.unattributed.type, 3);
  assert.equal(facts.unattributed.event_id, 3);
  assert.deepEqual(names(facts.by_project), ['alpha']);
  assert.deepEqual(names(facts.by_provider), ['claude']);
  assert.deepEqual(names(facts.by_type), ['git_commit']);
  for (const list of [facts.by_project, facts.by_provider, facts.by_type, facts.by_source]) {
    assert.equal(bucket(list, 'unknown'), null, 'a sentinel must never become an entity');
    assert.equal(bucket(list, ''), null, 'a sentinel must never become an entity');
  }
});

test('event type falls back across type -> event -> milestone', () => {
  // milestones write `event`/`milestone`, changelog writes `type`. Hardcoding
  // one field makes whole sources vanish from a breakdown while the totals
  // still look plausible.
  const events = [
    { event_id: 'e1', timestamp: '2026-05-10T12:00:00Z', project: 'alpha', type: 'git_commit' },
    { event_id: 'e2', timestamp: '2026-05-10T12:01:00Z', project: 'alpha', event: 'session_end' },
    { event_id: 'e3', timestamp: '2026-05-10T12:02:00Z', project: 'alpha', milestone: 'compaction' },
    { event_id: 'e4', timestamp: '2026-05-10T12:03:00Z', project: 'alpha', type: '', event: 'agent_stop' },
    { event_id: 'e5', timestamp: '2026-05-10T12:04:00Z', project: 'alpha', type: 'unknown', event: null, milestone: 'wrapup' },
    { event_id: 'e6', timestamp: '2026-05-10T12:05:00Z', project: 'alpha' },
  ];

  const facts = census(events, request());
  assert.deepEqual(
    names(facts.by_type).sort(),
    ['agent_stop', 'compaction', 'git_commit', 'session_end', 'wrapup'],
  );
  assert.equal(bucket(facts.by_type, 'agent_stop').count, 1, 'an empty `type` must fall through to `event`');
  assert.equal(bucket(facts.by_type, 'wrapup').count, 1, 'a sentinel `type` must fall through to `milestone`');
  assert.equal(facts.unattributed.type, 1, 'only the event with no type field at all is unattributed');
});

test('an unparseable timestamp is dropped from a windowed census, never defaulted into it', () => {
  const events = [
    { event_id: 'dated', timestamp: '2026-05-10T12:00:00Z', project: 'alpha' },
    { event_id: 'undated-1', project: 'ghost' },
    { event_id: 'undated-2', timestamp: 'sometime last tuesday', project: 'ghost' },
    { event_id: 'undated-3', timestamp: '', project: 'ghost' },
  ];

  const windowed = census(events, request({ since: '2026-05-01', before: '2026-05-31' }));
  assert.equal(windowed.undated_dropped, 3);
  assert.equal(windowed.events, 1, 'an undated row cannot honestly be placed inside a window');
  assert.equal(windowed.windowed_out, 0, 'undated rows are dropped, not windowed out');
  assert.equal(
    bucket(windowed.by_project, 'ghost'), null,
    'an undated row must never be defaulted into the most recent window',
  );
  assert.equal(windowed.span.oldest, '2026-05-10T12:00:00.000Z');
  assert.equal(windowed.span.newest, '2026-05-10T12:00:00.000Z');

  // With no window there is nothing to place them inside or outside of, so they
  // are counted normally.
  const unwindowed = census(events, request());
  assert.equal(unwindowed.undated_dropped, 0);
  assert.equal(unwindowed.events, 4);
  assert.equal(bucket(unwindowed.by_project, 'ghost').count, 3);
});

test('project matching is substring and case-insensitive over a pipe-delimited spec', () => {
  // Matches bm25.js. A family name has to select its repositories, or a census
  // and a recall over the same --project would disagree about scope.
  const events = [
    { event_id: 'e1', timestamp: '2026-05-10T12:00:00Z', project: 'Psychodeli-WebGL-Port' },
    { event_id: 'e2', timestamp: '2026-05-10T12:01:00Z', project: 'psychodeli-metal' },
    { event_id: 'e3', timestamp: '2026-05-10T12:02:00Z', project: 'scrutinizer' },
    { event_id: 'e4', timestamp: '2026-05-10T12:03:00Z', project: '' },
  ];

  assert.equal(census(events, request({ project: 'psychodeli' })).events, 2);
  assert.equal(census(events, request({ project: 'PSYCHODELI' })).events, 2, 'matching is case-insensitive');
  assert.equal(census(events, request({ project: 'nope|scrutinizer' })).events, 1);
  assert.equal(census(events, request({ project: 'psychodeli|scrutinizer' })).events, 3);
  assert.equal(census(events, request({ project: 'nothing-here' })).events, 0);
  assert.equal(census(events, request({ project: '' })).events, 4, 'no scope requested, no scope applied');
});

test('every bucket carries event ids up to `sample`, and sample 0 omits them', () => {
  // Every number has to be checkable with `cartographer-search.sh --get`; a
  // deterministic answer that is silently wrong is worse than a slow one.
  const events = Array.from({ length: 5 }, (_, i) => ({
    event_id: `e${i + 1}`,
    timestamp: `2026-05-10T12:0${i}:00Z`,
    project: 'alpha',
    type: 'git_commit',
    _source: 'changelog',
    provider: 'claude',
  }));

  const sampled = census(events, request({ sample: 2 }));
  for (const list of [sampled.by_project, sampled.by_type, sampled.by_source, sampled.by_provider]) {
    for (const row of list) {
      assert.ok(Array.isArray(row.event_ids), `${row.name} must carry an audit sample`);
      assert.equal(row.event_ids.length, Math.min(row.count, 2));
      for (const id of row.event_ids) assert.ok(events.some((e) => e.event_id === id));
    }
  }
  assert.deepEqual(bucket(sampled.by_project, 'alpha').event_ids, ['e1', 'e2']);

  const unsampled = census(events, request({ sample: 0 }));
  for (const list of [unsampled.by_project, unsampled.by_type, unsampled.by_source, unsampled.by_provider]) {
    for (const row of list) {
      assert.deepEqual(Object.keys(row), ['name', 'count'], 'sample 0 must omit event_ids entirely');
    }
  }
});

// --------------------------------------------------------------------------
// tempo
// --------------------------------------------------------------------------

/** Noon UTC, `back` days before today — safely inside its own UTC day. */
const NOON_TODAY = Date.parse(`${utcDay(Date.now())}T12:00:00Z`);
const dayAgo = (back) => new Date(NOON_TODAY - back * 86400000).toISOString();

/** `counts` maps days-ago to an event count for that day. */
function daySeries(project, counts) {
  const events = [];
  let n = 0;
  for (const [back, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      n += 1;
      events.push({ event_id: `${project}-${n}`, timestamp: dayAgo(Number(back)), project });
    }
  }
  return events;
}

test('tempo scores the last complete day and never the partial current day', () => {
  // Scoring a day that is still being written compares a two-hour day against
  // twenty-four-hour days; on the first run of this verb every project scored
  // negative for exactly that reason. Here the partial day is an extreme
  // outlier, so scoring it would produce a wildly different answer (z ~ 150)
  // than the correct one (z = 0).
  const events = daySeries('alpha', { 0: 100, 1: 5, 2: 5, 3: 6, 4: 4, 5: 5 });
  const facts = tempo(events, request({ verb: 'tempo' }));
  const alpha = facts.projects.find((row) => row.project === 'alpha');

  const today = utcDay(Date.now());
  assert.deepEqual(alpha.partial_day, { day: today, count: 100, scored: false });
  assert.equal(alpha.scored_day, utcDay(NOON_TODAY - 86400000), 'the scored day is the last COMPLETE day');
  assert.notEqual(alpha.scored_day, today);
  assert.equal(alpha.scored_count, 5);
  assert.equal(alpha.baseline_days, 4, 'the baseline excludes both the partial day and the scored day');
  assert.equal(alpha.baseline_mean, 5);
  assert.equal(alpha.z, 0, 'the complete-day answer; scoring the partial day would give ~150');
  // This fixture's baseline averages 5 events/day, below the mean at which a
  // normal approximation to count data holds, so the regime is labelled
  // sparse. What this test is about is which day gets scored, not the label.
  assert.notEqual(alpha.z_status, 'insufficient_history');
  assert.equal(alpha.baseline_nonzero_days, 4);
  assert.equal(alpha.total, 125, 'the partial day still appears in the series total');

  const todayRow = alpha.days.find((row) => row.day === today);
  assert.deepEqual(todayRow, { day: today, count: 100, complete: false });
  for (const row of alpha.days.filter((d) => d.day !== today)) {
    assert.equal(row.complete, true);
  }
});

test('tempo returns z null with a reason rather than a misleading zero', () => {
  // Fewer than three baseline days: not enough history to estimate spread.
  const thin = tempo(daySeries('thin', { 0: 4, 1: 9, 2: 2, 3: 7 }), request({ verb: 'tempo' }));
  const thinRow = thin.projects.find((row) => row.project === 'thin');
  assert.equal(thinRow.baseline_days, 2);
  assert.equal(thinRow.baseline_mean, null);
  assert.equal(thinRow.z, null, '"not enough history to say" must not be dressed up as 0.0');
  assert.notEqual(thinRow.z, 0);
  assert.equal(thinRow.z_status, 'insufficient_history');

  // A flat baseline makes the score undefined, not infinite.
  const flat = tempo(daySeries('flat', { 1: 3, 2: 3, 3: 3, 4: 3, 5: 3 }), request({ verb: 'tempo' }));
  const flatRow = flat.projects.find((row) => row.project === 'flat');
  assert.equal(flatRow.baseline_days, 4);
  assert.equal(flatRow.baseline_mean, 3);
  assert.equal(flatRow.z, null);
  assert.notEqual(flatRow.z, 0);
  assert.equal(flatRow.z_status, 'zero_variance');
  assert.equal(flatRow.partial_day, null, 'no events today, so no partial day');
});

test('tempo treats a quiet day as a zero, not as a missing observation', () => {
  // Counting only active days makes every quiet stretch inflate the baseline.
  // Here the project was touched on 2 days out of 6: the dense series must
  // carry the four idle days as zeros, and the score must be computed against
  // them.
  const events = daySeries('gappy', { 1: 8, 5: 2 });
  const row = tempo(events, request({ verb: 'tempo' })).projects[0];
  assert.equal(row.days.length, 5, 'the series runs from first observed day to last, inclusive');
  assert.deepEqual(row.days.map((d) => d.count), [2, 0, 0, 0, 8]);
  assert.equal(row.total, 10);
  assert.equal(row.scored_count, 8);
  assert.equal(row.baseline_days, 4, 'idle days are baseline observations');
  assert.equal(row.baseline_mean, 0.5);
  assert.equal(row.z, 8.66, '(8 - 0.5) / sd of [2,0,0,0]');
  // And this fixture is precisely why the magnitude cannot be taken at face
  // value: a baseline of [2,0,0,0] has a mean of 0.5 and one nonzero day, so
  // the divisor is tiny and z=8.66 overstates what happened ("idle, then not
  // idle"). The score is still reported — the direction is real — but the
  // regime is labelled so a consumer does not rank it against a z computed
  // over a baseline that could support one.
  assert.equal(row.z_status, 'sparse_baseline');
  assert.equal(row.baseline_nonzero_days, 1);
});

test('a dense baseline is scored without the sparse label', () => {
  // The counterpart to the case above: enough daily volume for the normal
  // approximation to hold, so the magnitude means what it appears to mean.
  const events = daySeries('busy', { 1: 40, 2: 12, 3: 14, 4: 13, 5: 11 });
  const row = tempo(events, request({ verb: 'tempo' })).projects[0];
  assert.equal(row.z_status, 'ok');
  assert.ok(row.baseline_mean >= 10, 'baseline mean clears the normal-approximation threshold');
  assert.equal(row.baseline_nonzero_days, 4);
});

test('tempo drops undated events and reports the count', () => {
  const events = [
    ...daySeries('alpha', { 1: 2 }),
    { event_id: 'undated', project: 'alpha' },
    { event_id: 'unparseable', timestamp: 'whenever', project: 'alpha' },
  ];
  const facts = tempo(events, request({ verb: 'tempo' }));
  assert.equal(facts.undated_dropped, 2);
  assert.equal(facts.projects.find((row) => row.project === 'alpha').total, 2);
});

// --------------------------------------------------------------------------
// delta
// --------------------------------------------------------------------------

const row = (id, project, extra = {}) =>
  `${JSON.stringify({ event_id: id, timestamp: '2026-09-02T12:00:00Z', project, type: 'git_commit', summary: `event ${id}`, ...extra })}\n`;

test('a delta with no cursor baselines and claims nothing is new', () => {
  const dir = workspace();
  const changelog = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(changelog, row('seed', 'alpha'));
  const logFiles = { changelog };

  const facts = delta(request({ verb: 'delta' }), { corpusRoot: FIXTURE_DIR, logFiles });
  assert.equal(facts.baseline, true);
  assert.deepEqual(facts.events, []);
  assert.equal(facts.returned, 0);
  assert.equal(typeof facts.cursor, 'string');
  assert.deepEqual(facts.stale, {});
  assert.deepEqual(facts.pending, {});
});

test('delta applies project scope AFTER the read, so the cursor still advances', () => {
  // If scope were applied before the read, an agent watching one project would
  // re-read every unrelated event on every call, forever.
  const dir = workspace();
  const changelog = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(changelog, row('seed', 'alpha'));
  const logFiles = { changelog };
  const options = { corpusRoot: FIXTURE_DIR, logFiles };

  const first = delta(request({ verb: 'delta', project: 'alpha' }), options);

  fs.appendFileSync(changelog,
    row('a1', 'alpha') + row('b1', 'beta') + row('b2', 'beta') + row('a2', 'alpha') + row('c1', 'gamma'));

  const second = delta(request({ verb: 'delta', project: 'alpha', cursor: first.cursor }), options);
  assert.deepEqual(second.events.map((e) => e.event_id), ['a1', 'a2'], 'only the scoped project is returned');
  assert.equal(second.returned, 2);
  assert.equal(second.read, 5, 'but every appended event was read, so the cursor passes them');
  assert.equal(second.baseline, false);
  assert.deepEqual(second.pending, {});
  assert.deepEqual(second.summary.by_project.map((r) => [r.name, r.count]), [['alpha', 2]]);

  // The filtered-out events must not come back on the next call.
  const third = delta(request({ verb: 'delta', project: 'alpha', cursor: second.cursor }), options);
  assert.deepEqual(third.events, [], 'unrelated events must not be re-read forever');
  assert.equal(third.read, 0);

  // ...and an unscoped caller resuming from that same cursor sees nothing
  // either: the cursor advanced past beta/gamma, it did not skip them silently
  // for one caller and hold them for another.
  const unscoped = delta(request({ verb: 'delta', cursor: second.cursor }), options);
  assert.equal(unscoped.read, 0);
});

test('delta reports the project-scoped shape of what arrived', () => {
  const dir = workspace();
  const changelog = path.join(dir, 'changelog.jsonl');
  const milestones = path.join(dir, 'session-milestones.jsonl');
  fs.writeFileSync(changelog, row('seed', 'alpha'));
  fs.writeFileSync(milestones, row('m-seed', 'alpha'));
  const logFiles = { changelog, milestones };
  const options = { corpusRoot: FIXTURE_DIR, logFiles };

  const first = delta(request({ verb: 'delta' }), options);
  fs.appendFileSync(changelog, row('a1', 'alpha'));
  fs.appendFileSync(milestones,
    `${JSON.stringify({ event_id: 'm1', timestamp: '2026-09-02T13:00:00Z', project: 'alpha', event: 'session_end', session_id: 'unknown' })}\n`);

  const second = delta(request({ verb: 'delta', cursor: first.cursor }), options);
  assert.deepEqual(second.events.map((e) => e.event_id).sort(), ['a1', 'm1']);
  assert.deepEqual(
    second.summary.by_source.map((r) => r.name).sort(),
    ['changelog', 'milestones'],
    'the source tag must survive the read',
  );
  const milestone = second.events.find((e) => e.event_id === 'm1');
  assert.equal(milestone.type, 'session_end', 'the type fallback chain applies to delta rows too');
  assert.equal(milestone.session_id, null, 'a sentinel session id is reported as absent, not as "unknown"');
});

test('delta refuses a garbage cursor rather than silently re-baselining', () => {
  // Degrading an undecodable cursor into a fresh baseline would drop everything
  // appended since the caller's last real position and report "nothing new".
  const dir = workspace();
  const changelog = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(changelog, row('seed', 'alpha'));
  const logFiles = { changelog };
  const options = { corpusRoot: FIXTURE_DIR, logFiles };

  assert.throws(
    () => delta(request({ verb: 'delta', cursor: 'not-a-real-cursor' }), options),
    FactsContractError,
  );
  // A cursor from another corpus is a 409, not a quiet answer about this one.
  const foreign = delta(request({ verb: 'delta' }), { corpusRoot: '/somewhere/else', logFiles });
  let error = null;
  try {
    delta(request({ verb: 'delta', cursor: foreign.cursor }), options);
  } catch (thrown) {
    error = thrown;
  }
  assert.ok(error instanceof FactsContractError, 'a wrong-corpus cursor must be refused');
  assert.equal(error.status, 409);
  assert.match(error.message, /somewhere\/else/);
});

test('delta honours its budget and reports the remainder as pending', () => {
  const dir = workspace();
  const changelog = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(changelog, row('seed', 'alpha'));
  const logFiles = { changelog };
  const options = { corpusRoot: FIXTURE_DIR, logFiles };

  const first = delta(request({ verb: 'delta' }), options);
  fs.appendFileSync(changelog, row('a1', 'alpha') + row('a2', 'alpha') + row('a3', 'alpha'));

  const second = delta(request({ verb: 'delta', cursor: first.cursor, budget: 2 }), options);
  assert.deepEqual(second.events.map((e) => e.event_id), ['a1', 'a2']);
  assert.deepEqual(second.pending, { changelog: 1 });

  const third = delta(request({ verb: 'delta', cursor: second.cursor }), options);
  assert.deepEqual(third.events.map((e) => e.event_id), ['a3'], 'a saturated delta is resumable, not lossy');
  assert.deepEqual(third.pending, {});
});

test('a delta cursor is a position token, not a wall-clock window', () => {
  // The corpus is backfilled: retro-index and backfill-git-history append rows
  // dated months in the past. "Arrived since my last run" must include them,
  // which a `since` filter never would.
  const dir = workspace();
  const changelog = path.join(dir, 'changelog.jsonl');
  fs.writeFileSync(changelog, row('seed', 'alpha'));
  const logFiles = { changelog };
  const options = { corpusRoot: FIXTURE_DIR, logFiles };

  const first = delta(request({ verb: 'delta' }), options);
  assert.deepEqual(
    Object.keys(logPositions(logFiles)), ['changelog'],
    'the cursor covers exactly the logs it was handed',
  );

  fs.appendFileSync(changelog, row('backfilled', 'alpha', { timestamp: '2024-01-05T09:00:00Z' }));
  const second = delta(request({ verb: 'delta', cursor: first.cursor }), options);
  assert.deepEqual(second.events.map((e) => e.event_id), ['backfilled']);
  assert.equal(second.events[0].timestamp, '2024-01-05T09:00:00Z');
});

// --------------------------------------------------------------------------
// Regressions for defects found by review after the first implementation.
// Each one produced a plausible-looking response with a wrong or unusable
// number, which is the failure mode this whole endpoint exists to avoid.
// --------------------------------------------------------------------------

test('an audit sample holds only ids that can actually be fetched', () => {
  // The sample list once accepted the null that census substitutes for an
  // unresolved event_id. Nulls filled the slots in arrival order, so a bucket
  // whose first rows lacked ids returned [null, null] while perfectly
  // checkable ids sat further down the same bucket — turning the one field
  // that makes a count verifiable into a field that reads as "nothing here is
  // verifiable", and handing a naive consumer nulls to pass to --get.
  const events = [
    { event_id: '', timestamp: '2026-05-10T12:00:00Z', project: 'alpha', type: 't', _source: 'changelog' },
    { event_id: 'unknown', timestamp: '2026-05-10T12:01:00Z', project: 'alpha', type: 't', _source: 'changelog' },
    { event_id: 'real-1', timestamp: '2026-05-10T12:02:00Z', project: 'alpha', type: 't', _source: 'changelog' },
    { event_id: 'real-2', timestamp: '2026-05-10T12:03:00Z', project: 'alpha', type: 't', _source: 'changelog' },
  ];
  const facts = census(events, request({ sample: 2 }));
  const alpha = bucket(facts.by_project, 'alpha');
  assert.equal(alpha.count, 4, 'unattributed rows still count toward the bucket');
  assert.deepEqual(alpha.event_ids, ['real-1', 'real-2']);
  assert.equal(facts.unattributed.event_id, 2);
});

test('every census dimension reconciles, source included', () => {
  const events = [
    { event_id: 'e1', timestamp: '2026-05-10T12:00:00Z', project: 'alpha', type: 't', _source: 'changelog' },
    { event_id: 'e2', timestamp: '2026-05-10T12:01:00Z', project: 'alpha', type: 't' },
  ];
  const facts = census(events, request());
  const bucketed = facts.by_source.reduce((sum, r) => sum + r.count, 0);
  assert.equal(bucketed + facts.unattributed.source, facts.events);
  assert.equal(facts.unattributed.source, 1);
});

test('census counts undated rows whether or not a window is active', () => {
  // undated_dropped was only incremented inside the window guard, so an
  // unwindowed census reported zero undated rows while counting them in its
  // own total: one field name meaning "how many exist" in one call and "how
  // many I excluded" in the next.
  const events = [
    { event_id: 'e1', timestamp: '2026-05-10T12:00:00Z', project: 'alpha', type: 't', _source: 'changelog' },
    { event_id: 'e2', timestamp: 'not-a-date', project: 'alpha', type: 't', _source: 'changelog' },
  ];
  const open = census(events, request());
  assert.equal(open.undated, 1, 'the undated row is visible without a window');
  assert.equal(open.undated_dropped, 0, 'nothing was dropped: no window was applied');
  assert.equal(open.events, 2);

  const windowed = census(events, request({ since: '2020-01-01' }));
  assert.equal(windowed.undated, 1);
  assert.equal(windowed.undated_dropped, 1, 'a window makes the undated row undecidable, so it is dropped');
  assert.equal(windowed.events, 1);
});

test('tempo reports what it excluded, the way census does', () => {
  const events = [
    { event_id: 'e1', timestamp: '2026-09-01T12:00:00Z', project: 'alpha', type: 't' },
    { event_id: 'e2', timestamp: '2020-01-01T12:00:00Z', project: 'alpha', type: 't' },
    { event_id: 'e3', timestamp: '2026-09-01T12:00:00Z', project: '', type: 't' },
    { event_id: 'e4', timestamp: 'nope', project: 'alpha', type: 't' },
  ];
  const facts = tempo(events, request({ verb: 'tempo', since: '2026-08-01' }));
  assert.equal(facts.windowed_out, 1, 'the 2020 row fell outside the window');
  assert.equal(facts.unattributed.project, 1, 'the project-less row is reported, not silently skipped');
  assert.equal(facts.undated_dropped, 1);
});

test('tempo attaches ids for the day it scores, so a z-score is checkable', () => {
  // tempo accepted `sample` and ignored it. A silently discarded parameter is
  // exactly what the contract rejects a cursor on census for.
  const today = utcDay(Date.now());
  const yesterday = utcDay(Date.now() - 24 * 60 * 60 * 1000);
  const events = [
    { event_id: 'y1', timestamp: `${yesterday}T09:00:00Z`, project: 'alpha', type: 't' },
    { event_id: 'y2', timestamp: `${yesterday}T10:00:00Z`, project: 'alpha', type: 't' },
    { event_id: 't1', timestamp: `${today}T09:00:00Z`, project: 'alpha', type: 't' },
  ];
  const facts = tempo(events, request({ verb: 'tempo', sample: 3 }));
  const alpha = facts.projects.find((p) => p.project === 'alpha');
  assert.equal(alpha.scored_day, yesterday, 'the partial current day is never the scored day');
  assert.deepEqual(alpha.scored_day_event_ids, ['y1', 'y2']);
  assert.ok(!alpha.scored_day_event_ids.includes('t1'), 'ids come from the scored day only');
});

test('delta collapses an event written to two logs into one arrival', () => {
  // The logs deliberately overlap: a hook writes one event to changelog and
  // again to its domain log. readAllEvents collapses that pair for the resident
  // corpus; these rows come straight off the log tails, so without the same
  // collapse a caller counting "what arrived since my last run" doubles every
  // hook-written event.
  const dir = workspace();
  const changelog = path.join(dir, 'changelog.jsonl');
  const toolUse = path.join(dir, 'tool-use-log.jsonl');
  fs.writeFileSync(changelog, row('seed', 'alpha'));
  fs.writeFileSync(toolUse, '');
  const logFiles = { changelog, 'tool-use': toolUse };
  const options = { corpusRoot: FIXTURE_DIR, logFiles };

  const first = delta(request({ verb: 'delta' }), options);
  fs.appendFileSync(changelog, row('shared', 'alpha'));
  fs.appendFileSync(toolUse, row('shared', 'alpha'));

  const second = delta(request({ verb: 'delta', cursor: first.cursor }), options);
  assert.equal(second.read, 2, 'both log lines were consumed');
  assert.equal(second.returned, 1, 'they are one arrival');
  assert.equal(second.duplicates_collapsed, 1);
  assert.deepEqual(second.events.map((e) => e.event_id), ['shared']);
  assert.equal(second.events[0].source, 'tool-use', 'the domain source label wins over changelog');
  const shared = bucket(second.summary.by_project, 'alpha');
  assert.equal(shared.count, 1, 'the summary counts the arrival once too');
});

test('an unresolvable project scope is distinguishable from a quiet one', () => {
  // Substring matching cannot reach a registry alias whose members do not
  // contain their own key, and six of ten aliases in project-registry.json are
  // exactly that (`devtools` -> `session-cartographer`). The portable CLI
  // expands through the registry first; the API does not. So an API caller can
  // name a real alias, match nothing, and be handed `0 events` — which reads as
  // "nothing happened" when it means "I could not resolve your scope". For a
  // census that is the worst available failure: the number looks like an answer.
  const events = [
    { event_id: 'e1', timestamp: '2026-05-10T12:00:00Z', project: 'session-cartographer', type: 't', _source: 'changelog' },
    { event_id: 'e2', timestamp: '2026-05-10T12:01:00Z', project: 'psychodeli-webgl-port', type: 't', _source: 'changelog' },
  ];
  const ctx = { events, index: { docs: new Map() } };
  const call = (project) => executeFacts(ctx, {
    contract_version: 1, call_id: 'scope', verb: 'census', project, top: 5, sample: 0,
  });

  const unscoped = call('');
  assert.equal(unscoped.project_scope.status, 'all', 'no scope requested, no scope applied');
  assert.equal(unscoped.facts.events, 2);

  const resolved = call('psychodeli');
  assert.equal(resolved.project_scope.status, 'resolved');
  assert.deepEqual(resolved.project_scope.matched, ['psychodeli-webgl-port'],
    'a family name reports which repositories it actually admitted');
  assert.equal(resolved.facts.events, 1);

  // The load-bearing pair: both return zero, and only one of them is a failure.
  const unresolvable = call('devtools');
  assert.equal(unresolvable.facts.events, 0);
  assert.equal(unresolvable.project_scope.status, 'unresolved');
  assert.equal(unresolvable.project_scope.matched_count, 0);

  const quiet = call('session-cartographer');
  assert.equal(quiet.project_scope.status, 'resolved',
    'a scope that resolves but happens to be empty in-window is NOT unresolved');
});
