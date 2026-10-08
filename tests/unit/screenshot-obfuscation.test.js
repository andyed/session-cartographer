import test from 'node:test';
import assert from 'node:assert/strict';
import { obfuscateSnapshot } from '../../tools/screenshots/obfuscate.js';
import { projectMemoryScope } from '../../explorer/shared/activity-scope.js';

const file = '/Users/private-person/work/secret-app/src/PrivatePanel.jsx';
const snapshot = {
  start: 1000, end: 3000, total: 1, groups: ['secret-app', 'secret-app-tools'],
  sessions: [{ id: 'real-session', title: 'Fix PrivatePanel.jsx and PrivatePanel in SECRET-APP', group: 'secret-app', projects: ['secret-app'], events: [[2000, 'edit', 'event-1', 'secret-app']], notes: [], outcomes: [], tokenSeries: [], metrics: { tokens: { status: 'missing' } } }],
  files: { 'real-session': [{ path: file, name: 'PrivatePanel.jsx', project: 'secret-app', edits: [{ t: 2000, id: 'event-1' }] }] },
  evidenceIndex: [{ id: 'event-1', t: 2000, category: 'edit', type: 'tool_file_edit', sessionId: 'real-session', project: 'secret-app', files: [file], text: `Modified: ${file}`, summary: 'secret-app-tools fixes PrivatePanel.jsx' }],
};

test('seeded aliases preserve evidence, file and session joins without mutating the source', () => {
  const before = structuredClone(snapshot);
  const result = obfuscateSnapshot(snapshot, { seed: 'proof' });
  assert.deepEqual(snapshot, before);
  assert.deepEqual(result.snapshot, obfuscateSnapshot(snapshot, { seed: 'proof' }).snapshot);
  assert.notDeepEqual(result.snapshot.groups, obfuscateSnapshot(snapshot, { seed: 'another' }).snapshot.groups);
  const json = JSON.stringify(result.snapshot);
  for (const value of ['secret-app', 'private-person', 'PrivatePanel', 'real-session']) assert.ok(!json.toLowerCase().includes(value.toLowerCase()), value);
  const s = result.snapshot.sessions[0];
  assert.equal(result.snapshot.evidenceIndex[0].sessionId, s.id);
  assert.equal(result.snapshot.files[s.id][0].path, result.snapshot.evidenceIndex[0].files[0]);
  assert.match(result.snapshot.files[s.id][0].name, /\.jsx$/);
  assert.deepEqual(s.events.map(e => e.slice(0, 3)), snapshot.sessions[0].events.map(e => e.slice(0, 3)));
  const projected = projectMemoryScope(result.snapshot, { from: 1000, through: 3000, project: s.group });
  assert.equal(projected.sessions.length, 1);
  assert.equal(projected.fileIndex.length, 1);
  assert.equal(projected.evidenceIndex.length, 1);
});

test('rejects an invalid snapshot and invalid override values', () => {
  assert.throws(() => obfuscateSnapshot({ sessions: [] }), /Memory state snapshot/);
  assert.throws(() => obfuscateSnapshot(snapshot, { replacements: { private: 42 } }), /Replacements/);
});

test('filenames and project aliases cannot rewrite schema keys or provider/category values', () => {
  const input = structuredClone(snapshot);
  input.sessions[0].provider = 'claude';
  input.sessions[0].projects = { 'secret-app': 1 };
  input.evidenceIndex[0].provider = 'claude';
  input.evidenceIndex[0].evidence = ['outcome'];
  input.files['real-session'].push(...['project.js', 'provider.js', 'CLAUDE.md', 'tool_file_edit.js'].map(name => ({ path: `/home/private-person/secret-app/${name}`, name, project: 'secret-app', edits: [{ t: 2000, id: 'event-1' }] })));
  const { snapshot: masked } = obfuscateSnapshot(input, { seed: 'proof', replacements: { claude: 'fake-provider' } });
  const s = masked.sessions[0];
  assert.equal(s.provider, 'claude');
  assert.equal(masked.evidenceIndex[0].provider, 'claude');
  assert.equal(masked.evidenceIndex[0].type, 'tool_file_edit');
  assert.equal(masked.evidenceIndex[0].category, 'edit');
  assert.deepEqual(Object.keys(s).sort(), Object.keys(input.sessions[0]).sort());
  assert.deepEqual(Object.keys(s.projects), [s.group]);
  const projected = projectMemoryScope(masked, { from: 1000, through: 3000, project: s.group, providers: ['claude'] });
  assert.equal(projected.sessions.length, 1);
  assert.equal(projected.fileIndex.length, 5);
});

test('longest, literal matches and explicit overrides apply without cascading aliases', () => {
  const result = obfuscateSnapshot(snapshot, { seed: 'proof', replacements: { 'secret-app': 'secret-app-tools', 'secret-app-tools': 'other-project', 'PrivatePanel.jsx': 'VisiblePanel.jsx' } });
  assert.equal(result.snapshot.sessions[0].group, 'secret-app-tools');
  assert.equal(result.snapshot.groups[1], 'other-project');
  assert.equal(result.snapshot.files[result.snapshot.sessions[0].id][0].name, 'VisiblePanel.jsx');
  assert.equal(result.replace('not-secret-app-related'), 'not-secret-app-related');
});
