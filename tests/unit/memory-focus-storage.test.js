import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_RETURN_POINT_KEY, readLegacyFocusSeed, readSavedFocus,
  saveFocus, savedFocusStorageKey, undoSavedFocus,
} from '../../explorer/src/components/memory-focus-storage.js';

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    writes: 0,
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { this.writes++; data.set(key, value); },
  };
}

const focus = {
  from: Date.parse('2026-09-01T12:00:00Z'),
  through: Date.parse('2026-09-02T12:00:00Z'),
  lower: 'closed',
  q: 'artifact',
  project: 'session-cartographer',
  providers: ['codex'],
  evidence: ['commit'],
  result: 'files',
  kind: 'md',
  brush: ['beta-task', 'alpha-task', 'beta-task'],
  filter: 'flight',
  mode: 'rolling',
  durationMs: 86400000,
};

test('saved focus is isolated by corpus and source and persists an absolute copy', () => {
  const storage = memoryStorage();
  const live = { corpusId: 'corpus/a', source: 'live' };
  const demo = { corpusId: 'corpus/a', source: 'demo' };
  assert.notEqual(savedFocusStorageKey(live), savedFocusStorageKey(demo));
  const saved = saveFocus(storage, live, focus, 1234);
  assert.equal(saved.ok, true);
  assert.equal(storage.writes, 1, 'an explicit save is one storage transaction');
  assert.deepEqual(readSavedFocus(storage, live).value, {
    version: 1, savedAt: 1234,
    from: focus.from, through: focus.through, lower: 'closed',
    scope: {
      q: 'artifact', project: 'session-cartographer', providers: ['codex'],
      evidence: ['commit'], result: 'files', kind: 'md',
      brush: ['alpha-task', 'beta-task'], filter: 'flight',
    },
  });
  assert.equal(readSavedFocus(storage, demo).value, null);
});

test('old saved records acquire safe optional scope defaults', () => {
  const storage = memoryStorage();
  const identity = 'old-corpus';
  const key = savedFocusStorageKey(identity);
  storage.setItem(key, JSON.stringify({
    version: 1,
    current: {
      version: 1, savedAt: 10, from: focus.from, through: focus.through, lower: 'closed',
      scope: { q: '', project: null, providers: [], evidence: [], result: 'tasks', kind: 'all' },
    },
    undo: null,
  }));
  const read = readSavedFocus(storage, identity);
  assert.equal(read.ok, true);
  assert.equal(read.value.scope.brush, null);
  assert.equal(read.value.scope.filter, 'all');
});

test('save preserves the prior record and undo atomically swaps it back', () => {
  const storage = memoryStorage();
  const identity = { corpusId: 'one', source: 'live' };
  const first = saveFocus(storage, identity, focus, 100);
  const secondFocus = { ...focus, from: focus.from + 1000, through: focus.through + 1000 };
  const second = saveFocus(storage, identity, secondFocus, 200);
  assert.equal(first.ok && second.ok, true);
  const undone = undoSavedFocus(storage, identity);
  assert.equal(undone.ok, true);
  assert.equal(undone.value.savedAt, 100);
  assert.equal(storage.writes, 3, 'each save or undo performs exactly one write');
});

test('legacy seed reads without migration writes and reports an unsupported span', () => {
  const old = focus.from;
  const storage = memoryStorage({ [LEGACY_RETURN_POINT_KEY]: String(old) });
  const result = readLegacyFocusSeed(storage, { through: old + 91 * 86400000 });
  assert.equal(result.ok, true);
  assert.equal(result.unsupported, true);
  assert.deepEqual(result.value, { from: old, through: old + 91 * 86400000, lower: 'open' });
  assert.equal(storage.writes, 0);
});

test('storage denial and corruption are recoverable results', () => {
  const denied = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readSavedFocus(denied, 'one').error.code, 'unavailable');
  assert.equal(saveFocus(denied, 'one', focus, 10).error.code, 'unavailable');
  const key = savedFocusStorageKey('one');
  const corrupt = memoryStorage({ [key]: '{bad json' });
  assert.equal(readSavedFocus(corrupt, 'one').error.code, 'corrupt');
  assert.equal(saveFocus(corrupt, 'one', focus, 10).ok, true, 'explicit Save may replace a corrupt record');
  assert.equal(readLegacyFocusSeed(memoryStorage({ [LEGACY_RETURN_POINT_KEY]: 'nope' }), { through: focus.through }).error.code, 'corrupt');
});
