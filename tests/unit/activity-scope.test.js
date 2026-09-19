import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-activity-scope-')));
process.env.CARTOGRAPHER_DEV_DIR = root;
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

const { createMemoryHandler, projectMemory } = await import('../../explorer/server/memory.js');
const { activityFromMemory, projectMemoryScope } = await import('../../explorer/shared/activity-scope.js');

const through = Date.parse('2026-09-18T20:00:00Z');
const from = through - 60 * 60 * 1000;
const at = (offset) => new Date(from + offset).toISOString();

function row(id, offset, overrides = {}) {
  return {
    event_id: id,
    timestamp: at(offset),
    session_id: 'long-task',
    session_title: 'Ordinary continuing task',
    project: 'alpha',
    provider: 'codex',
    type: 'tool_bash',
    summary: `Routine ${id}`,
    ...overrides,
  };
}

function invoke(handler, pathname) {
  return new Promise((resolve, reject) => {
    let status;
    handler({ url: pathname, method: 'GET' }, {
      writeHead(code) { status = code; },
      end(raw) { resolve({ status, body: JSON.parse(raw) }); },
    }).then((handled) => { if (!handled) resolve({ handled: false }); }, reject);
  });
}

function fixture() {
  const shared = path.join(root, 'shared.md');
  const outside = path.join(root, 'outside.js');
  fs.writeFileSync(shared, '# shared');
  fs.writeFileSync(outside, 'outside');
  const rows = [
    row('before', -1, { summary: 'Task began before focus' }),
    row('left-edge', 0, { summary: 'Included closed left edge' }),
    row('hidden-match', 10, { summary: 'buried-needle decisive observation' }),
    row('alpha-edit', 20, { type: 'tool_file_edit', file_path: shared, summary: `Edit ${shared}` }),
    row('wrong-project', 30, { project: 'beta', summary: 'Same task, different project' }),
    row('stop-is-not-outcome', 40, { type: 'agent_stop', summary: 'Command runner stopped' }),
    row('commit', 50, { type: 'git_commit', summary: 'Commit abc123: shipped bounded projection' }),
    row('right-edge', 60 * 60 * 1000, { summary: 'Included right edge' }),
    row('after', 60 * 60 * 1000 + 1, { summary: 'Task continued after focus' }),
    row('one-event', 100, { session_id: 'single', session_title: 'One event task', summary: 'Only observation' }),
    row('shared-edit', 200, { session_id: 'single', session_title: 'One event task', type: 'tool_file_edit', file_path: shared, summary: `Edit ${shared}` }),
    row('solo', 250, { session_id: 'solo', session_title: 'Actually one event', summary: 'Exactly one record' }),
    row('outside-file', -100, { type: 'tool_file_edit', file_path: outside, summary: `Edit ${outside}` }),
    row(null, 300, { event_id: '', session_id: '', summary: 'Anonymous buried-needle evidence' }),
  ];
  for (let index = 0; index < 70; index++) rows.push(row(`later-${index}`, 1000 + index, { summary: `Later observation ${index}` }));
  return { rows, shared, outside };
}

test('exact scope qualifies cohorts from complete evidence before the 60-note preview', () => {
  const { rows, shared, outside } = fixture();
  const snapshot = projectMemory(rows, { now: through, hours: 2, corpusRoot: root });
  const original = snapshot.sessions.find((session) => session.id === 'long-task');
  original.tokenSeries = [
    { t: from, input: 10, output: 2, cacheRead: 1, cacheWrite: 0, total: 12 },
    { t: through + 1, input: 100, output: 20, cacheRead: 0, cacheWrite: 0, total: 120 },
  ];
  original.metrics.tokens = { status: 'available', source: 'codex', input: 110, output: 22, cacheRead: 1, cacheWrite: 0, total: 132, samples: 2, scope: 'window' };
  assert.equal(original.notes.length, 60);
  assert.ok(!original.notes.some((note) => note.id === 'hidden-match'), 'fixture must displace the matching note beyond the display preview');

  const scoped = projectMemoryScope(snapshot, { from, through, lower: 'closed', project: 'alpha', providers: ['codex'], q: 'buried-needle', result: 'tasks', kind: 'all' });
  assert.deepEqual(scoped.sessions.map((session) => session.id), ['long-task']);
  assert.ok(scoped.sessions[0].matchReasons.includes('query:evidence'));
  assert.ok(scoped.evidenceIndex.some((record) => record.id === 'hidden-match'));
  assert.ok(scoped.evidenceIndex.some((record) => record.id === 'right-edge'));
  assert.ok(!scoped.evidenceIndex.some((record) => record.id === 'wrong-project'));
  assert.ok(!scoped.evidenceIndex.some((record) => record.id === 'after'));
  assert.ok(!scoped.outcomes?.length, 'outcomes belong to sessions, not the snapshot root');
  assert.deepEqual(scoped.sessions[0].outcomes.map((item) => item.id), ['commit'], 'commands and stop records never become outcomes');
  assert.deepEqual(scoped.sessions[0].tokenSeries.map((sample) => sample.t), [from]);
  assert.equal(scoped.sessions[0].metrics.tokens.total, 12, 'whole-window token totals never masquerade as focus totals');
  assert.equal(scoped.sessions[0].metrics.tokens.scope, 'focus');
  assert.deepEqual(scoped.fileIndex.map((file) => file.path), [shared]);
  assert.ok(!scoped.fileIndex.some((file) => file.path === outside), 'a query cannot resurrect an out-of-range edit');
  assert.equal(scoped.evidenceComplete, true);
  assert.equal(scoped.coverage.indexedRecords, scoped.total);
  const outsideCoverage = projectMemoryScope(snapshot, { from: through + 1000, through: through + 2000 });
  assert.equal(outsideCoverage.total, 0);
  assert.equal(outsideCoverage.coverageStatus, 'outside-observed-extent', 'an empty interval beyond observed extrema is not claimed complete');
});

