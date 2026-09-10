import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

  test('names no real project, person, or home directory', () => {
    // The fixture is derived from already-sanitized demo data, so this is a
    // regression guard on that property rather than a scrub of its own: if a
    // future builder ever reads the live corpus instead, this fails first.
    const raw = readFileSync(SOURCE, 'utf8');
    for (const forbidden of ['/Users/', 'andyed', 'psychodeli', 'scrutinizer', 'iblipper', 'clicksense', 'histospire']) {
      assert.ok(!new RegExp(forbidden, 'i').test(raw), `fixture leaks ${forbidden}`);
    }
  });

  test('the copy the browser loads matches the copy in the repo', () => {
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
  test('every API path the memory view requests is handled by the static layer', () => {
    const view = readFileSync(join(ROOT, 'explorer', 'src', 'components', 'WorkingMemory.jsx'), 'utf8');
    const layer = readFileSync(join(ROOT, 'explorer', 'src', 'demo.js'), 'utf8');
    // Quote AND backtick: the two routes that take query parameters are built
    // as template literals, and a quote-only scan silently skips exactly the
    // calls most likely to be missing from the static layer.
    const requested = [...new Set([...view.matchAll(/['"`](\/api\/[a-z/]+)/g)].map(match => match[1]))];
    // This is the defect that kept the memory view out of the demo: the view
    // called routes the static layer had never heard of, so on GH Pages every
    // one of them fell through to the host and 404'd.
    assert.ok(requested.length >= 4, `expected the memory view to call several routes, saw ${requested.length}`);
    for (const path of requested) {
      assert.ok(layer.includes(`'${path}'`), `demo.js does not handle ${path}`);
    }
  });
});
