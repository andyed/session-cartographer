import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplacer } from '../../tools/screenshots/remap-core.js';
import { pageRemapScript } from '../../tools/screenshots/page-remap.js';
import { buildDictionary } from '../../tools/screenshots/obfuscate.js';

test('one pass, longest first, case-insensitive, token-bounded, homes scrubbed', () => {
  const { replace } = createReplacer([['widget', 'amber-atlas'], ['widget-web', 'coral-delta'], ['amber', 'widget']]);
  assert.equal(replace('Widget-web and widget at /Users/kim/dev/widget'), 'coral-delta and amber-atlas at /home/demo/dev/amber-atlas');
  assert.equal(replace('amber'), 'widget', 'a replacement is never itself rewritten');
  assert.equal(replace('widgetry'), 'widgetry', 'a name inside a longer word is not a match');
  assert.equal(replace('path=%2FUsers%2Fkim%2Fx'), 'path=%2Fhome%2Fdemo%2Fx');
});

test('leaks: originals, denied terms, watched substrings and real homes; kept names are not leaks', () => {
  const { leaks } = createReplacer([['secret-proj', 'moss-peak'], ['public-repo', 'public-repo']], { deny: ['Kit', 'PROJ9'], watch: ['secret-proj'] });
  assert.deepEqual(leaks('public-repo moss-peak /home/demo/x kitten'), [], 'kept names, aliases, the demo home and a word containing a short term are clean');
  assert.deepEqual(leaks('secret-proj'), ['secret-proj', 'secret-proj']);
  assert.deepEqual(leaks('notes on Kit and proj9_analysis'), ['Kit', 'proj9']);
  assert.deepEqual(leaks('old-secret-proj_v2'), ['secret-proj'], 'a watched name inside a longer token is still caught');
  assert.deepEqual(leaks('/Users/kim/x'), ['/Users/kim']);
});

test('a watched name with an alias is replaced inside longer tokens too, without cascading', () => {
  const { replace, leaks } = createReplacer([['secret-proj', 'moss-peak'], ['moss', 'secret-proj-2']], { watch: ['secret-proj', 'unmapped-term'] });
  assert.equal(replace('<secret-proj-context> and old-secret-proj_v2/'), '<moss-peak-context> and old-moss-peak_v2/');
  assert.deepEqual(leaks(replace('secret-proj-www-ultrawide')), []);
  assert.deepEqual(leaks(replace('an unmapped-term_v2')), ['unmapped-term'], 'a watched term with no alias is only flagged');
});

test('the init script is self-contained source', () => {
  const source = pageRemapScript({ entries: [['a-b', 'c-d']], deny: ['x'] });
  assert.doesNotThrow(() => new Function(source.replace(/^\(/, 'return (').replace(/\);$/, ')')), 'parses as a function call');
  assert.match(source, /function createReplacer/);
  assert.doesNotMatch(source, /\bimport\b/);
});

test('keep and keepFile leave public names as they are', () => {
  const input = { groups: ['public-repo', 'private-repo'], sessions: [], evidenceIndex: [{ path: '/dev/public-repo/Timeline.jsx' }, { path: '/dev/private-repo/plan-notes.md' }] };
  const { entries } = buildDictionary(input, { seed: 's', keep: ['public-repo'], keepFile: file => file === 'Timeline.jsx' });
  const map = new Map(entries);
  assert.equal(map.get('public-repo'), 'public-repo');
  assert.notEqual(map.get('private-repo'), 'private-repo');
  assert.equal(map.has('Timeline.jsx'), false);
  assert.match(map.get('plan-notes.md'), /^[a-z]+-[a-z]+\.md$/);
});