test('boundaries, evidence cohorts, one-event tasks, and file contributors use the same exact records', () => {
  const { rows, shared } = fixture();
  const snapshot = projectMemory(rows, { now: through, hours: 2, corpusRoot: root });
  const closed = projectMemoryScope(snapshot, { from, through, lower: 'closed' });
  const open = projectMemoryScope(snapshot, { from, through, lower: 'open' });
  assert.ok(closed.evidenceIndex.some((record) => record.id === 'left-edge'));
  assert.ok(!open.evidenceIndex.some((record) => record.id === 'left-edge'));
  assert.ok(open.evidenceIndex.some((record) => record.id === 'right-edge'));

  const commits = projectMemoryScope(snapshot, { from, through, evidence: ['commit'] });
  assert.deepEqual(commits.sessions.map((session) => session.id), ['long-task']);
  assert.ok(commits.evidenceIndex.some((record) => record.id === 'alpha-edit'), 'an evidence match qualifies the task cohort, not only matching records');

  assert.equal(closed.sessions.find((session) => session.id === 'solo').count, 1, 'one-event tasks are retained');
  const sharedFile = closed.fileIndex.find((file) => file.path === shared);
  assert.deepEqual(sharedFile.contributors, ['long-task', 'single']);
  assert.equal(sharedFile.contributorCount, 2);
  assert.equal(closed.counts.files, 1, 'a shared path is counted once, not once per contributor');

  const activity = activityFromMemory(closed);
  const single = activity.sessions.find((session) => session.session_id === 'single');
  assert.equal(single.event_count, 2);
  assert.equal(single.segments.length, 1);
  assert.ok(activity.sessions.every((session) => session.fullStart <= session.firstObserved && session.fullEnd >= session.lastObserved));
  const brushed = projectMemoryScope(snapshot, { from, through, brush: ['solo'] });
  assert.deepEqual(brushed.sessions.map((session) => session.id), ['solo']);
  assert.equal(brushed.total, 1);
  assert.deepEqual(brushed.sessions[0].matchReasons, ['task-cohort']);

  snapshot.files['long-task'].push({ path: '/fixture/code.js', name: 'code.js', project: 'alpha', edits: [{ t: from + 20, id: 'alpha-edit' }] });
  assert.ok(projectMemoryScope(snapshot, { from, through, result: 'tasks', kind: 'md' }).fileIndex.some((file) => file.path.endsWith('code.js')), 'a hidden Files preference cannot alter task evidence');
  assert.ok(!projectMemoryScope(snapshot, { from, through, result: 'files', kind: 'md' }).fileIndex.some((file) => file.path.endsWith('code.js')));
});

