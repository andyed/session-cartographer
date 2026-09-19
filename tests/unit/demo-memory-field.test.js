import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(ROOT, 'demo', 'memory', 'state.json');
// demo.js fetches ${BASE}demo/demo/… — the nested copy under explorer/public is
// the one a browser actually loads. Three copies of the demo corpus already
// exist in this tree and two of them are stale; this file is not allowed to
// become the fourth.
const LIVE = join(ROOT, 'explorer', 'public', 'demo', 'demo', 'memory', 'state.json');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const { activityFromMemory, projectMemoryScope } = await import('../../explorer/shared/activity-scope.js');

describe('demo working-memory fixture', () => {
  test('carries a populated field, not an empty one that renders as broken', () => {
    const { field } = read(SOURCE);
    // The demo failure mode is not an error, it is a blank instrument. Assert
    // the composition that makes the field worth showing: several concurrent
    // sessions, grouped, with real event volume behind them.
    assert.ok(field.sessions.length >= 5, `expected a crowded field, got ${field.sessions.length} sessions`);
    assert.ok(field.groups.length >= 3, `expected several project groups, got ${field.groups.length}`);
    assert.ok(field.total >= 100, `expected a dense window, got ${field.total} events`);
    for (const session of field.sessions) assert.ok(session.count > 0, `${session.id} contributes no events`);
  });

  test('offers only the comparison axes the fixture can actually plot', () => {
    const { axes, field } = read(SOURCE);
    const counts = {};
    for (const session of field.sessions) {
      for (const [key, value] of Object.entries(session.metrics.counts)) counts[key] = (counts[key] || 0) + value;
    }
    // An axis with no data still draws — flat at zero — and a flat line reads
    // as a measured finding rather than as absent data. So the list must track
    // the fixture exactly in BOTH directions.
    for (const axis of ['edit', 'commit']) {
      assert.ok(counts[axis] > 0, `fixture lost its ${axis} events`);
      assert.ok(axes.includes(axis), `${axis} has data but is not offered`);
    }
    assert.ok(axes.includes('events'));
    for (const axis of ['output', 'total', 'files', 'research']) {
      assert.ok(!axes.includes(axis), `${axis} is offered but this fixture has nothing to plot on it`);
    }
    const files = field.sessions.reduce((n, session) => n + (field.files[session.id] || []).length, 0);
    assert.equal(files, 0, 'files resolved — regenerate axes rather than leaving the list stale');
  });

  test('drops the private enrichment keys before shipping', () => {
    const { field } = read(SOURCE);
    for (const session of field.sessions) {
      assert.ok(!('_editEvidence' in session), `${session.id} still carries edit evidence`);
      assert.ok(!('transcriptPaths' in session), `${session.id} still carries transcript paths`);
      assert.equal(session.metrics.tokens.status, 'missing');
    }
  });

  test('ships complete bounded evidence with truthful frozen-source metadata', () => {
    const { field, window_end: windowEnd } = read(SOURCE);
    assert.equal(field.evidenceComplete, true);
    assert.equal(field.indexedRecordCount, field.total);
    assert.equal(field.evidenceIndex.length, field.total);
    assert.equal(field.coverage.evidenceComplete, true);
    assert.equal(field.coverage.indexedRecords, field.total);
    assert.equal(field.coverage.status, 'fixture-bounded-unknown-history');
    assert.equal(field.source.mode, 'demo');
    assert.equal(field.source.corpusId, 'demo-memory-v1');
    assert.equal(field.source.snapshotAt, Date.parse(windowEnd));
    assert.equal(field.snapshotAt, Date.parse(windowEnd));
  });

  test('the shared exact projection drives demo focus and activity composition', () => {
    const { field } = read(SOURCE);
    const records = field.evidenceIndex;
    const from = records[20].t;
    const through = records[80].t;
    const closed = projectMemoryScope(field, { from, through, lower: 'closed' });
    const open = projectMemoryScope(field, { from, through, lower: 'open' });
    const expectedClosed = records.filter(record => record.t >= from && record.t <= through);
    assert.equal(closed.total, expectedClosed.length);
    assert.equal(open.total, expectedClosed.filter(record => record.t > from).length);
    assert.deepEqual(closed.evidenceIndex.map(record => record.key), expectedClosed.map(record => record.key));
    const activity = activityFromMemory(closed);
    assert.equal(activity.totalEvents, closed.total);
    assert.equal(activity.totalSessions, closed.sessions.length);
    for (const session of activity.sessions) {
      assert.equal(session.event_count, expectedClosed.filter(record => record.sessionId === session.session_id).length);
    }
  });

  test('names no real project, person, or home directory', () => {
    // The fixture is derived from already-sanitized demo data, so this is a
    // regression guard on that property rather than a scrub of its own: if a
    // future builder ever reads the live corpus instead, this fails first.
    const raw = readFileSync(SOURCE, 'utf8');
    for (const forbidden of ['/Users/', 'andyed', 'psychodeli', 'scrutinizer', 'iblipper', 'clicksense', 'histospire']) {
      assert.ok(!new RegExp(forbidden, 'i').test(raw), `fixture leaks ${forbidden}`);
    }
  });

  test('the copy the browser loads matches the copy in the repo', (t) => {
    // LIVE is a build artifact under a gitignored directory, so it is simply
    // absent on a fresh checkout — build-demo-memory.mjs --write creates it.
    // The drift this guards against (this tree already carries three copies of
    // the demo corpus, two of them stale) can only exist once it has been
    // built, so skipping there states the situation instead of failing on it.
    if (!existsSync(LIVE)) return t.skip('not built yet — run scripts/build-demo-memory.mjs --write');
    assert.equal(readFileSync(LIVE, 'utf8'), readFileSync(SOURCE, 'utf8'));
  });

  test('regenerates identically from its source fixture', () => {
    // A checked-in artifact that no longer matches its generator is stale
    // history presented as current data. Rebuild and compare.
    const out = execFileSync('node', [join(ROOT, 'scripts', 'build-demo-memory.mjs')], { encoding: 'utf8' });
    const { field, window_end: end } = read(SOURCE);
    assert.match(out, new RegExp(`window ends ${end}`));
    assert.match(out, new RegExp(`field: ${field.sessions.length} sessions, ${field.groups.length} groups, ${field.total} events`));
  });
});

describe('demo route coverage', () => {
  test('legacy explorer and exact-memory paths stay owned by the static layer', () => {
    const layer = readFileSync(join(ROOT, 'explorer', 'src', 'demo.js'), 'utf8');
    const requested = [
      '/api/events', '/api/search', '/api/autocomplete', '/api/projects', '/api/sessions',
      '/api/memory/state', '/api/memory/session', '/api/memory/file', '/api/memory/activity', '/api/activity-scope',
    ];
    for (const path of requested) {
      assert.ok(layer.includes(`'${path}'`), `demo.js does not handle ${path}`);
    }
  });

  test('static memory owns both exact activity paths and never invents file review', () => {
    const layer = readFileSync(join(ROOT, 'explorer', 'src', 'demo.js'), 'utf8');
    assert.ok(layer.includes("'/api/memory/activity'"));
    assert.ok(layer.includes("'/api/activity-scope'"));
    assert.ok(layer.includes('projectMemoryScope(field'));
    assert.ok(layer.includes('activityFromMemory(focused)'));
    assert.match(layer, /File review is not included in the static demo/);
  });
});
