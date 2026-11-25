import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV, NO_INDEXER_ROOT } from './helpers/offline-index.js';
import { withoutTrialGates } from './helpers/trial-gates.js';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PLUGIN_ROOT = path.join(ROOT, 'plugins', 'session-cartographer');
const HOOKS_DIR = path.join(PLUGIN_ROOT, 'hooks');
const AGY_HOOKS_JSON = path.join(PLUGIN_ROOT, 'hooks.json');
const COMMON_SH = path.join(HOOKS_DIR, 'common.sh');
const BRIDGE_PATH = path.join(HOOKS_DIR, 'antigravity-hook-bridge.cjs');
const { HOOKS } = require(path.join(HOOKS_DIR, 'run-hook.cjs'));
const {
  translateInput,
  translateOutput,
  shouldSkipStop,
  main: runBridgeMain,
} = require(BRIDGE_PATH);

const SESSION_ENV_VARS = [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
  'ANTIGRAVITY_CONVERSATION_ID',
  'ANTIGRAVITY_AGENT',
  'CARTOGRAPHER_PROVIDER',
  'CARTOGRAPHER_HOOK_ACTIVE',
  'CARTOGRAPHER_LOG_TOOL_USE',
  'CARTOGRAPHER_FOCUS_ON_START',
  'CARTOGRAPHER_RECALL_ON_PROMPT',
  'CARTOGRAPHER_FILE_HISTORY_ON_EDIT',
  'CARTOGRAPHER_COLLISION_CHECK',
];

function makeScratch(t, prefix = 'carto-agy-bridge-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function buildIsolatedEnv(devDir, stateDir, extra = {}) {
  const env = {
    ...withoutTrialGates(process.env),
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_ROOT: NO_INDEXER_ROOT,
    CARTOGRAPHER_DEV_DIR: devDir,
    CARTOGRAPHER_HOOK_STATE_DIR: stateDir,
    CARTOGRAPHER_SERVED_LOG: path.join(devDir, 'served-log.jsonl'),
    CARTOGRAPHER_SEARCH_CALL_LOG: path.join(devDir, 'search-calls.jsonl'),
    CARTOGRAPHER_ACCESS_LEDGER: path.join(devDir, 'access-ledger.jsonl'),
    CARTOGRAPHER_TRANSCRIPTS_DIR: path.join(devDir, 'no-claude-transcripts'),
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: path.join(devDir, 'no-codex-transcripts'),
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: path.join(devDir, 'no-codex-archived'),
    CARTOGRAPHER_CONFIG: path.join(devDir, 'no-config.json'),
    TMPDIR_BASE: stateDir,
    CARTOGRAPHER_SEMANTIC: '0',
    CARTOGRAPHER_TURBO: '0',
    CARTOGRAPHER_AUTO_CATCHUP: '0',
  };
  for (const key of SESSION_ENV_VARS) delete env[key];
  return { ...env, ...extra };
}

