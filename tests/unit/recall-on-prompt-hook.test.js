/**
 * tests/unit/recall-on-prompt-hook.test.js
 *
 * surface-recall-on-prompt.sh runs recall when a user prompt carries a memory
 * cue and injects the hits as UserPromptSubmit context. These tests pipe real
 * payloads into the hook over a fixture corpus, with the semantic leg pinned off
 * and Turbo off, so every answer comes from the portable keyword path.
 *
 * What matters beyond "it printed something": the served rows must name exactly
 * the hits that were injected (an unseen served row skews hit rate and, through
 * delta serving, hides that event from the agent's next /remember), and every
 * abstention must say why in the trial log, because the trial log is how this
 * hook gets judged.
 *
 * Run with: node --test tests/unit/recall-on-prompt-hook.test.js
 */
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'surface-recall-on-prompt.sh');
const IDENTITY_VARS = ['CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID', 'CARTOGRAPHER_PROVIDER', 'CODEX_THREAD_ID', 'CODEX_HOME', 'HERMES_SESSION_ID',
  'CARTOGRAPHER_RECALL_ON_PROMPT', 'CARTOGRAPHER_RECALL_ON_PROMPT_BUDGET_MS',
  'CARTOGRAPHER_RECALL_ON_PROMPT_MIN_SCORE', 'CARTOGRAPHER_RECALL_ON_PROMPT_LOG'];
const SID = 'sess-asking-0001';
const CUE = "didn't we fix the wheel scroll jank last week?";

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * Hits about the wheel jank at high salience (so they clear the 0.010 floor on
 * the keyword ladder alone: 0.9/61 = 0.0148), one of them from the asking
 * session; one weak hit at the 0.05 salience floor (0.05/61 = 0.0008) whose
 * token appears nowhere else; and filler so BM25 does not clamp the query terms.
 */
function makeCorpus() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-recall-on-prompt-'));
  const ts = new Date(Date.now() - 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  const event = (fields) => JSON.stringify({ timestamp: ts, type: 'tool_bash', project: 'widget-web', salience: 0.5, ...fields });
  const rows = [
    event({ event_id: 'evt-wheelfix01', salience: 0.9, session_id: 'sess-older-0001',
      transcript_path: '/Users/x/.codex/sessions/2026/10/14/rollout-a.jsonl',
      summary: `[fix] Commit ${'a1b2c3d'}${'e'.repeat(33)}: fix(wheel): debounce wheel scroll jank in the gallery` }),
    event({ event_id: 'evt-wheelnote2', salience: 0.9, session_id: 'sess-older-0002',
      transcript_path: '/Users/x/.claude/projects/p/sess-older-0002.jsonl',
      summary: 'Investigated: wheel scroll jank came from passive listener missing on the gallery' }),
    event({ event_id: 'evt-wheelmine3', salience: 0.9, session_id: SID,
      summary: 'Ran: profile wheel scroll jank trace in the gallery' }),
    event({ event_id: 'evt-weakfader', salience: 0.05, session_id: 'sess-older-0003',
      summary: 'Ran: zzweakqq fader tuning probe' }),
    ...Array.from({ length: 12 }, (_, i) => event({ event_id: `evt-filler${i}`, summary: `Ran: unrelated filler task ${i}` })),
  ];
  fs.writeFileSync(path.join(dir, 'changelog.jsonl'), `${rows.join('\n')}\n`);
  for (const name of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dir, name), '');
  }
  fs.mkdirSync(path.join(dir, 'widget-web'));
  fs.mkdirSync(path.join(dir, 'dev'));
  return {
    dir,
    trial: path.join(dir, 'recall-on-prompt-trial.jsonl'),
    served: path.join(dir, 'served-log.jsonl'),
    calls: path.join(dir, 'search-calls.jsonl'),
    marks: path.join(dir, 'cartographer-recall-on-prompt'),
  };
}

function hookEnv(corpus, overrides = {}) {
  const base = { ...process.env };
  for (const key of IDENTITY_VARS) delete base[key];
  return {
    ...base,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_RECALL_ON_PROMPT: '1',
    CARTOGRAPHER_DEV_DIR: corpus.dir,
    CARTOGRAPHER_SERVED_LOG: corpus.served,
    CARTOGRAPHER_SEARCH_CALL_LOG: corpus.calls,
    CARTOGRAPHER_ACCESS_LEDGER: path.join(corpus.dir, 'access-ledger.jsonl'),
    CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(corpus.dir, 'none'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(corpus.dir, 'none'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(corpus.dir, 'none'),
    CARTOGRAPHER_CONFIG: path.join(corpus.dir, 'no-config.json'),
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO: '0',
    TMPDIR_BASE: corpus.dir,
    ...overrides,
  };
}

function runHook(corpus, prompt, { sid = SID, cwd = 'widget-web', env = {} } = {}) {
  const payload = {
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: `/Users/x/.claude/projects/p/${sid}.jsonl`,
    cwd: path.join(corpus.dir, cwd),
    prompt,
  };
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify(payload), encoding: 'utf8', env: hookEnv(corpus, env), timeout: 30000,
  });
  assert.equal(res.status, 0, `the hook must never fail a prompt: ${res.stderr}`);
  return { stdout: res.stdout, trial: readJsonl(corpus.trial).at(-1) };
}

