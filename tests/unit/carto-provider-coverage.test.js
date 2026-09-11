/**
 * The Explorer went provider-blind while half the corpus became Codex.
 *
 * Every defect covered here returned a confident, well-formed, wrong answer —
 * a session list that rendered a mixed corpus as one agent, and a
 * "transcript not found" for a transcript sitting in Codex's archive. So each
 * test asserts on composition, not on "it returned something": which agent a
 * fold attributed, which derivation branch ran, whether a resolved path is the
 * one the caller asked for.
 */

// Pin the semantic leg off before anything imports the search module: a live
// Qdrant would leak corpus ids into these expectations.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

for (const name of ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID']) {
  delete process.env[name];
}

const { summarizeSessions, attributeProvider } = await import('../../explorer/server/sessions.js');
const { attributeProvider: attributeProviderClient } = await import('../../explorer/src/lib/provider.js');
const { computeFacets } = await import('../../explorer/server/search.js');
const { codexSessionIndex, resolveTranscriptPath, isResolvableNeedle } = await import('../../explorer/server/transcripts.js');

const NOW = Date.parse('2026-09-11T12:00:00Z');
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000).toISOString();

function event(overrides) {
  return { event_id: `e${Math.random().toString(36).slice(2)}`, timestamp: at(10), project: 'alpha', type: 'tool_bash', ...overrides };
}

test('the session fold attributes an agent to every session that recorded one', () => {
  const { sessions } = summarizeSessions([
    event({ session_id: 'codex-a', provider: 'codex' }),
    event({ session_id: 'codex-a', provider: 'codex', timestamp: at(9) }),
    event({ session_id: 'claude-a', provider: 'claude' }),
    event({ session_id: 'claude-a', provider: 'claude', timestamp: at(8) }),
  ], { now: NOW });

  const byId = Object.fromEntries(sessions.map(s => [s.session_id, s]));
  assert.equal(byId['codex-a'].provider, 'codex');
  assert.equal(byId['claude-a'].provider, 'claude');

  // The point of the fix: both agents are present and distinguishable. A fold
  // that dropped the field would pass an "is it non-empty" check on either row.
  assert.deepEqual(new Set(sessions.map(s => s.provider)), new Set(['codex', 'claude']));
});

test('sentinel providers never become a third agent, and a mixed session stays mixed', () => {
  const { sessions } = summarizeSessions([
    event({ session_id: 'blank', provider: '' }),
    event({ session_id: 'blank', provider: 'unknown', timestamp: at(9) }),
    event({ session_id: 'blank', provider: null, timestamp: at(8) }),
    event({ session_id: 'mixed', provider: 'codex' }),
    event({ session_id: 'mixed', provider: 'codex', timestamp: at(9) }),
    event({ session_id: 'mixed', provider: 'claude', timestamp: at(8) }),
  ], { now: NOW });

  const byId = Object.fromEntries(sessions.map(s => [s.session_id, s]));
  assert.equal(byId.blank.provider, '', '"unknown" is truthy — it must not survive as an agent name');
  assert.deepEqual(byId.blank.providers, []);

  assert.equal(byId.mixed.provider, 'codex', 'majority wins');
  assert.deepEqual(byId.mixed.providers, ['codex', 'claude'], 'but the minority stays visible');
});

test('unattributed records do not merge into one phantom session', () => {
  const { sessions } = summarizeSessions([
    event({ session_id: 'unknown', project: 'alpha' }),
    event({ session_id: 'unknown', project: 'beta', timestamp: at(9) }),
    event({ session_id: '', project: 'gamma', timestamp: at(8) }),
    event({ session_id: 'real', provider: 'codex' }),
    event({ session_id: 'real', provider: 'codex', timestamp: at(7) }),
  ], { now: NOW });

  assert.deepEqual(sessions.map(s => s.session_id), ['real']);
});

test('transcript derivation is per-provider — a Codex session never gets a ~/.claude path', () => {
  const asked = [];
  const deriveTranscript = (spec) => {
    asked.push(spec);
    // Stand in for the real derivation: only the Claude branch can produce a
    // ~/.claude/projects path, and it is reached only when provider allows it.
    if (spec.provider === 'codex') return '';
    return `/home/u/.claude/projects/-alpha/${spec.session_id}.jsonl`;
  };

  const { sessions } = summarizeSessions([
    event({ session_id: 'codex-a', provider: 'codex' }),
    event({ session_id: 'codex-a', provider: 'codex', timestamp: at(9) }),
    event({ session_id: 'claude-a', provider: 'claude' }),
    event({ session_id: 'claude-a', provider: 'claude', timestamp: at(8) }),
  ], { now: NOW, deriveTranscript });

  const byId = Object.fromEntries(sessions.map(s => [s.session_id, s]));

  // The fixture proves the Claude branch really runs — without this assertion a
  // fold that derived nothing at all would also pass the next one.
  assert.match(byId['claude-a'].transcript_path, /\.claude\/projects/);
  assert.equal(byId['codex-a'].transcript_path, '');

  // And the derivation is told which agent it is deriving for, which is the
  // whole repair: the old code had no provider to branch on.
  assert.deepEqual(asked.map(s => s.provider).sort(), ['claude', 'codex']);
});