function runBridgeCli(hookScript, timeoutMs, payload, env, cwd = PLUGIN_ROOT) {
  const input = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const res = spawnSync(
    process.execPath,
    ['./hooks/antigravity-hook-bridge.cjs', hookScript, String(timeoutMs)],
    {
      cwd,
      env,
      input,
      encoding: 'utf8',
      timeout: 15000,
    },
  );
  assert.equal(res.error, undefined, `spawn error: ${res.error}`);
  assert.equal(res.status, 0, `bridge exited ${res.status}; stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout.trim());
  return { parsed, stdout: res.stdout, stderr: res.stderr };
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => JSON.parse(l));
}

function detectProviderFrom(transcript, turnId = '', model = '', extraEnv = {}) {
  const env = { ...process.env };
  delete env.CARTOGRAPHER_PROVIDER;
  Object.assign(env, extraEnv);
  return execFileSync(
    'bash',
    ['-c', '. "$1"; detect_provider_from "$2" "$3" "$4"', '--', COMMON_SH, transcript, turnId, model],
    { encoding: 'utf8', env },
  ).trim();
}

describe('Antigravity plugin-root hooks.json schema', () => {
  test('uses Antigravity top-level hook-name format, flat vs grouped events, valid matchers, and existing scripts', () => {
    const manifest = JSON.parse(fs.readFileSync(AGY_HOOKS_JSON, 'utf8'));
    assert.equal(manifest.hooks, undefined, 'Antigravity plugin-root hooks.json must not wrap in a top-level "hooks" key');
    assert.deepEqual(Object.keys(manifest), ['session-cartographer']);

    const spec = manifest['session-cartographer'];
    const flatEvents = ['SessionStart', 'PreInvocation', 'Stop'];
    const groupedEvents = ['PreToolUse', 'PostToolUse'];
    assert.deepEqual(Object.keys(spec).sort(), [...flatEvents, ...groupedEvents].sort());

    const commandRe = /^node \.\/hooks\/antigravity-hook-bridge\.cjs ([a-z-]+\.sh) (\d+)$/;

    for (const ev of flatEvents) {
      assert.ok(Array.isArray(spec[ev]) && spec[ev].length > 0, `${ev} must be a non-empty flat array`);
      for (const handler of spec[ev]) {
        assert.equal(handler.matcher, undefined, `${ev} handler must be flat (no matcher)`);
        assert.equal(handler.hooks, undefined, `${ev} handler must be flat (no nested hooks array)`);
        assert.equal(handler.type, 'command');
        const m = handler.command.match(commandRe);
        assert.ok(m, `${ev} command format invalid: ${handler.command}`);
        const [, script, budgetStr] = m;
        assert.ok(HOOKS.has(script), `${script} must be allowlisted in run-hook.cjs HOOKS`);
        assert.ok(fs.existsSync(path.join(HOOKS_DIR, script)), `${script} must exist`);
        assert.ok(handler.timeout >= Number(budgetStr) / 1000 + 5, `${ev}/${script} timeout must give bridge cleanup headroom`);
      }
    }

    for (const ev of groupedEvents) {
      assert.ok(Array.isArray(spec[ev]) && spec[ev].length > 0, `${ev} must be a non-empty grouped array`);
      for (const group of spec[ev]) {
        assert.equal(typeof group.matcher, 'string');
        assert.ok(group.matcher.length > 0);
        const re = new RegExp(`^(?:${group.matcher})$`);
        assert.ok(re instanceof RegExp);
        assert.ok(Array.isArray(group.hooks) && group.hooks.length > 0, `${ev} group must contain hooks`);
        for (const handler of group.hooks) {
          assert.equal(handler.type, 'command');
          const m = handler.command.match(commandRe);
          assert.ok(m, `${ev} command format invalid: ${handler.command}`);
          const [, script, budgetStr] = m;
          assert.ok(HOOKS.has(script), `${script} must be allowlisted in run-hook.cjs HOOKS`);
          assert.ok(fs.existsSync(path.join(HOOKS_DIR, script)), `${script} must exist`);
          assert.ok(handler.timeout >= Number(budgetStr) / 1000 + 5, `${ev}/${script} timeout must give bridge cleanup headroom`);
        }
      }
    }

    const preMatcher = new RegExp(`^(?:${spec.PreToolUse[0].matcher})$`);
    for (const tool of ['edit_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file']) {
      assert.ok(preMatcher.test(tool), `PreToolUse matcher must match ${tool}`);
    }
    assert.equal(preMatcher.test('run_command'), false);

    const postResearchMatcher = new RegExp(`^(?:${spec.PostToolUse[0].matcher})$`);
    for (const tool of ['search_web', 'read_url_content', 'fetch_url', 'mcp__docs__search_api', 'mcp__web__fetch_page', 'mcp__browser__open_url']) {
      assert.ok(postResearchMatcher.test(tool), `PostToolUse research matcher must match ${tool}`);
    }
    const postToolMatcher = new RegExp(`^(?:${spec.PostToolUse[1].matcher})$`);
    for (const tool of ['edit_file', 'write_file', 'replace_file_content', 'multi_replace_file_content', 'write_to_file', 'run_command']) {
      assert.ok(postToolMatcher.test(tool), `PostToolUse tool-use matcher must match ${tool}`);
    }
  });
});

describe('common.sh detect_provider_from Antigravity path detection', () => {
  test('detects macOS, Linux, and Windows Antigravity transcript paths even when model is present', () => {
    const cases = [
      '/Users/andyed/.gemini/antigravity/brain/conv-1/.system_generated/logs/transcript.jsonl',
      '/home/dev/.gemini/antigravity-ide/brain/conv-2/transcript.jsonl',
      '/home/dev/.gemini/antigravity-cli/brain/conv-3/transcript.jsonl',
      '/workspace/.gemini/antigravity/transcript.jsonl',
      '/workspace/.gemini/antigravity-cli/transcript_full.jsonl',
      'C:\\Users\\dev\\.gemini\\antigravity\\brain\\conv-4\\.system_generated\\logs\\transcript.jsonl',
      'C:\\Users\\dev\\.gemini\\antigravity-ide\\brain\\conv-5\\transcript.jsonl',
      'C:\\Users\\dev\\.gemini\\antigravity-cli\\brain\\conv-6\\transcript.jsonl',
      'C:\\work\\repo\\.gemini\\antigravity\\transcript.jsonl',
    ];
    for (const transcript of cases) {
      assert.equal(
        detectProviderFrom(transcript, '', 'gemini-2.5-pro'),
        'antigravity',
        `expected antigravity for ${transcript}`,
      );
    }
  });

  test('preserves Claude, Codex, and unknown detection', () => {
    assert.equal(detectProviderFrom('/Users/dev/.claude/projects/foo/abc.jsonl', '', 'claude-opus'), 'claude');
    assert.equal(detectProviderFrom('C:\\Users\\dev\\.claude\\projects\\foo\\abc.jsonl', '', ''), 'claude');
    assert.equal(detectProviderFrom('/Users/dev/.codex/sessions/2026/rollout.jsonl', '', ''), 'codex');
    assert.equal(detectProviderFrom('', 'turn-1', ''), 'codex');
    assert.equal(detectProviderFrom('', '', ''), 'unknown');
  });
});

describe('translateInput and translateOutput unit contracts', () => {
  test('translates Antigravity tools, events, and common fields', () => {
    const start = translateInput({
      hookEventName: 'SessionStart',
      conversationId: 'conv-1',
      workspacePaths: ['/ws/demo'],
      transcriptPath: '/Users/u/.gemini/antigravity/brain/conv-1/transcript.jsonl',
      modelName: 'auto',
    });
    assert.equal(start.hook_event_name, 'SessionStart');
    assert.equal(start.source, 'startup');
    assert.equal(start.session_id, 'conv-1');
    assert.equal(start.cwd, '/ws/demo');
    assert.equal(start.model, 'auto');

    const edit = translateInput({
      hookEventName: 'PostToolUse',
      conversationId: 'conv-1',
      cwd: '/ws/demo',
      toolCall: { id: 'tc-1', name: 'replace_file_content', args: { TargetFile: '/ws/demo/a.js' } },
    });
    assert.equal(edit.hook_event_name, 'PostToolUse');
    assert.equal(edit.tool_use_id, 'tc-1');
    assert.equal(edit.tool_name, 'Edit');
    assert.deepEqual(edit.tool_input, { file_path: '/ws/demo/a.js' });

    const write = translateInput({
      hookEventName: 'PreToolUse',
      toolCall: { id: 'tc-2', name: 'write_to_file', args: { Path: '/ws/demo/b.js' } },
    });
    assert.equal(write.tool_name, 'Write');
    assert.deepEqual(write.tool_input, { file_path: '/ws/demo/b.js' });

    const bashFail = translateInput({
      hookEventName: 'PostToolUse',
      error: 'exit status 1',
      toolCall: { id: 'tc-3', name: 'run_command', args: { CommandLine: 'npm test' } },
    });
    assert.equal(bashFail.hook_event_name, 'PostToolUseFailure');
    assert.equal(bashFail.tool_name, 'Bash');
    assert.deepEqual(bashFail.tool_input, { command: 'npm test' });

    const editWithErr = translateInput({
      hookEventName: 'PostToolUse',
      error: 'target not found',
      toolCall: { id: 'tc-4', name: 'edit_file', args: { Path: '/ws/demo/a.js' } },
    });
    assert.equal(editWithErr.hook_event_name, 'PostToolUse');

    const webFetch = translateInput({
      hookEventName: 'PostToolUse',
      toolCall: { id: 'tc-5', name: 'read_url_content', args: { Url: 'https://arxiv.org/abs/2501.00001' } },
    });
    assert.equal(webFetch.tool_name, 'WebFetch');
    assert.deepEqual(webFetch.tool_input, { url: 'https://arxiv.org/abs/2501.00001' });

    const mcp = translateInput({
      hookEventName: 'PostToolUse',
      toolCall: { id: 'tc-6', name: 'mcp__docs__search', args: { query: 'hooks' } },
    });
    assert.equal(mcp.tool_name, 'mcp__docs__search');
    assert.deepEqual(mcp.tool_input, { query: 'hooks' });

    const preInv = translateInput({
      hookEventName: 'PreInvocation',
      lastUserInput: 'Did we already solve this?',
    });
    assert.equal(preInv.hook_event_name, 'UserPromptSubmit');
    assert.equal(preInv.prompt, 'Did we already solve this?');
  });

  test('translates hook stdout to valid Antigravity response shapes for every event', () => {
    const withCtx = JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'Hello context' },
    });
    const withSys = JSON.stringify({ systemMessage: 'System notice' });

    assert.deepEqual(translateOutput('PreToolUse', ''), { decision: 'allow' });
    assert.deepEqual(translateOutput('PreToolUse', withCtx), { decision: 'allow', reason: 'Hello context' });
    assert.deepEqual(translateOutput('PreToolUse', 'not-json'), { decision: 'allow' });

    assert.deepEqual(translateOutput('PostToolUse', withCtx), {});
    assert.deepEqual(translateOutput('Stop', withCtx), {});

    assert.deepEqual(translateOutput('SessionStart', withCtx), {
      injectSteps: [{ systemMessage: { systemMessage: 'Hello context' } }],
    });
    assert.deepEqual(translateOutput('SessionStart', withSys), {
      injectSteps: [{ systemMessage: { systemMessage: 'System notice' } }],
    });
    assert.deepEqual(translateOutput('SessionStart', ''), {});

    assert.deepEqual(translateOutput('PreInvocation', withCtx), {
      injectSteps: [{ systemMessage: { systemMessage: 'Hello context' } }],
    });
    assert.deepEqual(translateOutput('PreInvocation', 'garbage'), {});

    assert.equal(shouldSkipStop({ continuationActive: true, terminationReason: 'NO_TOOL_CALL' }), true);
    assert.equal(shouldSkipStop({ continuationActive: false, terminationReason: 'USER_CANCELED' }), true);
    assert.equal(shouldSkipStop({ continuationActive: false, terminationReason: 'NO_TOOL_CALL' }), false);
  });
});

describe('antigravity-hook-bridge end-to-end execution', () => {
  test('PostToolUse edit_file logs tool_file_edit with provider=antigravity and respects opt-in gate', t => {
    const tmp = makeScratch(t);
    const dev = path.join(tmp, 'dev');
    const state = path.join(tmp, 'state');
    const repo = path.join(tmp, 'my-agy-repo');
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });

    const payload = {
      hookEventName: 'PostToolUse',
      conversationId: 'agy-conv-edit-1',
      cwd: repo,
      transcriptPath: path.join(tmp, '.gemini', 'antigravity', 'brain', 'agy-conv-edit-1', 'transcript.jsonl'),
      modelName: 'gemini-2.5-pro',
      toolCall: {
        id: 'call_edit_1',
        name: 'edit_file',
        args: { Path: path.join(repo, 'src', 'app.js') },
      },
    };

    // Gate off: silent no-op, valid JSON
    const offEnv = buildIsolatedEnv(dev, state, { CARTOGRAPHER_LOG_TOOL_USE: 'false' });
    const offRes = runBridgeCli('log-tool-use.sh', 10000, payload, offEnv);
    assert.deepEqual(offRes.parsed, {});
    assert.equal(readJsonl(path.join(dev, 'tool-use-log.jsonl')).length, 0);

    // Gate on: writes tool-use-log.jsonl + changelog.jsonl
    const onEnv = buildIsolatedEnv(dev, state, { CARTOGRAPHER_LOG_TOOL_USE: 'true' });
    const onRes = runBridgeCli('log-tool-use.sh', 10000, payload, onEnv);
    assert.deepEqual(onRes.parsed, {});

    const toolRows = readJsonl(path.join(dev, 'tool-use-log.jsonl'));
    const changeRows = readJsonl(path.join(dev, 'changelog.jsonl'));
    assert.equal(toolRows.length, 1);
    assert.equal(changeRows.length, 1);
    assert.equal(toolRows[0].type, 'tool_file_edit');
    assert.equal(toolRows[0].tool, 'Edit');
    assert.equal(toolRows[0].provider, 'antigravity');
    assert.equal(toolRows[0].session, 'agy-conv-edit-1');
    assert.equal(toolRows[0].project, 'my-agy-repo');
    assert.match(toolRows[0].summary, /Modified: .*src\/app\.js/);
    assert.equal(changeRows[0].event_id, toolRows[0].event_id);
    assert.equal(changeRows[0].provider, 'antigravity');
    assert.equal(changeRows[0].session_id, 'agy-conv-edit-1');
  });

  test('PostToolUse run_command handles normal bash, skips failed bash, and captures git commit', t => {
    const tmp = makeScratch(t);
    const dev = path.join(tmp, 'dev');
    const state = path.join(tmp, 'state');
    const repo = path.join(tmp, 'agy-git-repo');
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repo, stdio: 'ignore' });
    fs.writeFileSync(path.join(repo, 'index.js'), 'export const x = 1;\n');
    execFileSync('git', ['add', 'index.js'], { cwd: repo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat: initial antigravity commit'], { cwd: repo, stdio: 'ignore' });

    const env = buildIsolatedEnv(dev, state, { CARTOGRAPHER_LOG_TOOL_USE: 'true' });
    const base = {
      hookEventName: 'PostToolUse',
      conversationId: 'agy-conv-bash-1',
      cwd: repo,
      transcriptPath: path.join(tmp, '.gemini', 'antigravity', 'brain', 'agy-conv-bash-1', 'transcript.jsonl'),
      modelName: 'auto',
    };

    // 1. Normal bash
    const r1 = runBridgeCli('log-tool-use.sh', 10000, {
      ...base,
      toolCall: { id: 'tc-b1', name: 'run_command', args: { CommandLine: 'npm test' } },
    }, env);
    assert.deepEqual(r1.parsed, {});

    // 2. Failed bash with error -> mapped to PostToolUseFailure -> must NOT write a tool_bash row
    const r2 = runBridgeCli('log-tool-use.sh', 10000, {
      ...base,
      error: 'exit status 1',
      toolCall: { id: 'tc-b2', name: 'run_command', args: { CommandLine: 'npm run lint-broken' } },
    }, env);
    assert.deepEqual(r2.parsed, {});

    // 3. Git commit -> HEAD freshness detects the commit
    const r3 = runBridgeCli('log-tool-use.sh', 10000, {
      ...base,
      toolCall: { id: 'tc-b3', name: 'run_command', args: { CommandLine: 'git commit -m "feat: initial antigravity commit"' } },
    }, env);
    assert.deepEqual(r3.parsed, {});

    const toolRows = readJsonl(path.join(dev, 'tool-use-log.jsonl'));
    assert.equal(toolRows.length, 2, `expected 2 rows (normal bash + git commit, skipping failed bash); got ${JSON.stringify(toolRows)}`);
    assert.equal(toolRows[0].type, 'tool_bash');
    assert.equal(toolRows[0].provider, 'antigravity');
    assert.equal(toolRows[0].summary.trim(), 'Ran: npm test');
    assert.equal(toolRows[1].type, 'git_commit');
    assert.equal(toolRows[1].provider, 'antigravity');
    assert.equal(toolRows[1].commit_type, 'feature');
    assert.match(toolRows[1].summary, /feat: initial antigravity commit/);
    assert.equal(toolRows.some(r => r.summary.includes('lint-broken')), false);
  });

  test('PostToolUse search_web writes research-log.jsonl and changelog.jsonl with provider=antigravity', t => {
    const tmp = makeScratch(t);
    const dev = path.join(tmp, 'dev');
    const state = path.join(tmp, 'state');
    const repo = path.join(tmp, 'research-proj');
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });

    const env = buildIsolatedEnv(dev, state);
    const res = runBridgeCli('log-research.sh', 10000, {
      hookEventName: 'PostToolUse',
      conversationId: 'agy-conv-search-1',
      cwd: repo,
      transcriptPath: path.join(tmp, '.gemini', 'antigravity', 'brain', 'agy-conv-search-1', 'transcript.jsonl'),
      toolCall: {
        id: 'tc-s1',
        name: 'search_web',
        args: { query: 'antigravity lifecycle hooks contract' },
      },
    }, env);
    assert.deepEqual(res.parsed, {});

    const researchRows = readJsonl(path.join(dev, 'research-log.jsonl'));
    const changeRows = readJsonl(path.join(dev, 'changelog.jsonl'));
    assert.equal(researchRows.length, 1);
    assert.equal(changeRows.length, 1);
    assert.equal(researchRows[0].type, 'search');
    assert.equal(researchRows[0].provider, 'antigravity');
    assert.equal(researchRows[0].query, 'antigravity lifecycle hooks contract');
    assert.equal(researchRows[0].session, 'agy-conv-search-1');
    assert.equal(changeRows[0].type, 'research_search');
    assert.equal(changeRows[0].provider, 'antigravity');
  });

  test('PreToolUse edit_file always returns decision=allow and includes collision reason when peer touched file', t => {
    const tmp = makeScratch(t);
    const dev = path.join(tmp, 'dev');
    const state = path.join(tmp, 'state');
    const repo = path.join(tmp, 'collision-proj');
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    const targetFile = path.join(repo, 'shared.js');
    fs.writeFileSync(targetFile, 'export const v = 1;\n');

    const env = buildIsolatedEnv(dev, state, { CARTOGRAPHER_COLLISION_CHECK: '1' });
    const payload = {
      hookEventName: 'PreToolUse',
      conversationId: 'agy-conv-self-1',
      cwd: repo,
      toolCall: { id: 'tc-e1', name: 'edit_file', args: { Path: targetFile } },
    };

    // Clean state: allow with no reason
    const cleanRes = runBridgeCli('check-edit-collision.sh', 3000, payload, env);
    assert.deepEqual(cleanRes.parsed, { decision: 'allow' });

    // Peer edited the same file recently -> still allow, now with collision reason
    const peerEvent = {
      event_id: 'evt-peer12345678',
      timestamp: new Date(Date.now() - 60_000).toISOString(),
      type: 'tool_file_edit',
      provider: 'claude',
      session_id: 'claude-peer-session-99',
      project: 'collision-proj',
      cwd: repo,
      summary: `Modified: ${targetFile}`,
    };
    fs.writeFileSync(path.join(dev, 'changelog.jsonl'), JSON.stringify(peerEvent) + '\n');

    const collideRes = runBridgeCli('check-edit-collision.sh', 3000, payload, env);
    assert.equal(collideRes.parsed.decision, 'allow');
    assert.match(collideRes.parsed.reason || '', /\[carto collision\]/);
  });

  test('PreInvocation deduplicates mid-turn invocations and injects recall hits via injectSteps', t => {
    const tmp = makeScratch(t);
    const dev = path.join(tmp, 'dev');
    const state = path.join(tmp, 'state');
    const repo = path.join(tmp, 'zephyr-bridge-proj');
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });

    // Seed a distinctive recent changelog event plus filler rows so BM25 IDF is positive
    const ts = new Date(Date.now() - 3600_000).toISOString().replace(/\.\d+Z$/, 'Z');
    const seededRows = [
      {
        event_id: 'evt-zephyr998877',
        timestamp: ts,
        type: 'git_commit',
        provider: 'claude',
        session_id: 'prev-claude-sess-1',
        project: 'zephyr-bridge-proj',
        cwd: repo,
        summary: '[fix] Commit abc1234: Fixed zephyr quartz calibration drift in telemetry worker',
        salience: 0.9,
      },
      ...Array.from({ length: 12 }, (_, i) => ({
        event_id: `evt-filler${String(i).padStart(4, '0')}`,
        timestamp: ts,
        type: 'tool_bash',
        provider: 'claude',
        session_id: 'prev-claude-sess-1',
        project: 'zephyr-bridge-proj',
        cwd: repo,
        summary: `Ran: unrelated routine build step ${i}`,
        salience: 0.5,
      })),
    ];
    fs.writeFileSync(path.join(dev, 'changelog.jsonl'), seededRows.map(r => JSON.stringify(r)).join('\n') + '\n');
    for (const emptyLog of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) {
      fs.writeFileSync(path.join(dev, emptyLog), '');
    }

    const env = buildIsolatedEnv(dev, state, {
      CARTOGRAPHER_RECALL_ON_PROMPT: '1',
      CARTOGRAPHER_RECALL_ON_PROMPT_MIN_SCORE: '0.001',
      CARTOGRAPHER_RECALL_ON_PROMPT_BUDGET_MS: '4000',
    });

    const base = {
      hookEventName: 'PreInvocation',
      conversationId: 'agy-conv-preinv-1',
      cwd: repo,
      transcriptPath: path.join(tmp, '.gemini', 'antigravity', 'brain', 'agy-conv-preinv-1', 'transcript.jsonl'),
      modelName: 'gemini-2.5-pro',
    };
    const trialFile = path.join(dev, 'recall-on-prompt-trial.jsonl');

    // 1. invocationNum=1 -> runs surface-recall-on-prompt.sh (logs first_prompt), outputs {}
    const r1 = runBridgeCli('surface-recall-on-prompt.sh', 5000, {
      ...base,
      invocationNum: 1,
      lastUserInput: 'Let us inspect the repo layout first',
    }, env);
    assert.deepEqual(r1.parsed, {});
    assert.equal(readJsonl(trialFile).length, 1);
    assert.equal(readJsonl(trialFile)[0].reason, 'first_prompt');
    assert.equal(readJsonl(trialFile)[0].provider, 'antigravity');

    // 2. invocationNum=2 with SAME lastUserInput -> skipped immediately by bridge
    const r2 = runBridgeCli('surface-recall-on-prompt.sh', 5000, {
      ...base,
      invocationNum: 2,
      lastUserInput: 'Let us inspect the repo layout first',
    }, env);
    assert.deepEqual(r2.parsed, {});
    assert.equal(readJsonl(trialFile).length, 1, 'mid-turn duplicate PreInvocation must not re-run hook');

    // 3. invocationNum=3 with CHANGED lastUserInput containing a recall cue -> runs and injects via injectSteps
    const cuePrompt = "Didn't we already fix the zephyr quartz calibration drift in telemetry worker?";
    const r3 = runBridgeCli('surface-recall-on-prompt.sh', 5000, {
      ...base,
      invocationNum: 3,
      lastUserInput: cuePrompt,
    }, env);
    assert.ok(Array.isArray(r3.parsed.injectSteps) && r3.parsed.injectSteps.length === 1,
      `expected injectSteps on recall hit; got ${JSON.stringify(r3.parsed)}`);
    const injectedText = r3.parsed.injectSteps[0]?.systemMessage?.systemMessage || '';
    assert.match(injectedText, /\[carto recall/);
    assert.match(injectedText, /evt-zephyr998877/);

    const trialsAfter3 = readJsonl(trialFile);
    assert.equal(trialsAfter3.length, 2);
    assert.equal(trialsAfter3[1].fired, true);
    assert.equal(trialsAfter3[1].provider, 'antigravity');

    // 4. invocationNum=4 with SAME cuePrompt -> skipped by bridge
    const r4 = runBridgeCli('surface-recall-on-prompt.sh', 5000, {
      ...base,
      invocationNum: 4,
      lastUserInput: cuePrompt,
    }, env);
    assert.deepEqual(r4.parsed, {});
    assert.equal(readJsonl(trialFile).length, 2, 'subsequent mid-turn PreInvocation with same prompt must be skipped');
  });

  test('Stop writes turn_stop milestone for antigravity, skips USER_CANCELED and continuationActive, outputs {}', t => {
    const tmp = makeScratch(t);
    const dev = path.join(tmp, 'dev');
    const state = path.join(tmp, 'state');
    const repo = path.join(tmp, 'stop-proj');
    const transcript = path.join(tmp, '.gemini', 'antigravity', 'brain', 'agy-conv-stop-1', 'transcript.jsonl');
    fs.mkdirSync(dev, { recursive: true });
    fs.mkdirSync(state, { recursive: true });
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, '{"type":"user"}\n');

    const env = buildIsolatedEnv(dev, state);
    const base = {
      hookEventName: 'Stop',
      conversationId: 'agy-conv-stop-1',
      cwd: repo,
      transcriptPath: transcript,
      modelName: 'gemini-2.5-pro',
    };

    // Normal turn completion -> logs turn_stop
    const r1 = runBridgeCli('log-session-milestones.sh', 10000, {
      ...base,
      executionNum: 1,
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: false,
    }, env);
    assert.deepEqual(r1.parsed, {});

    // USER_CANCELED -> skipped
    const r2 = runBridgeCli('log-session-milestones.sh', 10000, {
      ...base,
      executionNum: 2,
      terminationReason: 'USER_CANCELED',
      continuationActive: false,
    }, env);
    assert.deepEqual(r2.parsed, {});

    // continuationActive: true -> skipped
    const r3 = runBridgeCli('log-session-milestones.sh', 10000, {
      ...base,
      executionNum: 2,
      terminationReason: 'NO_TOOL_CALL',
      continuationActive: true,
    }, env);
    assert.deepEqual(r3.parsed, {});

    const milestones = readJsonl(path.join(dev, 'session-milestones.jsonl'));
    const changes = readJsonl(path.join(dev, 'changelog.jsonl'));
    assert.equal(milestones.length, 1);
    assert.equal(changes.length, 1);
    assert.equal(milestones[0].milestone, 'turn_stop');
    assert.equal(milestones[0].provider, 'antigravity');
    assert.equal(milestones[0].description, 'Antigravity turn completed');
    assert.equal(milestones[0].session_id, 'agy-conv-stop-1');
    assert.equal(milestones[0].transcript_verified, true);
    assert.equal(changes[0].type, 'milestone_turn_stop');
    assert.equal(changes[0].provider, 'antigravity');
  });

  test('error, invalid stdin, missing bash, and timeout fail open with valid Antigravity JSON', async t => {
    const tmp = makeScratch(t);
    const dev = path.join(tmp, 'dev');
    const stateA = path.join(tmp, 'state-a');
    const stateB = path.join(tmp, 'state-b');
    const stateC = path.join(tmp, 'state-c');
    fs.mkdirSync(dev, { recursive: true });

    // Invalid JSON on PreToolUse -> {"decision":"allow"}
    const badPre = runBridgeCli('check-edit-collision.sh', 3000, '{broken json', buildIsolatedEnv(dev, stateA));
    assert.deepEqual(badPre.parsed, { decision: 'allow' });

    // Invalid JSON on PostToolUse -> {}
    const badPost = runBridgeCli('log-tool-use.sh', 3000, '', buildIsolatedEnv(dev, stateA));
    assert.deepEqual(badPost.parsed, {});

    // Missing bash / launch error on PreToolUse -> {"decision":"allow"}
    const noBashEnv = buildIsolatedEnv(dev, stateB, { CARTOGRAPHER_BASH: '/nonexistent/bash-binary' });
    const noBash = runBridgeCli('check-edit-collision.sh', 3000, {
      hookEventName: 'PreToolUse',
      conversationId: 'agy-conv-err-1',
      cwd: tmp,
      toolCall: { id: 'tc-x', name: 'edit_file', args: { Path: path.join(tmp, 'x.js') } },
    }, noBashEnv);
    assert.deepEqual(noBash.parsed, { decision: 'allow' });

    // Timeout on a hanging hook -> terminates cleanly and emits valid JSON
    const hangScript = path.join(tmp, 'hang.sh');
    fs.writeFileSync(hangScript, '#!/bin/bash\nsleep 10\n', { mode: 0o755 });
    let capturedOut = '';
    let capturedErr = '';
    const code = await runBridgeMain(['check-edit-collision.sh', '250'], {
      env: buildIsolatedEnv(dev, stateC),
      stateDir: stateC,
      scriptPath: hangScript,
      stdinText: JSON.stringify({
        hookEventName: 'PreToolUse',
        conversationId: 'agy-conv-timeout-1',
        cwd: tmp,
        toolCall: { id: 'tc-t', name: 'edit_file', args: { Path: path.join(tmp, 't.js') } },
      }),
      stdout: { write(chunk) { capturedOut += chunk; } },
      stderr: { write(chunk) { capturedErr += chunk; } },
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(capturedOut.trim()), { decision: 'allow' });
    assert.match(capturedErr, /timed out/);
  });
});
