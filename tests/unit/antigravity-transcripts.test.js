/**
 * tests/unit/antigravity-transcripts.test.js
 *
 * Milestone 3A verification:
 *   - scripts/antigravity-transcript-to-turns.awk (turn splitting, envelope stripping, signal harvesting)
 *   - scripts/antigravity-source.js (read-only SQLite metadata, worktree project inference, --show, --backfill)
 *   - scripts/resolve-transcript.sh (O(1) Antigravity conversation ID & stale path resolution)
 *   - scripts/retro-index.sh & scripts/catch-up-transcripts.sh (--provider antigravity, checkpointing, failure safety)
 *   - scripts/cartographer-search.sh --transcript (keyword search across Antigravity transcripts)
 *   - scripts/standup-silence.js (antigravityThreadMeta & subagent folding, never time-adjacency)
 *
 * Run with: node --test tests/unit/antigravity-transcripts.test.js
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';
import {
  defaultAntigravityRoots,
  readConversationMeta,
  inferAntigravityProject,
  backfillPreJsonl,
  showConversation,
} from '../../scripts/antigravity-source.js';
import {
  antigravityThreadMeta,
  antigravityTranscripts,
  foldAntigravityThreads,
} from '../../scripts/standup-silence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const AWK_ADAPTER = path.join(ROOT, 'scripts', 'antigravity-transcript-to-turns.awk');
const SOURCE_SCRIPT = path.join(ROOT, 'scripts', 'antigravity-source.js');
const RESOLVE_SCRIPT = path.join(ROOT, 'scripts', 'resolve-transcript.sh');
const RETRO_SCRIPT = path.join(ROOT, 'scripts', 'retro-index.sh');
const CATCHUP_SCRIPT = path.join(ROOT, 'scripts', 'catch-up-transcripts.sh');
const SEARCH_SCRIPT = path.join(ROOT, 'scripts', 'cartographer-search.sh');

const SESSION_ENV_KEYS = [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
  'ANTIGRAVITY_AGENT',
  'HERMES_SESSION_ID',
];

function cleanEnv(overrides = {}) {
  const env = { ...process.env, ...OFFLINE_INDEX_ENV };
  for (const key of SESSION_ENV_KEYS) delete env[key];
  delete env.CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR;
  delete env.CARTOGRAPHER_ANTIGRAVITY_IDE_TRANSCRIPTS_DIR;
  delete env.CARTOGRAPHER_ANTIGRAVITY_CLI_TRANSCRIPTS_DIR;
  delete env.CARTOGRAPHER_ANTIGRAVITY_DB;
  delete env.CARTOGRAPHER_INDEXER;
  return {
    ...env,
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_HERMES_CONFIG: path.join(os.tmpdir(), 'carto-test-no-hermes-config.json'),
    ...overrides,
  };
}

function mkTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(...args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
}

function writeAntigravityTranscript(brainRoot, conversationId, rows) {
  const logsDir = path.join(brainRoot, conversationId, '.system_generated', 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, 'transcript.jsonl');
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return file;
}

function createFixtureDb(dbPath, { summaries = [], parents = [], fts = [] } = {}) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE conversation_summaries (
        conversation_id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        preview TEXT NOT NULL DEFAULT '',
        step_count INTEGER NOT NULL DEFAULT 0,
        last_modified_time DATETIME NOT NULL DEFAULT '',
        workspace_uris TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL DEFAULT '',
        agent_name TEXT NOT NULL DEFAULT '',
        parent_conversation_id TEXT NOT NULL DEFAULT '',
        nesting_depth INTEGER NOT NULL DEFAULT 0,
        last_user_input_time DATETIME NOT NULL DEFAULT '',
        app_data_dir TEXT NOT NULL DEFAULT 'antigravity'
      );
      CREATE TABLE conversation_parents (
        conversation_id TEXT PRIMARY KEY,
        parent_id TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE conversations_fts USING fts5(
        conversation_id UNINDEXED,
        chunk_index UNINDEXED,
        chunk_first_step UNINDEXED,
        chunk_last_step UNINDEXED,
        last_modified_time UNINDEXED,
        step_count UNINDEXED,
        last_step_created_at UNINDEXED,
        archived UNINDEXED,
        user_step_byte_offsets UNINDEXED,
        agent_step_byte_offsets UNINDEXED,
        title,
        workspace,
        project,
        user_body,
        agent_body
      );
    `);

    const insSummary = db.prepare(`
      INSERT INTO conversation_summaries
        (conversation_id, title, preview, step_count, last_modified_time, workspace_uris, agent_name, parent_conversation_id, nesting_depth)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const s of summaries) {
      insSummary.run(
        s.conversation_id,
        s.title || '',
        s.preview || '',
        s.step_count ?? 10,
        s.last_modified_time || '2026-11-25 13:02:40.00000+00:00',
        typeof s.workspace_uris === 'string' ? s.workspace_uris : JSON.stringify(s.workspace_uris || []),
        s.agent_name || '',
        s.parent_conversation_id || '',
        s.nesting_depth ?? 0,
      );
    }

    const insParent = db.prepare('INSERT INTO conversation_parents (conversation_id, parent_id) VALUES (?, ?)');
    for (const p of parents) insParent.run(p.conversation_id, p.parent_id);

    const insFts = db.prepare(`
      INSERT INTO conversations_fts
        (conversation_id, chunk_index, chunk_first_step, chunk_last_step, last_modified_time, step_count, last_step_created_at, archived, user_step_byte_offsets, agent_step_byte_offsets, title, workspace, project, user_body, agent_body)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?, ?, ?, ?)
    `);
    for (const f of fts) {
      insFts.run(
        f.conversation_id,
        f.chunk_index ?? 0,
        f.chunk_first_step ?? 0,
        f.chunk_last_step ?? 10,
        f.last_modified_time ?? 1794248345663762000n,
        f.step_count ?? 10,
        f.last_step_created_at ?? 1794248265218852000n,
        f.title || '',
        f.workspace || '',
        f.project || '',
        f.user_body || '',
        f.agent_body || '',
      );
    }
  } finally {
    db.close();
  }
}

function makeStubIndexer(dir, { exitCode = 0 } = {}) {
  const captured = path.join(dir, 'indexed.jsonl');
  const envLog = path.join(dir, 'indexer-env.log');
  const script = path.join(dir, 'stub-indexer.sh');
  fs.writeFileSync(script, [
    '#!/usr/bin/env bash',
    `printf '%s\\n' "PE_GATE_REJECT=\${PE_GATE_REJECT:-}" >> ${JSON.stringify(envLog)}`,
    `cat >> ${JSON.stringify(captured)}`,
    `printf '\\n' >> ${JSON.stringify(captured)}`,
    `exit ${exitCode}`,
    '',
  ].join('\n'), { mode: 0o755 });
  return {
    script,
    readCaptured: () => (fs.existsSync(captured)
      ? fs.readFileSync(captured, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : []),
    readEnvLog: () => (fs.existsSync(envLog)
      ? fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean)
      : []),
  };
}

describe('antigravity-transcript-to-turns.awk', () => {
  test('splits multi-turn transcript, strips envelopes, harvests planner text & tool_calls, skips noise', () => {
    const dir = mkTempDir('ag-awk-');
    const sid = '6ae50945-e5bd-47b9-85a0-dddbaaac0148';
    const file = writeAntigravityTranscript(dir, sid, [
      {
        step_index: 0,
        source: 'SYSTEM',
        type: 'SYSTEM_MESSAGE',
        created_at: '2026-11-25T13:02:39Z',
        content: 'PRE_TURN_SYSTEM_NOISE should never appear',
      },
      {
        step_index: 1,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T13:02:40Z',
        content: [
          '<USER_REQUEST>',
          'Wire Antigravity transcripts into Cartographer search',
          '</USER_REQUEST>',
          '<ADDITIONAL_METADATA>',
          'The current local time is: 2026-11-25T05:02:40-08:00.',
          '</ADDITIONAL_METADATA>',
          '<USER_SETTINGS_CHANGE>',
          'The user changed setting Model Selection.',
          '</USER_SETTINGS_CHANGE>',
        ].join('\n'),
      },
      {
        step_index: 2,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:02:42Z',
        thinking: 'INTERNAL_THINKING_SHOULD_NOT_LEAK',
        tool_calls: [
          { name: 'update_focus', args: { focus: '"Designing Antigravity turn adapter"' } },
          { name: 'read_file', args: { Path: '"/workspace/session-cartographer/scripts/retro-index.sh"' } },
          { name: 'run_command', args: { CommandLine: '"node --test tests/unit/antigravity-transcripts.test.js"' } },
          { name: 'search_web', args: { query: '"sqlite fts5 readonly"' } },
        ],
      },
      {
        step_index: 3,
        source: 'MODEL',
        type: 'GENERIC',
        status: 'DONE',
        created_at: '2026-11-25T13:02:45Z',
        content: 'HUGE_RAW_TOOL_DUMP_NOISE with fake "type":"USER_INPUT" inside file contents',
      },
      {
        step_index: 4,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:02:50Z',
        content: 'Added the pure-awk adapter and wired retro-index.',
      },
      {
        step_index: 5,
        source: 'SYSTEM',
        type: 'CONVERSATION_HISTORY',
        created_at: '2026-11-25T13:03:00Z',
        content: 'CONVERSATION_HISTORY_NOISE',
      },
      {
        step_index: 6,
        source: 'USER_EXPLICIT',
        type: 'USER_INPUT',
        status: 'DONE',
        created_at: '2026-11-25T13:05:00Z',
        content: '<USER_REQUEST>\nRun the unit tests now\n</USER_REQUEST>',
      },
      {
        step_index: 7,
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        created_at: '2026-11-25T13:05:10Z',
        content: 'All four suites passed with zero failures.',
      },
    ]);

    const output = execFileSync('awk', [
      '-f', AWK_ADAPTER,
      '-v', `sid=${sid}`,
      '-v', 'proj=session-cartographer',
      '-v', `tpath=${file}`,
      file,
    ], { encoding: 'utf8', env: cleanEnv({ LC_ALL: 'C' }) });

    const turns = output.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(turns.length, 2, 'GENERIC fake USER_INPUT must not split a third turn');

    assert.equal(turns[0].event_id, `turn-antigravity-${sid}-1`);
    assert.equal(turns[0].timestamp, '2026-11-25T13:02:40Z');
    assert.equal(turns[0].project, 'session-cartographer');
    assert.equal(turns[0].type, 'transcript');
    assert.equal(turns[0].provider, 'antigravity');
    assert.equal(turns[0].transcript_path, file);
    assert.equal(turns[0].session, sid);
    assert.equal(turns[0].turn_idx, 1);

    assert.match(turns[0].summary, /Wire Antigravity transcripts into Cartographer search/);
    assert.match(turns[0].summary, /Designing Antigravity turn adapter/);
    assert.match(turns[0].summary, /scripts\/retro-index\.sh/);
    assert.match(turns[0].summary, /sqlite fts5 readonly/);
    assert.match(turns[0].summary, /Added the pure-awk adapter and wired retro-index/);
    assert.doesNotMatch(turns[0].summary, /USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|Model Selection|current local time/);
    assert.doesNotMatch(turns[0].summary, /HUGE_RAW_TOOL_DUMP_NOISE|PRE_TURN_SYSTEM_NOISE|CONVERSATION_HISTORY_NOISE|INTERNAL_THINKING_SHOULD_NOT_LEAK/);

    assert.equal(turns[1].event_id, `turn-antigravity-${sid}-2`);
    assert.equal(turns[1].timestamp, '2026-11-25T13:05:00Z');
    assert.equal(turns[1].turn_idx, 2);
    assert.match(turns[1].summary, /Run the unit tests now/);
    assert.match(turns[1].summary, /All four suites passed/);
  });
});

describe('antigravity-source.js', () => {
  test('resolves git repo and worktree workspace_uris from SQLite DB, and falls back to transcript tool_calls when DB absent', () => {
    const tmp = mkTempDir('ag-source-proj-');
    const dev = path.join(tmp, 'dev');
    const mainRepo = path.join(dev, 'orbital-engine');
    const worktreeDir = path.join(dev, 'worktrees', 'orbital-feat-abc123');
    fs.mkdirSync(mainRepo, { recursive: true });
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    fs.writeFileSync(path.join(mainRepo, 'README.md'), '# Orbital\n');
    git('-C', mainRepo, 'init', '-q');
    git('-C', mainRepo, 'add', '.');
    git('-C', mainRepo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'init');
    git('-C', mainRepo, 'worktree', 'add', '-q', '-b', 'feat-abc', worktreeDir);

    const dbPath = path.join(tmp, 'conversation_summaries.db');
    createFixtureDb(dbPath, {
      summaries: [
        {
          conversation_id: 'conv-main-repo',
          title: 'Main checkout work',
          workspace_uris: [pathToFileURL(mainRepo).href],
        },
        {
          conversation_id: 'conv-worktree',
          title: 'Worktree feature work',
          workspace_uris: [pathToFileURL(worktreeDir).href],
        },
        {
          conversation_id: 'conv-non-project',
          title: 'Opened in dev root',
          workspace_uris: [pathToFileURL(dev).href],
        },
      ],
    });

    const env = cleanEnv({ CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_ANTIGRAVITY_DB: dbPath });
    const meta = readConversationMeta(dbPath, { env, workspaceRoot: dev });
    assert.equal(meta.get('conv-main-repo')?.project, 'orbital-engine');
    assert.equal(meta.get('conv-worktree')?.project, 'orbital-engine', 'worktree URI must resolve via git common dir to main repo name');
    assert.equal(meta.get('conv-non-project')?.project, null, 'workspace root dev must be filtered by isNonProject');

    // Fallback to transcript tool_calls when DB is missing or workspace was generic `dev`.
    const brain = path.join(tmp, 'brain');
    const tpath = writeAntigravityTranscript(brain, 'conv-no-db', [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T10:00:00Z', content: 'Fix orbital' },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T10:00:05Z',
        tool_calls: [
          { name: 'read_file', args: { Path: JSON.stringify(path.join(worktreeDir, 'README.md')) } },
          { name: 'run_command', args: { CommandLine: JSON.stringify(`cd ${mainRepo} && git status`) } },
        ],
      },
    ]);

    const missingDb = path.join(tmp, 'does-not-exist.db');
    assert.equal(readConversationMeta(missingDb, { env, workspaceRoot: dev }).size, 0);
    assert.equal(
      inferAntigravityProject('conv-no-db', tpath, { dbPath: missingDb, workspaceRoot: dev, env }),
      'orbital-engine',
    );
    assert.equal(
      inferAntigravityProject('conv-non-project', tpath, { dbPath, workspaceRoot: dev, env }),
      'orbital-engine',
    );
    assert.equal(
      inferAntigravityProject('conv-unknown', '', { dbPath: missingDb, workspaceRoot: dev, env }),
      'unknown',
    );

    // CLI --project mode check
    const cli = spawnSync(process.execPath, [SOURCE_SCRIPT, '--project', 'conv-worktree'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stdout.trim(), 'orbital-engine');

    // defaultAntigravityRoots isolation
    assert.deepEqual(defaultAntigravityRoots({ CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain }, '/fake-home'), [path.resolve(brain)]);
    const defaults = defaultAntigravityRoots({}, '/fake-home');
    assert.equal(defaults.length, 3);
    assert.ok(defaults[0].endsWith(path.join('.gemini', 'antigravity', 'brain')));
    assert.ok(defaults[1].endsWith(path.join('.gemini', 'antigravity-ide', 'brain')));
    assert.ok(defaults[2].endsWith(path.join('.gemini', 'antigravity-cli', 'brain')));
  });

  test('pre-JSONL backfill dry-run, --write, skips JSONL conversations, checkpoints only on success, and --show works for both sources', () => {
    const tmp = mkTempDir('ag-backfill-');
    const dev = path.join(tmp, 'dev');
    const repo = path.join(dev, 'plasma-sim');
    const brain = path.join(tmp, 'brain');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(brain, { recursive: true });

    // Conversation 1: ALREADY has transcript.jsonl on disk -> backfill must skip it.
    writeAntigravityTranscript(brain, 'conv-has-jsonl', [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T11:00:00Z', content: '<USER_REQUEST>\nCheck jsonl path\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-25T11:00:05Z', content: 'Verified from jsonl.' },
    ]);

    const dbPath = path.join(tmp, 'conversation_summaries.db');
    createFixtureDb(dbPath, {
      summaries: [
        {
          conversation_id: 'conv-has-jsonl',
          title: 'Live JSONL Conv',
          workspace_uris: [pathToFileURL(repo).href],
          last_modified_time: '2026-11-25 11:00:10+00:00',
        },
        {
          conversation_id: 'conv-pre-jsonl',
          title: 'Pre-JSONL Historical Conv',
          workspace_uris: [pathToFileURL(repo).href],
          last_modified_time: '2026-11-20 09:30:00+00:00',
        },
      ],
      fts: [
        {
          conversation_id: 'conv-has-jsonl',
          chunk_index: 0,
          user_body: 'Check jsonl path',
          agent_body: 'Verified from jsonl.',
        },
        {
          conversation_id: 'conv-pre-jsonl',
          chunk_index: -1,
          last_modified_time: 1795167000000000000n, // nanosecond BigInt (> MAX_SAFE_INTEGER)
          user_body: '',
          agent_body: '',
        },
        {
          conversation_id: 'conv-pre-jsonl',
          chunk_index: 0,
          last_modified_time: 0n,
          last_step_created_at: 0n,
          user_body: 'Explain the spinodal solver convergence',
          agent_body: 'Adaptive dt stabilizes the Cahn-Hilliard step.',
        },
      ],
    });

    const okStubDir = path.join(tmp, 'ok-stub');
    fs.mkdirSync(okStubDir, { recursive: true });
    const okStub2 = makeStubIndexer(okStubDir, { exitCode: 0 });
    const env = cleanEnv({
      CARTOGRAPHER_DEV_DIR: dev,
      CARTOGRAPHER_ANTIGRAVITY_DB: dbPath,
      CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain,
      CARTOGRAPHER_INDEXER: okStub2.script,
    });

    // 1. Dry-run writes nothing and creates no checkpoint.
    const dry = backfillPreJsonl({ dbPath, roots: [brain], devRoot: dev, indexer: okStub2.script, env, write: false });
    assert.equal(dry.dry_run, true);
    assert.equal(dry.skipped_has_jsonl, 1);
    assert.equal(dry.conversations_selected, 1);
    assert.equal(dry.turns_generated, 1);
    assert.equal(okStub2.readCaptured().length, 0);
    const progressFile = path.join(dev, '.carto', 'antigravity-sqlite-progress');
    assert.equal(fs.existsSync(progressFile), false);

    // 2. Failing indexer must NOT checkpoint.
    const failDir = mkTempDir('ag-fail-stub-');
    const failStub = makeStubIndexer(failDir, { exitCode: 1 });
    const failed = backfillPreJsonl({ dbPath, roots: [brain], devRoot: dev, indexer: failStub.script, env, write: true });
    assert.equal(failed.turns_failed, 1);
    assert.equal(failed.conversations_backfilled, 0);
    assert.equal(fs.existsSync(progressFile), false, 'failed index must not checkpoint');

    // 3. Succeeding --write indexes pre-JSONL turns with PE_GATE_REJECT=2.0 and checkpoints.
    const written = backfillPreJsonl({ dbPath, roots: [brain], devRoot: dev, indexer: okStub2.script, env, write: true });
    assert.equal(written.turns_indexed, 1);
    assert.equal(written.turns_failed, 0);
    assert.equal(written.conversations_backfilled, 1);
    const docs = okStub2.readCaptured();
    assert.equal(docs.length, 1);
    assert.equal(docs[0].event_id, 'turn-antigravity-conv-pre-jsonl-1');
    assert.equal(docs[0].provider, 'antigravity');
    assert.equal(docs[0].project, 'plasma-sim');
    assert.match(docs[0].summary, /Cahn-Hilliard/);
    assert.ok(okStub2.readEnvLog().includes('PE_GATE_REJECT=2.0'));
    assert.equal(fs.existsSync(progressFile), true);

    // 4. Second run skips already-checkpointed conversation.
    const second = backfillPreJsonl({ dbPath, roots: [brain], devRoot: dev, indexer: okStub2.script, env, write: true });
    assert.equal(second.skipped_checkpointed, 1);
    assert.equal(second.turns_indexed, 0);

    // 5. --show works for both JSONL and SQLite FTS-only conversations.
    const shownJsonl = showConversation('conv-has-jsonl', { dbPath, roots: [brain], workspaceRoot: dev, env });
    assert.equal(shownJsonl.source, 'jsonl');
    assert.match(shownJsonl.turns[0].summary, /Verified from jsonl/);

    const shownFts = showConversation('conv-pre-jsonl', { dbPath, roots: [brain], workspaceRoot: dev, env });
    assert.equal(shownFts.source, 'sqlite_fts');
    assert.match(shownFts.turns[0].summary, /Cahn-Hilliard/);

    const cliShow = spawnSync(process.execPath, [SOURCE_SCRIPT, '--show', 'conv-pre-jsonl'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(cliShow.status, 0, cliShow.stderr);
    assert.match(cliShow.stdout, /Pre-JSONL Historical Conv/);
    assert.match(cliShow.stdout, /Cahn-Hilliard/);
  });
});

describe('resolve-transcript.sh', () => {
  test('resolves bare Antigravity conversation ID and stale path; misses stay misses', () => {
    const tmp = mkTempDir('ag-resolve-');
    const brain = path.join(tmp, 'brain');
    const cid = '96490e7b-8369-458e-866c-820cc8dd700f';
    const expected = writeAntigravityTranscript(brain, cid, [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T14:00:00Z', content: 'hello' },
    ]);

    const env = cleanEnv({
      CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain,
      CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: path.join(tmp, 'empty-claude'),
      CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(tmp, 'empty-codex'),
      CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(tmp, 'empty-archive'),
    });

    // Bare conversation ID
    const r1 = spawnSync('bash', [RESOLVE_SCRIPT, cid], { encoding: 'utf8', env });
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r1.stdout.trim(), expected);

    // Stale path from another machine/root
    const stale = `/old/home/.gemini/antigravity/brain/${cid}/.system_generated/logs/transcript.jsonl`;
    const r2 = spawnSync('bash', [RESOLVE_SCRIPT, stale], { encoding: 'utf8', env });
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r2.stdout.trim(), expected);

    // Miss stays a miss (exit 1, empty stdout)
    const r3 = spawnSync('bash', [RESOLVE_SCRIPT, '00000000-0000-0000-0000-000000000000'], { encoding: 'utf8', env });
    assert.equal(r3.status, 1);
    assert.equal(r3.stdout.trim(), '');
  });
});

describe('retro-index.sh and catch-up-transcripts.sh (--provider antigravity)', () => {
  test('indexes Antigravity transcripts, checkpoints on success, skips unchanged, refuses to checkpoint on failure', () => {
    const tmp = mkTempDir('ag-retro-');
    const dev = path.join(tmp, 'dev');
    const repo = path.join(dev, 'photon-mapper');
    const brain = path.join(tmp, 'brain');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(brain, { recursive: true });

    const cid = 'abcd1234-1111-4222-8333-444455556666';
    writeAntigravityTranscript(brain, cid, [
      { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T12:00:00Z', content: '<USER_REQUEST>\nTrace caustics bug\n</USER_REQUEST>' },
      { step_index: 1, type: 'PLANNER_RESPONSE', created_at: '2026-11-25T12:00:05Z', content: 'Fixed photon k-d tree radius.' },
      { step_index: 2, type: 'USER_INPUT', created_at: '2026-11-25T12:02:00Z', content: '<USER_REQUEST>\nAdd regression test\n</USER_REQUEST>' },
      { step_index: 3, type: 'PLANNER_RESPONSE', created_at: '2026-11-25T12:02:05Z', content: 'Added unit test.' },
    ]);

    const dbPath = path.join(tmp, 'conversation_summaries.db');
    createFixtureDb(dbPath, {
      summaries: [{
        conversation_id: cid,
        title: 'Caustics fix',
        workspace_uris: [pathToFileURL(repo).href],
      }],
    });

    // 1. Failing indexer leaves session uncheckpointed and exits non-zero.
    const failStubDir = mkTempDir('ag-retro-fail-');
    const failStub = makeStubIndexer(failStubDir, { exitCode: 1 });
    const failEnv = cleanEnv({
      CARTOGRAPHER_DEV_DIR: dev,
      CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain,
      CARTOGRAPHER_ANTIGRAVITY_DB: dbPath,
      CARTOGRAPHER_INDEXER: failStub.script,
    });
    const rFail = spawnSync('bash', [RETRO_SCRIPT, '--provider', 'antigravity'], { encoding: 'utf8', env: failEnv });
    assert.notEqual(rFail.status, 0);
    const progressFile = path.join(dev, '.carto', 'retro-index-progress');
    const progressAfterFail = fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8').trim() : '';
    assert.equal(progressAfterFail, '', 'failed indexing run must not write a checkpoint');

    // 2. Succeeding indexer indexes 2 turns and writes checkpoint.
    const okStubDir = mkTempDir('ag-retro-ok-');
    const okStub = makeStubIndexer(okStubDir, { exitCode: 0 });
    const okEnv = cleanEnv({
      CARTOGRAPHER_DEV_DIR: dev,
      CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain,
      CARTOGRAPHER_ANTIGRAVITY_DB: dbPath,
      CARTOGRAPHER_INDEXER: okStub.script,
    });
    const rOk = spawnSync('bash', [RETRO_SCRIPT, '--provider', 'antigravity'], { encoding: 'utf8', env: okEnv });
    assert.equal(rOk.status, 0, rOk.stdout + rOk.stderr);
    const docs = okStub.readCaptured();
    assert.equal(docs.length, 2);
    assert.equal(docs[0].event_id, `turn-antigravity-${cid}-1`);
    assert.equal(docs[0].provider, 'antigravity');
    assert.equal(docs[0].project, 'photon-mapper');
    assert.match(docs[0].summary, /Trace caustics bug/);
    assert.equal(docs[1].event_id, `turn-antigravity-${cid}-2`);
    const progressLines = fs.readFileSync(progressFile, 'utf8').trim().split('\n');
    assert.equal(progressLines.length, 1);
    assert.match(progressLines[0], new RegExp(`^antigravity ${cid} \\d+ photon-mapper$`));

    // 3. Second run skips unchanged session without calling indexer again.
    const rSkip = spawnSync('bash', [RETRO_SCRIPT, '--provider', 'antigravity'], { encoding: 'utf8', env: okEnv });
    assert.equal(rSkip.status, 0, rSkip.stdout + rSkip.stderr);
    assert.match(rSkip.stdout, /Skipping \(already indexed\):/);
    assert.match(rSkip.stdout, /skipped 1 already-indexed session\(s\)/);
    assert.equal(okStub.readCaptured().length, 2, 'unchanged session must not be re-indexed');

    // 4. catch-up-transcripts.sh accepts --provider antigravity cleanly.
    const rCatchup = spawnSync('bash', [CATCHUP_SCRIPT, '--provider', 'antigravity', '--force'], {
      encoding: 'utf8',
      env: okEnv,
    });
    assert.equal(rCatchup.status, 0, rCatchup.stdout + rCatchup.stderr);
  });
});

describe('cartographer-search.sh --transcript', () => {
  test('finds distinctive token inside Antigravity transcript.jsonl with provider antigravity', () => {
    const tmp = mkTempDir('ag-search-');
    const dev = path.join(tmp, 'dev');
    const repo = path.join(dev, 'quasar-synth');
    const brain = path.join(tmp, 'brain');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(brain, { recursive: true });

    const cid = '12345678-aaaa-4bbb-8ccc-dddddddddddd';
    const token = 'ZIRCONIUM_HARMONIC_7741';
    writeAntigravityTranscript(brain, cid, [
      {
        step_index: 0,
        type: 'USER_INPUT',
        created_at: '2026-11-25T13:30:00Z',
        content: `<USER_REQUEST>\nCalibrate the ${token} wavetable oscillator\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal time\n</ADDITIONAL_METADATA>`,
      },
      {
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        created_at: '2026-11-25T13:30:12Z',
        content: `Tuned ${token} phase accumulator cleanly.`,
      },
      {
        step_index: 2,
        type: 'GENERIC',
        created_at: '2026-11-25T13:30:15Z',
        content: 'RAW_GENERIC_ONLY_TOKEN_9911',
      },
    ]);

    const dbPath = path.join(tmp, 'conversation_summaries.db');
    createFixtureDb(dbPath, {
      summaries: [{
        conversation_id: cid,
        title: 'Wavetable tuning',
        workspace_uris: [pathToFileURL(repo).href],
      }],
    });

    const env = cleanEnv({
      CARTOGRAPHER_DEV_DIR: dev,
      CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain,
      CARTOGRAPHER_ANTIGRAVITY_DB: dbPath,
      CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: path.join(tmp, 'no-claude'),
      CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(tmp, 'no-codex'),
      CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(tmp, 'no-archive'),
    });

    const res = spawnSync('bash', [SEARCH_SCRIPT, token, '--transcript', '--no-turbo', '--format', 'jsonl'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const rows = res.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(rows.length >= 1, `expected at least 1 hit, got: ${res.stdout}`);
    const hit = rows.find((r) => r.event_id === `turn-antigravity-${cid}-1`);
    assert.ok(hit, `expected turn-antigravity-${cid}-1 in ${JSON.stringify(rows)}`);
    assert.match(hit.extras, /(^|\|)provider:antigravity(\||$)/);
    assert.equal(hit.project, 'quasar-synth');
    assert.match(hit.summary, new RegExp(token));
    assert.doesNotMatch(hit.summary, /USER_REQUEST|ADDITIONAL_METADATA/);

    const textRes = spawnSync('bash', [SEARCH_SCRIPT, token, '--transcript', '--no-turbo'], {
      encoding: 'utf8',
      env,
    });
    assert.equal(textRes.status, 0, textRes.stdout + textRes.stderr);
    assert.match(textRes.stdout, /provider:\s*antigravity/);
    assert.match(textRes.stdout, new RegExp(token));
  });
});

describe('standup-silence.js Antigravity thread folding', () => {
  test('folds Antigravity subagents under parent_conversation_id and conversation_parents; never folds by time adjacency', () => {
    const tmp = mkTempDir('ag-standup-');
    const brain = path.join(tmp, 'brain');
    const parentId = '6ae50945-e5bd-47b9-85a0-dddbaaac0148';
    const childFromSummaries = '96490e7b-8369-458e-866c-820cc8dd700f';
    const childFromParentsTable = 'abe2e7b3-2722-4f9f-bb86-e9c94c62861c';
    const standaloneSibling = 'cccccccc-1111-4222-8333-444455556666';
    const sentinelParentChild = 'dddddddd-1111-4222-8333-444455556666';

    for (const id of [parentId, childFromSummaries, childFromParentsTable, standaloneSibling, sentinelParentChild]) {
      writeAntigravityTranscript(brain, id, [
        { step_index: 0, type: 'USER_INPUT', created_at: '2026-11-25T14:00:00Z', content: 'work' },
      ]);
    }

    const dbPath = path.join(tmp, 'conversation_summaries.db');
    createFixtureDb(dbPath, {
      summaries: [
        { conversation_id: parentId, parent_conversation_id: '', nesting_depth: 0 },
        { conversation_id: childFromSummaries, parent_conversation_id: parentId, agent_name: 'self', nesting_depth: 1 },
        { conversation_id: childFromParentsTable, parent_conversation_id: '', agent_name: 'research', nesting_depth: 1 },
        { conversation_id: standaloneSibling, parent_conversation_id: '', nesting_depth: 0 },
        { conversation_id: sentinelParentChild, parent_conversation_id: 'unknown', nesting_depth: 0 },
      ],
      parents: [
        { conversation_id: childFromParentsTable, parent_id: parentId },
      ],
    });

    const env = cleanEnv({ CARTOGRAPHER_ANTIGRAVITY_DB: dbPath, CARTOGRAPHER_ANTIGRAVITY_TRANSCRIPTS_DIR: brain });
    const meta = antigravityThreadMeta(env);
    assert.equal(meta.get(childFromSummaries)?.parent, parentId);
    assert.equal(meta.get(childFromSummaries)?.subagent, 'self');
    assert.equal(meta.get(childFromParentsTable)?.parent, parentId);
    assert.equal(meta.get(standaloneSibling)?.parent, null);
    assert.equal(meta.get(sentinelParentChild)?.parent, null, 'sentinel "unknown" parent must not resolve');

    const transcripts = antigravityTranscripts({ env, sinceMs: Date.now() - 3600e3 });
    assert.equal(transcripts.length, 5);

    const folded = foldAntigravityThreads(transcripts, meta);
    assert.deepEqual(
      folded.subthreads.map((t) => t.id).sort(),
      [childFromSummaries, childFromParentsTable].sort(),
    );
    assert.equal(folded.byParent.get(parentId)?.length, 2);
    assert.deepEqual(
      folded.standalone.map((t) => t.id).sort(),
      [parentId, sentinelParentChild, standaloneSibling].sort(),
      'concurrent standalone threads must never fold by time adjacency',
    );

    // Graceful no-op when DB is missing
    const missingMeta = antigravityThreadMeta({ CARTOGRAPHER_ANTIGRAVITY_DB: path.join(tmp, 'missing.db') });
    assert.equal(missingMeta.size, 0);
  });
});