test('a recorded path that no longer resolves is reported as unresolved, not absent', () => {
  const { sessions } = summarizeSessions([
    event({ session_id: 'archived', provider: 'codex', transcript_path: '/gone/rollout.jsonl' }),
    event({ session_id: 'archived', provider: 'codex', timestamp: at(9) }),
    event({ session_id: 'never-had-one', provider: 'codex' }),
    event({ session_id: 'never-had-one', provider: 'codex', timestamp: at(9) }),
    event({ session_id: 'recovered', provider: 'codex', transcript_path: '/gone/other.jsonl' }),
    event({ session_id: 'recovered', provider: 'codex', timestamp: at(9) }),
  ], {
    now: NOW,
    deriveTranscript: ({ session_id }) => session_id === 'recovered' ? '/archive/other.jsonl' : '',
  });

  const byId = Object.fromEntries(sessions.map(s => [s.session_id, s]));
  assert.equal(byId.archived.transcript_path_status, 'unresolved');
  assert.equal(byId['never-had-one'].transcript_path_status, 'absent');
  assert.equal(byId.recovered.transcript_path_status, 'resolved');
});

test('search facets expose the producing agent and ignore the pipeline\'s three spellings of absence', () => {
  const facets = computeFacets([
    { provider: 'codex', project: 'alpha', timestamp: at(1) },
    { provider: 'codex', project: 'alpha', timestamp: at(2) },
    { provider: 'Claude', project: 'alpha', timestamp: at(3) },
    { provider: 'unknown', project: 'alpha', timestamp: at(4) },
    { provider: '', project: 'alpha', timestamp: at(5) },
    { provider: null, project: 'alpha', timestamp: at(6) },
  ]);

  assert.deepEqual(facets.providers, [
    { name: 'codex', count: 2 },
    { name: 'claude', count: 1 },
  ], 'case is normalized, sentinels are not agents');
});

test('the client and server copies of provider attribution agree', () => {
  const cases = [
    [],
    [{ provider: 'codex' }],
    [{ provider: 'unknown' }, { provider: '' }, { provider: null }],
    [{ provider: 'codex' }, { provider: 'codex' }, { provider: 'claude' }],
    [{ provider: 'CLAUDE' }, { provider: 'claude' }, { provider: 'codex' }],
    [{ provider: ' codex ' }, { provider: 'codex' }],
    [{}, { provider: undefined }],
  ];
  for (const events of cases) {
    assert.deepEqual(
      attributeProviderClient(events),
      attributeProvider(events),
      `client and server disagree on ${JSON.stringify(events)}`,
    );
  }
});

test('an archived Codex transcript resolves from the path recorded before it moved', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-codex-')));
  const live = path.join(root, 'sessions', '2026', '09', '04');
  const archive = path.join(root, 'archived_sessions');
  fs.mkdirSync(live, { recursive: true });
  fs.mkdirSync(archive, { recursive: true });

  const name = 'rollout-2026-09-04T05-51-50-01a06c79-b4a9-77a0-bc89-80b9d068e8c8.jsonl';
  const recorded = path.join(live, name);          // what the hook stamped
  const actual = path.join(archive, name);          // where Codex moved it
  fs.writeFileSync(actual, '{"type":"session_meta"}\n');

  const prior = { ...process.env };
  process.env.CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR = path.join(root, 'sessions');
  process.env.CARTOGRAPHER_CODEX_ARCHIVED_DIR = archive;
  process.env.CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR = path.join(root, 'claude');

  try {
    // The defect this covers is an absence: the recorded path must really be
    // gone, or a resolver that only stats it would pass too.
    assert.equal(fs.existsSync(recorded), false);

    assert.equal(resolveTranscriptPath(recorded, { cache: new Map() }), actual);

    // A bare session id resolves the same way.
    assert.equal(
      resolveTranscriptPath('01a06c79-b4a9-77a0-bc89-80b9d068e8c8', { cache: new Map() }),
      actual,
    );

    // A genuine miss stays a miss rather than returning something plausible.
    assert.equal(resolveTranscriptPath('no-such-session', { cache: new Map() }), '');

    // Glob metacharacters never reach the resolver's find.
    assert.equal(isResolvableNeedle('*'), false);
    assert.equal(resolveTranscriptPath('*', { cache: new Map() }), '');

    const index = codexSessionIndex({ env: process.env, home: root, force: true });
    assert.equal(index.get('01a06c79-b4a9-77a0-bc89-80b9d068e8c8'), actual);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in prior)) delete process.env[key];
    Object.assign(process.env, prior);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the bulk index keeps a session uuid whose first group is all digits', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-codex-id-')));
  const archive = path.join(root, 'archived_sessions');
  fs.mkdirSync(archive, { recursive: true });
  // Trimming leading digits off the basename would eat this id's own head.
  const id = '01234567-89ab-7cde-8f01-23456789abcd';
  const file = path.join(archive, `rollout-2026-09-04T05-51-50-${id}.jsonl`);
  fs.writeFileSync(file, '{"type":"session_meta"}\n');

  const index = codexSessionIndex({
    env: { CARTOGRAPHER_CODEX_ARCHIVED_DIR: archive, CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(root, 'sessions') },
    home: root,
    force: true,
  });

  assert.equal(index.get(id), file);
  fs.rmSync(root, { recursive: true, force: true });
});