// The first prompt of a session is SessionStart's; mark it seen.
function primed(corpus, sid = SID) {
  fs.mkdirSync(corpus.marks, { recursive: true });
  fs.writeFileSync(path.join(corpus.marks, sid), '');
}

function withCorpus(fn) {
  return () => {
    const corpus = makeCorpus();
    try { fn(corpus); } finally { fs.rmSync(corpus.dir, { recursive: true, force: true }); }
  };
}

test('dormant without the gate: no output, no trial row, no marker', withCorpus((corpus) => {
  const res = spawnSync('bash', [HOOK], {
    input: JSON.stringify({ session_id: SID, cwd: corpus.dir, prompt: CUE }),
    encoding: 'utf8',
    env: hookEnv(corpus, { CARTOGRAPHER_RECALL_ON_PROMPT: '0' }),
  });
  assert.equal(res.status, 0);
  assert.equal(res.stdout, '');
  assert.equal(fs.existsSync(corpus.trial), false);
  assert.equal(fs.existsSync(corpus.marks), false);
}));

test('the first prompt of a session is skipped even when it carries a cue', withCorpus((corpus) => {
  const first = runHook(corpus, CUE);
  assert.equal(first.stdout, '');
  assert.equal(first.trial.reason, 'first_prompt');
  assert.equal(first.trial.fired, false);
  assert.equal(readJsonl(corpus.served).length, 0, 'no search ran');

  // The same cue on the next prompt fires: the skip is about turn one, not the prompt.
  const second = runHook(corpus, CUE);
  assert.equal(second.trial.reason, 'injected');
}));