test('activity endpoints filter before paging and bind cursors to source revision', async () => {
  const { rows, shared } = fixture();
  rows.push(row('legacy-old', -29 * 60 * 60 * 1000, { session_id: 'legacy', session_title: 'Legacy hours task' }));
  for (let index = 0; index < 520; index++) rows.push(row(`bulk-${index}`, 2000 + index, { session_id: 'bulk', session_title: 'Large candidate task', summary: index === 0 ? 'pagination-needle' : `Bulk ${index}` }));
  const handler = createMemoryHandler({
    getEvents: () => rows,
    corpusRoot: root,
    now: () => through,
    transcriptEnricher: { read: async () => ({ valid: false, reason: 'fixture' }) },
  });
  const query = `from=${from}&through=${through}&q=pagination-needle&project=alpha&provider=codex&limit=10`;
  const first = await invoke(handler, `/api/memory/activity?${query}`);
  assert.equal(first.status, 200);
  assert.equal(first.body.activity.totalEvents, 520, 'the task cohort is counted before the event page is truncated');
  assert.equal(first.body.activity.events.length, 10);
  assert.equal(first.body.activity.totalSessions, 1);
  assert.ok(first.body.activity.nextCursor);
  assert.equal(first.body.focused.sessions[0].events.length, 520);
  const second = await invoke(handler, `/api/activity-scope?${query}&cursor=${encodeURIComponent(first.body.activity.nextCursor)}`);
  assert.equal(second.status, 200, 'the full-app alias shares the exact contract');
  assert.equal(second.body.activity.events[0].id, 'bulk-10');
  const stale = Buffer.from(JSON.stringify({ revision: 'stale', offset: 10 })).toString('base64url');
  assert.equal((await invoke(handler, `/api/memory/activity?${query}&cursor=${stale}`)).status, 409);
  assert.equal((await invoke(handler, `/api/memory/activity?from=${from}&through=${through}&q=different&limit=10&cursor=${encodeURIComponent(first.body.activity.nextCursor)}`)).status, 409, 'a cursor cannot cross predicates at the same source revision');
  assert.equal(first.body.source.corpusId.startsWith('corpus-'), true);
  assert.equal(first.body.coverage.evidenceComplete, true);

  const contextFrom = from - 1000;
  const contextQuery = `${query}&contextFrom=${contextFrom}&contextThrough=${through}`;
  const fullContext = await invoke(handler, `/api/activity-scope?${contextQuery}`);
  const contextOnly = await invoke(handler, `/api/activity-scope?${contextQuery}&shape=context`);
  assert.equal(contextOnly.status, 200);
  assert.deepEqual(Object.keys(contextOnly.body).sort(), ['context', 'coverage', 'source']);
  assert.deepEqual(contextOnly.body.context, fullContext.body.context, 'the compact shape must be the exact full-contract context projection');
  assert.deepEqual(contextOnly.body.source, contextOnly.body.context.source);
  assert.deepEqual(contextOnly.body.coverage, contextOnly.body.context.coverage);
  assert.deepEqual(contextOnly.body.context.requestedRange, { from: contextFrom, through, lower: 'closed' });
  assert.deepEqual(contextOnly.body.context.loadedRange, { from: contextFrom, through });
  assert.equal(contextOnly.body.context.scope.q, 'pagination-needle');
  assert.equal(contextOnly.body.context.scope.project, 'alpha');
  assert.deepEqual(contextOnly.body.context.scope.providers, ['codex']);
  assert.equal('focused' in contextOnly.body, false);
  assert.equal('activity' in contextOnly.body, false);

  const exactState = await invoke(handler, `/api/memory/state?from=${from}&through=${from}`);
  assert.equal(exactState.status, 200);
  assert.ok(exactState.body.evidenceIndex.every((record) => record.t === from));
  assert.ok(exactState.body.evidenceIndex.some((record) => record.id === 'left-edge'));
  assert.ok(!exactState.body.evidenceIndex.some((record) => record.id === 'hidden-match'));
  assert.equal(exactState.body.start, from);
  assert.equal(exactState.body.end, from);
  const brushedState = await invoke(handler, `/api/memory/state?from=${from}&through=${through}&brush=solo,single`);
  assert.deepEqual(brushedState.body.sessions.map((session) => session.id), ['single', 'solo']);
  assert.equal(brushedState.body.unattributed, 0);

  const legacyDay = await invoke(handler, `/api/memory/activity?end=${through}&hours=24&limit=500`);
  const legacyWide = await invoke(handler, `/api/memory/activity?end=${through}&hours=48&limit=500`);
  assert.ok(!legacyDay.body.activity.events.some((record) => record.id === 'legacy-old'));
  assert.ok(legacyWide.body.activity.events.some((record) => record.id === 'legacy-old'), 'activity keeps legacy end/hours semantics');

  const encodedFile = encodeURIComponent(shared);
  const insideFile = await invoke(handler, `/api/memory/file?session=long-task&path=${encodedFile}&from=${from}&through=${from + 300}`);
  assert.equal(insideFile.status, 200);
  assert.deepEqual(insideFile.body.evidence.map((edit) => edit.id), ['alpha-edit']);
  const outsideFile = await invoke(handler, `/api/memory/file?session=long-task&path=${encodedFile}&from=${from + 500}&through=${from + 600}`);
  assert.equal(outsideFile.status, 404, 'file review cannot resurrect an edit outside the exact interval');
});