test('a cue injects the confident hits, and the served rows are exactly what was injected', withCorpus((corpus) => {
  primed(corpus);
  const { stdout, trial } = runHook(corpus, CUE);
  const output = JSON.parse(stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  const ctx = output.hookSpecificOutput.additionalContext;

  assert.equal(trial.fired, true);
  assert.equal(trial.reason, 'injected');
  assert.equal(trial.cue, 'temporal');
  assert.equal(trial.scope, 'widget-web');
  assert.equal(trial.session_id, SID);
  assert.equal(trial.session_source, 'payload');
  assert.match(trial.call_id, /^call-\d{8}T\d{6}-\d+$/);
  assert.deepEqual([...trial.event_ids].sort(), ['evt-wheelfix01', 'evt-wheelmine3', 'evt-wheelnote2']);
  assert.ok(!trial.event_ids.includes('evt-weakfader'));
  assert.ok(Number.isFinite(trial.latency_ms));

  for (const id of trial.event_ids) assert.ok(ctx.includes(`[${id}]`), `context names ${id}`);
  assert.ok(ctx.includes(`--call-id ${trial.call_id}`), 'context carries the call id for --get/--touch');
  assert.ok([...ctx].length <= 600, `context is ${[...ctx].length} characters`);
  assert.equal(ctx.split('\n').length, 5, 'header, three hits, hint');
  assert.match(ctx, /\[evt-wheelmine3\] \(this session\)/);
  assert.match(ctx, /codex: .*\[evt-wheelfix01\]/, 'provider comes from the transcript path');
  assert.match(ctx, /Commit a1b2c3d: fix\(wheel\)/, 'a 40-character sha is cut to 7');
  // The portable summary is BM25 search text ending in the event id; the line
  // must show the summary once, not " summary evt-… [evt-…]".
  assert.doesNotMatch(ctx, /gallery evt-/);
  assert.doesNotMatch(ctx, /: {2}/);

  const served = readJsonl(corpus.served).filter((row) => row.call_id === trial.call_id);
  assert.deepEqual(served.map((row) => row.event_id), trial.event_ids);
  for (const row of served) {
    assert.equal(row.purpose, 'prompt-cue');
    assert.equal(row.session_id, SID, 'the search names the session the hook names');
    assert.equal(row.provider, 'claude');
  }
  const call = readJsonl(corpus.calls).find((row) => row.call_id === trial.call_id);
  assert.equal(call.purpose, 'prompt-cue');
  assert.equal(call.min_score, 0.01);
}));

test('a prompt without a cue stays silent and runs no search', withCorpus((corpus) => {
  primed(corpus);
  const { stdout, trial } = runHook(corpus, 'rename the wheel handler to onWheel');
  assert.equal(stdout, '');
  assert.equal(trial.reason, 'no_cue');
  assert.equal(trial.call_id, null);
  assert.equal(trial.prompt, null, 'non-cue prompt text is not kept');
  assert.equal(readJsonl(corpus.served).length, 0);
  assert.equal(readJsonl(corpus.calls).length, 0);
}));

test('a cue with no topic left abstains before searching', withCorpus((corpus) => {
  primed(corpus);
  const { stdout, trial } = runHook(corpus, "didn't we fix this already?");
  assert.equal(stdout, '');
  assert.equal(trial.reason, 'no_topic');
  assert.equal(trial.cue, 'didnt-we');
  assert.equal(readJsonl(corpus.calls).length, 0);
}));

test('a cue whose best hit is under the floor abstains, and serves nothing', withCorpus((corpus) => {
  primed(corpus);
  const { stdout, trial } = runHook(corpus, 'did we try zzweakqq faders?');
  assert.equal(stdout, '');
  assert.equal(trial.reason, 'no_confident_hit');
  assert.equal(readJsonl(corpus.served).filter((row) => row.call_id === trial.call_id).length, 0);
  // The guard on the guard: a hit existed and the floor removed it, which is
  // different from a query that matched nothing.
  const call = readJsonl(corpus.calls).find((row) => row.call_id === trial.call_id);
  assert.ok(call.below_min_score >= 1, JSON.stringify(call));
  assert.ok(call.top_score > 0 && call.top_score < 0.01);
}));

test('a search that outruns the budget is killed and the hook abstains', withCorpus((corpus) => {
  primed(corpus);
  const { stdout, trial } = runHook(corpus, CUE, { env: { CARTOGRAPHER_RECALL_ON_PROMPT_BUDGET_MS: '1' } });
  assert.equal(stdout, '');
  assert.equal(trial.reason, 'timeout');
  assert.equal(trial.budget_ms, 1);
  assert.equal(readJsonl(corpus.served).length, 0, 'a killed search serves nothing');
}));

test('"unknown" in the session chain does not shadow the payload session', withCorpus((corpus) => {
  primed(corpus);
  const { trial } = runHook(corpus, CUE, { env: { CARTOGRAPHER_SESSION_ID: 'unknown' } });
  assert.equal(trial.reason, 'injected');
  assert.equal(trial.session_id, SID);
  const served = readJsonl(corpus.served).filter((row) => row.call_id === trial.call_id);
  assert.ok(served.length > 0);
  for (const row of served) assert.equal(row.session_id, SID);
}));

test('a resolved chain session wins over the payload, matching what the search reads', withCorpus((corpus) => {
  primed(corpus, 'sess-from-chain');
  const { trial } = runHook(corpus, CUE, { env: { CLAUDE_CODE_SESSION_ID: 'sess-from-chain' } });
  assert.equal(trial.session_id, 'sess-from-chain');
  assert.equal(trial.session_source, 'CLAUDE_CODE_SESSION_ID');
  const served = readJsonl(corpus.served).filter((row) => row.call_id === trial.call_id);
  for (const row of served) assert.equal(row.session_id, 'sess-from-chain');
}));

test('slash commands, tooling text and compaction continuations are skipped by shape', withCorpus((corpus) => {
  primed(corpus);
  assert.equal(runHook(corpus, '/remember did we fix the wheel jank').trial.reason, 'slash_command');
  assert.equal(runHook(corpus, '<task-notification>did we fix the wheel jank</task-notification>').trial.reason, 'tooling');
  assert.equal(runHook(corpus, 'This session is being continued from a previous conversation. did we fix the wheel').trial.reason, 'compaction');
  assert.equal(runHook(corpus, '   ').trial.reason, 'empty');
  assert.equal(readJsonl(corpus.calls).length, 0);
}));

test('a session in the workspace root searches every project and names each hit\'s project', withCorpus((corpus) => {
  primed(corpus);
  const { stdout, trial } = runHook(corpus, CUE, { cwd: 'dev' });
  assert.equal(trial.project, 'dev');
  assert.equal(trial.scope, null, '--project dev would be a substring filter over unrelated repos');
  const call = readJsonl(corpus.calls).find((row) => row.call_id === trial.call_id);
  assert.equal(call.project, '');
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /all projects/);
  assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /widget-web\/codex: /);
}));
