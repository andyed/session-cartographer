/**
 * tests/unit/mcp-server.test.js
 *
 * scripts/cartographer-mcp.js exposes recall to agents as MCP tools. It is a
 * thin layer over the CLIs, so the defects it can introduce are the ones this
 * codebase keeps having: an answer that looks complete and is not. Every test
 * here drives the real server over stdio against a throwaway corpus and checks
 * composition, not arrival:
 *
 * - a recall hit fetches back through `get`, untruncated;
 * - `mark_used` writes an access row joined to the recall's call_id under
 *   purpose "mcp", which only works because every serving tool shares that
 *   purpose (an orient served under "focus" could never be marked from here);
 * - the session the *client* gave the server reaches the rows and delta
 *   serving, and a session named in a tool argument reaches nothing;
 * - a client that gives no session (Codex, Hermes) gets "no_session" rows
 *   instead of a borrowed identity, in recall telemetry and in standup alike;
 * - a facts census agrees with an independent count of the fixture;
 * - what the model receives stays inside a budget and still names the call_id
 *   and every event_id.
 *
 * Every assertion reads the result the way the clients hand it to the model
 * (modelSees below): Claude Code 2.1.277 and Codex 0.160 send the serialized
 * structuredContent whenever it is present and drop the text. A test that read
 * structuredContent would pass while the model saw something else, which is
 * how a 3-hit recall came to cost ~1,600 tokens against a promised ~210.
 *
 * Run with: node --test tests/unit/mcp-server.test.js
 */
// Before any import: a live Qdrant would otherwise leak corpus ids into fixture
// expectations (docs/TESTING.md). Children inherit it.
process.env.CARTOGRAPHER_SEMANTIC = '0';

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { OFFLINE_INDEX_ENV } from './helpers/offline-index.js';
import { hitLines } from '../../scripts/cartographer-mcp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SERVER = path.join(ROOT, 'scripts', 'cartographer-mcp.js');
const STANDUP = path.join(ROOT, 'scripts', 'cartographer-standup.js');
const CONTROL = path.join(ROOT, 'scripts', 'cartographer-turbo.js');
const PLUGIN = path.join(ROOT, 'plugins', 'session-cartographer');
const runAsync = promisify(execFile);

// Every variable that can name a session or a provider to the CLIs.
const LIVE_IDENTITY_VARS = [
  'CARTOGRAPHER_SESSION_ID', 'CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID',
  'CARTOGRAPHER_PROVIDER', 'CODEX_THREAD_ID', 'CODEX_HOME', 'HERMES_SESSION_ID', 'CARTOGRAPHER_PURPOSE',
];

const HIT = 'evt-mcpfixturehit';
const QUERY = 'zzmcpqq';
// Longer than the 180-character display clip, so a test can tell a summary
// from a record.
const HIT_SUMMARY = `[fix] Commit abc1234: fix(recall): ${QUERY} distinctive fixture token for the MCP server — `
  + 'the record carries more detail than any one-line display can show, including this trailing clause that '
  + 'only an exact fetch returns intact';

const day = (d, h = 0) => `2026-01-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

function changelogRows() {
  const rows = [
    { event_id: HIT, timestamp: day(5), type: 'git_commit', provider: 'codex', project: 'mcpfixture',
      session_id: 'sess-fixture-codex', summary: HIT_SUMMARY,
      transcript_path: '/nonexistent/.codex/sessions/2026/01/05/rollout-sess-fixture-codex.jsonl' },
    // A work arc: parent_event_id links a → b → c inside one session.
    { event_id: 'evt-thr-a', timestamp: day(6, 1), type: 'tool_bash', provider: 'claude', project: 'mcpfixture',
      session_id: 'sess-thread', summary: 'Ran: npm test before the arc fix' },
    { event_id: 'evt-thr-b', timestamp: day(6, 2), type: 'tool_file_edit', provider: 'claude', project: 'mcpfixture',
      session_id: 'sess-thread', parent_event_id: 'evt-thr-a', summary: 'Modified: /tmp/arc.js' },
    { event_id: 'evt-thr-c', timestamp: day(6, 3), type: 'git_commit', provider: 'claude', project: 'mcpfixture',
      session_id: 'sess-thread', parent_event_id: 'evt-thr-b', summary: '[fix] Commit def5678: fix(arc): finish' },
    // What orient's fixed query ("recent activity") can match without the semantic leg.
    { event_id: 'evt-orient-1', timestamp: day(7), type: 'milestone_session_wrapup', provider: 'claude',
      project: 'mcpfixture', session_id: 'sess-orient', summary: 'Wrapup: recent activity on the fixture parser' },
    { event_id: 'evt-orient-other', timestamp: day(7, 1), type: 'milestone_session_wrapup', provider: 'claude',
      project: 'otherfixture', session_id: 'sess-orient-other', summary: 'Wrapup: recent activity elsewhere entirely' },
  ];
  // Filler: BM25 clamps a term found in over half the corpus to zero.
  for (let i = 0; i < 12; i += 1) {
    rows.push({ event_id: `evt-mcpfiller${i}`, timestamp: day(10 + i), type: 'tool_bash', provider: 'claude',
      project: i % 2 ? 'mcpfixture' : 'otherfixture', session_id: `sess-filler-${i}`,
      summary: `Ran: routine filler command ${i} touching unrelated files` });
  }
  return rows;
}

function makeFixture({ freshRows = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-mcp-'));
  const dev = path.join(root, 'dev');
  fs.mkdirSync(dev);
  const rows = [...changelogRows(), ...freshRows];
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  for (const name of ['session-milestones.jsonl', 'research-log.jsonl', 'tool-use-log.jsonl']) {
    fs.writeFileSync(path.join(dev, name), '');
  }
  return {
    root,
    dev,
    rows,
    served: path.join(dev, 'served-log.jsonl'),
    calls: path.join(dev, 'search-calls.jsonl'),
    ledger: path.join(dev, 'access-ledger.jsonl'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function cleanEnv(fx, overrides = {}) {
  const env = { ...process.env };
  for (const key of LIVE_IDENTITY_VARS) delete env[key];
  const none = path.join(fx.root, 'no-transcripts');
  return {
    ...env,
    ...OFFLINE_INDEX_ENV,
    CARTOGRAPHER_DEV_DIR: fx.dev,
    CARTOGRAPHER_SERVED_LOG: fx.served,
    CARTOGRAPHER_SEARCH_CALL_LOG: fx.calls,
    CARTOGRAPHER_ACCESS_LEDGER: fx.ledger,
    CARTOGRAPHER_TRANSCRIPTS_DIR: none,
    CARTOGRAPHER_CLAUDE_TRANSCRIPTS_DIR: none,
    CARTOGRAPHER_CODEX_TRANSCRIPTS_DIR: none,
    CARTOGRAPHER_CODEX_ARCHIVED_DIR: none,
    CARTOGRAPHER_CONFIG: path.join(fx.root, 'no-config.json'),
    CARTOGRAPHER_TURBO_STATE_DIR: path.join(fx.root, 'turbo-state'),
    CARTOGRAPHER_GRAPH: path.join(fx.root, 'graph.json'),
    // standup scans Claude transcripts for SILENT sessions; keep it off the real store.
    CLAUDE_CONFIG_DIR: path.join(fx.root, 'claude-home'),
    CARTOGRAPHER_SEMANTIC: '0',
    // Turbo ignores the caller's semantic flag; keep recall on the portable path.
    CARTOGRAPHER_TURBO: '0',
    // Delta-serving lists land in the fixture, not the shared /tmp.
    TMPDIR_BASE: fx.dev,
    ...overrides,
  };
}

/** A minimal MCP client over the server's stdio. */
class Client {
  constructor(env) {
    this.child = spawn(process.execPath, [SERVER], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.stderr = '';
    this.child.stderr.on('data', (chunk) => { this.stderr += chunk; });
    this.waiting = new Map();
    this.unsolicited = [];
    this.nextId = 0;
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      const resolve = this.waiting.get(message.id);
      if (resolve) {
        this.waiting.delete(message.id);
        resolve(message);
      } else {
        this.unsolicited.push(message);
      }
    });
  }

  raw(text) {
    this.child.stdin.write(`${text}\n`);
  }

  request(method, params) {
    this.nextId += 1;
    const id = this.nextId;
    return new Promise((resolve) => {
      this.waiting.set(id, resolve);
      this.raw(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }

  notify(method, params) {
    this.raw(JSON.stringify({ jsonrpc: '2.0', method, params }));
  }

  async initialize({ protocolVersion = '2025-06-18', client = 'mcp-test' } = {}) {
    const response = await this.request('initialize', {
      protocolVersion, capabilities: {}, clientInfo: { name: client, version: '0' },
    });
    this.notify('notifications/initialized');
    return response.result;
  }

  async call(name, args) {
    const response = await this.request('tools/call', { name, arguments: args });
    assert.ok(response.result, `tools/call ${name} returned a protocol error: ${JSON.stringify(response.error)}`);
    return response.result;
  }

  close() {
    this.child.stdin.end();
    return new Promise((resolve) => this.child.once('close', resolve));
  }
}

async function withServer(fx, overrides, fn, init = {}) {
  const client = new Client(cleanEnv(fx, overrides));
  try {
    await client.initialize(init);
    return await fn(client);
  } finally {
    await client.close();
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

/**
 * The payload the model receives, by the rule Claude Code 2.1.277 and Codex
 * 0.160 both follow (docs/MCP.md): the serialized structuredContent when the
 * result has one, the text blocks otherwise.
 */
function modelSees(result) {
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
}

/** Hermes 0.21 wraps the same text as {"result": …} (tools/mcp_tool.py). */
const hermesSees = (result) => JSON.stringify(result.structuredContent === undefined
  ? { result: modelSees(result) }
  : { result: result.content[0].text, structuredContent: result.structuredContent });

/** Hit lines as the model reads them: "N. date · project · agent · [type ·] summary · event_id". */
function hitsIn(text) {
  return text.split('\n').filter((line) => /^\s*\d+\. /.test(line)).map((line) => {
    const parts = line.trim().split(' · ');
    return { event_id: parts.at(-1), project: parts[1], provider: parts[2], line };
  });
}

const callIdIn = (text) => text.match(/call_id (call-\S+)/)?.[1];

/** get's records, from the JSON after "record: ". */
function recordsIn(text) {
  return text.split('\n').filter((line) => line.startsWith('  record: ')).map((line) => JSON.parse(line.slice(10)));
}

const missingIn = (text) => text.match(/^missing: (.+?) — /m)?.[1].split(', ') ?? [];

const occurrences = (text, needle) => text.split(needle).length - 1;

let counter = 0;
const freshSid = (label) => `sid-mcp-${label}-${process.pid}-${++counter}`;

// ─── Contract ───

test('tools/list names seven tools whose descriptions say when to call them', async () => {
  const fx = makeFixture();
  try {
    const client = new Client(cleanEnv(fx));
    try {
      const init = await client.initialize();
      assert.equal(init.protocolVersion, '2025-06-18');
      assert.equal(init.serverInfo.name, 'session-cartographer');
      assert.ok(init.capabilities.tools, 'the server must declare the tools capability');
      // Claude Code loads server instructions up front and cuts them at 4,096.
      assert.ok(init.instructions.length > 200 && init.instructions.length <= 4096);
      assert.match(init.instructions, /recall/);

      const { result } = await client.request('tools/list', {});
      assert.deepEqual(result.tools.map((t) => t.name),
        ['recall', 'get', 'mark_used', 'thread', 'orient', 'facts', 'standup']);
      for (const tool of result.tools) {
        assert.ok(tool.description.trim().length >= 200, `${tool.name}: description is the product; it is too thin`);
        assert.ok(tool.description.length <= 4096, `${tool.name}: Claude Code cuts descriptions at 4,096`);
        assert.equal(tool.inputSchema.type, 'object');
        assert.equal(tool.inputSchema.additionalProperties, false, `${tool.name}: undeclared arguments must be refused`);
        for (const key of tool.inputSchema.required || []) {
          assert.ok(key in tool.inputSchema.properties, `${tool.name}: required ${key} is not a property`);
        }
        // Identity comes from the client's environment, never from the model.
        assert.ok(!Object.keys(tool.inputSchema.properties).some((key) => /session|provider|purpose/i.test(key)),
          `${tool.name} must not take a session, provider or purpose argument`);
        assert.equal(typeof tool.annotations?.readOnlyHint, 'boolean');
        assert.equal('handler' in tool, false);
        // Results are text only, and Claude Code's MCP client throws "has an
        // output schema but did not return structured content" on that pairing.
        assert.equal(tool.outputSchema, undefined, `${tool.name}: an outputSchema needs structuredContent`);
      }
      const recall = result.tools[0].description;
      for (const cue of ['did we', 'last time', 'I thought we fixed', 'which agent tried', 'mark_used', 'call_id']) {
        assert.ok(recall.includes(cue), `recall's description must name the cue "${cue}"`);
      }
    } finally {
      await client.close();
    }
  } finally {
    fx.cleanup();
  }
});

test('the JSON-RPC surface answers what it must and refuses the rest', async () => {
  const fx = makeFixture();
  try {
    const client = new Client(cleanEnv(fx));
    try {
      const init = await client.initialize({ protocolVersion: '1999-01-01' });
      assert.equal(init.protocolVersion, '2025-11-25', 'an unknown version is answered with the newest supported');

      assert.deepEqual((await client.request('ping')).result, {});
      assert.equal((await client.request('server/discover', {})).error.code, -32601);
      assert.equal((await client.request('tools/call', { name: 'nosuch', arguments: {} })).error.code, -32602);

      client.raw('{not json');
      const pong = await client.request('ping');
      assert.deepEqual(pong.result, {});
      const parseError = client.unsolicited.find((m) => m.error?.code === -32700);
      assert.ok(parseError, 'a parse error is answered');
      assert.equal(parseError.id, null);
      assert.equal(client.unsolicited.filter((m) => m.error?.code !== -32700).length, 0,
        'a notification gets no response');
    } finally {
      await client.close();
    }
  } finally {
    fx.cleanup();
  }
});

test('the plugin registers the server for Claude Code and Codex, and the mirror is byte-identical', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.cartographer;
  assert.equal(claude.command, 'node');
  assert.deepEqual(claude.args, ['${CLAUDE_PLUGIN_ROOT}/scripts/cartographer-mcp.js']);

  // Codex 0.160 expands neither ${CLAUDE_PLUGIN_ROOT} nor ${PLUGIN_ROOT} in
  // args, and its default cwd is the session's workdir; `cwd: "./"` is the
  // plugin root. Its manifest entry overrides .mcp.json there.
  const codex = JSON.parse(fs.readFileSync(path.join(PLUGIN, '.codex-plugin', 'plugin.json'), 'utf8')).mcpServers.cartographer;
  assert.deepEqual(codex, { command: 'node', args: ['./scripts/cartographer-mcp.js'], cwd: './' });
  assert.ok(!JSON.stringify(codex).includes('${'), 'Codex passes ${…} through literally');

  for (const name of ['cartographer-mcp.js', 'facts-render.js', 'cartographer-facts.js', 'sentinels.js']) {
    // Buffer.equals, not deepEqual: on a drift, deepEqual diffs two ~50 KB
    // byte arrays and runs the test process out of heap instead of failing.
    assert.ok(fs.readFileSync(path.join(ROOT, 'scripts', name)).equals(fs.readFileSync(path.join(PLUGIN, 'scripts', name))),
      `${name} drifted from its packaged plugin mirror`);
  }
});

// ─── Composition ───

test('recall hits fetch back through get, and mark_used joins the same call under purpose mcp', async () => {
  const fx = makeFixture();
  const sid = freshSid('compose');
  try {
    await withServer(fx, { CARTOGRAPHER_SESSION_ID: sid }, async (client) => {
      const recall = await client.call('recall', { query: QUERY, limit: 5 });
      assert.equal(recall.isError, undefined, recall.content[0].text);
      const text = modelSees(recall);
      const hits = hitsIn(text);
      // The guard on the guard: without the hit, nothing below is tested.
      assert.equal(hits[0]?.event_id, HIT, text);
      const callId = callIdIn(text);
      assert.match(callId, /^call-\d{8}T\d{6}-mcp\d+-\d+$/);
      assert.ok(text.includes(`call_id="${callId}"`), 'the next-step line hands the call_id to get and mark_used');
      assert.ok(!text.includes(HIT_SUMMARY), 'the display line is a clip, not the record');
      assert.equal(hits[0].provider, 'codex', 'the agent is named from the transcript store');

      const servedRows = readJsonl(fx.served).filter((row) => row.call_id === callId);
      assert.ok(servedRows.some((row) => row.event_id === HIT));
      for (const row of servedRows) {
        assert.equal(row.purpose, 'mcp');
        assert.equal(row.session_id, sid);
        assert.equal(row.attribution_status, 'session');
      }
      const callRows = readJsonl(fx.calls).filter((row) => row.call_id === callId);
      assert.equal(callRows.length, 1, 'one search-call row per recall, written by the CLI');
      assert.equal(callRows[0].purpose, 'mcp');
      assert.equal(callRows[0].result_count, hits.length, 'the model sees every hit the CLI served');

      const fetched = await client.call('get', { event_ids: [HIT, 'evt-mcp-missing'], call_id: callId });
      const fetchedText = modelSees(fetched);
      const records = recordsIn(fetchedText);
      assert.deepEqual(records.map((r) => r.event_id), [HIT]);
      assert.equal(records[0].summary, HIT_SUMMARY, 'get returns the record untruncated');
      assert.deepEqual(missingIn(fetchedText), ['evt-mcp-missing'], 'a miss is reported, not dropped');
      // The point of get: the transcript path, said once, with its state.
      const transcript = fx.rows.find((row) => row.event_id === HIT).transcript_path;
      assert.equal(occurrences(fetchedText, transcript), 1, fetchedText);
      assert.match(fetchedText, /transcript: \S+ \(MISSING on disk\)/);
      assert.ok(fetchedText.includes(callId));
      const fetchRow = readJsonl(fx.ledger).find((row) => row.source === 'result_fetched' && row.event_id === HIT);
      assert.equal(fetchRow?.call_id, callId);
      assert.equal(fetchRow.purpose, 'mcp');

      const marked = await client.call('mark_used', { event_ids: [HIT], call_id: callId });
      const useRows = readJsonl(fx.ledger).filter((row) => row.source === 'result_used');
      assert.equal(useRows.length, 1);
      assert.equal(useRows[0].event_id, HIT);
      assert.equal(useRows[0].call_id, callId, 'the use joins the recall that served it');
      assert.equal(useRows[0].purpose, 'mcp');
      assert.equal(useRows[0].session_id, sid);
      assert.equal(useRows[0].attribution_status, 'explicit');
      assert.match(modelSees(marked), new RegExp(`1 of 1 recorded · call_id ${callId}`));
      assert.match(modelSees(marked), new RegExp(`${HIT}\\s+explicit: attributed to the call`));
    });
  } finally {
    fx.cleanup();
  }
});

test('a client that gives the server no session gets no_session rows, named by its clientInfo', async () => {
  const fx = makeFixture();
  try {
    // What Codex 0.160 sends, with none of the chain variables in the child.
    await withServer(fx, {}, async (client) => {
      const recall = await client.call('recall', { query: QUERY, limit: 3 });
      const callId = callIdIn(modelSees(recall));
      assert.equal(hitsIn(modelSees(recall))[0]?.event_id, HIT);
      const servedRows = readJsonl(fx.served).filter((row) => row.call_id === callId);
      assert.ok(servedRows.length > 0);
      for (const row of servedRows) {
        assert.equal(row.session_id, '');
        assert.equal(row.attribution_status, 'no_session');
        assert.equal(row.provider, 'codex');
      }

      const marked = await client.call('mark_used', { event_ids: [HIT], call_id: callId });
      const useRow = readJsonl(fx.ledger).find((row) => row.source === 'result_used');
      assert.equal(useRow.attribution_status, 'no_session');
      assert.equal(useRow.call_id, undefined, 'an empty session never joins a mark to a serve');
      assert.equal(useRow.requested_call_id, callId);
      assert.match(modelSees(marked), new RegExp(`${HIT}\\s+no_session: .*no session id`));
    }, { client: 'codex-mcp-client' });

    // Without a recognizable client the provider stays unknown, so the label
    // above came from clientInfo and not from something else in the env.
    await withServer(fx, {}, async (client) => {
      const recall = await client.call('recall', { query: QUERY, limit: 3, include_seen: true });
      const rows = readJsonl(fx.served).filter((row) => row.call_id === callIdIn(modelSees(recall)));
      assert.ok(rows.length > 0);
      assert.ok(rows.every((row) => row.provider === 'unknown'));
    }, { client: 'some-other-client' });
  } finally {
    fx.cleanup();
  }
});

test('delta serving follows the session the client gave the server', async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, { CARTOGRAPHER_SESSION_ID: freshSid('delta') }, async (client) => {
      const first = await client.call('recall', { query: QUERY, limit: 5 });
      assert.equal(hitsIn(modelSees(first))[0]?.event_id, HIT);
      const second = await client.call('recall', { query: QUERY, limit: 5 });
      assert.ok(!hitsIn(modelSees(second)).some((r) => r.event_id === HIT), 'a repeat hides what was shown');
      assert.match(modelSees(second), /include_seen=true/);
      const third = await client.call('recall', { query: QUERY, limit: 5, include_seen: true });
      assert.equal(hitsIn(modelSees(third))[0]?.event_id, HIT, 'include_seen re-shows it');
    });
  } finally {
    fx.cleanup();
  }
});

test('a session id passed as a tool argument is refused and reaches no row', async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, {}, async (client) => {
      const refused = await client.call('recall', { query: QUERY, session_id: 'sid-forged' });
      assert.equal(refused.isError, true);
      assert.match(refused.content[0].text, /does not take session_id/);
      const marked = await client.call('mark_used', { event_ids: [HIT], call_id: 'call-x', session: 'sid-forged' });
      assert.equal(marked.isError, true);
    });
    const everything = [...readJsonl(fx.served), ...readJsonl(fx.calls), ...readJsonl(fx.ledger)];
    assert.equal(everything.length, 0, 'a refused call runs nothing');
  } finally {
    fx.cleanup();
  }
});

test('input errors come back as tool errors the model can act on', async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, {}, async (client) => {
      const cases = [
        ['recall', {}, /query is required/],
        ['recall', { query: '--project' }, /must not start with "-"/],
        ['recall', { query: QUERY, since: 'notatime' }, /could not be parsed/],
        ['recall', { query: QUERY, intent: 'nonsense' }, /intent must be one of/],
        ['recall', { query: QUERY, limit: 500 }, /limit must be an integer/],
        ['get', { event_ids: ['bad id!'] }, /malformed event_id/],
        ['mark_used', { event_ids: [HIT] }, /call_id is required/],
        // The CLI falls back to 6h on a window it cannot parse; refuse instead.
        ['standup', { window: '1w' }, /must look like 90m, 6h or 2d/],
        ['facts', { verb: 'delta', since: '7d' }, /bounded by its cursor/],
      ];
      for (const [name, args, pattern] of cases) {
        const result = await client.call(name, args);
        assert.equal(result.isError, true, `${name} ${JSON.stringify(args)} should fail`);
        assert.match(result.content[0].text, pattern);
      }
    });
  } finally {
    fx.cleanup();
  }
});

// ─── What the model receives ───

// A 6,000-character summary on a hit: an answer that passed records through
// unclipped (as structuredContent did) cannot fit the budget below.
const LONG = 'evt-mcplongsummary';
const LONG_SUMMARY = `Wrapup: ${QUERY} long record ${'with a great deal of detail '.repeat(215)}`;

// Header and next-step lines, plus one display line per hit: rank, date,
// project, agent, type, a 180-character clip and the id.
const RECALL_FIXED_BUDGET = 900;
const RECALL_HIT_BUDGET = 330;

test('what the model receives from recall fits its budget and names the call_id and every event_id', async () => {
  const freshRows = [{ event_id: LONG, timestamp: day(4), type: 'milestone_session_wrapup', provider: 'claude',
    project: 'mcpfixture', session_id: 'sess-long', summary: LONG_SUMMARY }];
  const fx = makeFixture({ freshRows });
  try {
    for (const protocolVersion of ['2025-11-25', '2025-06-18', '2025-03-26']) {
      await withServer(fx, {}, async (client) => {
        const recall = await client.call('recall', { query: QUERY, limit: 10 });
        assert.equal(recall.structuredContent, undefined, `${protocolVersion}: no client would show the text`);
        const text = modelSees(recall);
        const hits = hitsIn(text);
        // Without the long record among the hits the budget proves nothing.
        assert.ok(hits.some((hit) => hit.event_id === LONG), text);
        assert.ok(LONG_SUMMARY.length > RECALL_FIXED_BUDGET + RECALL_HIT_BUDGET * hits.length,
          'the fixture must hold a record too long to pass through whole');

        const budget = RECALL_FIXED_BUDGET + RECALL_HIT_BUDGET * hits.length;
        assert.ok(text.length <= budget, `recall sent ${text.length} characters for ${hits.length} hits (budget ${budget})`);
        assert.ok(hermesSees(recall).length <= budget * 1.1, 'Hermes wraps the same text, not text plus JSON');
        for (const hit of hits) assert.ok(hit.line.length <= RECALL_HIT_BUDGET, hit.line);

        const callId = callIdIn(text);
        const callRow = readJsonl(fx.calls).find((row) => row.call_id === callId);
        assert.ok(callRow, 'the call_id the model sees is the one the CLI recorded');
        const served = readJsonl(fx.served).filter((row) => row.call_id === callId).map((row) => row.event_id);
        assert.deepEqual(hits.map((hit) => hit.event_id).sort(), [...new Set(served)].sort(),
          'every event_id served is in what the model sees');
      }, { protocolVersion });
    }
  } finally {
    fx.cleanup();
  }
});

test('no tool answers with structuredContent', async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, { CARTOGRAPHER_SESSION_ID: freshSid('nostruct') }, async (client) => {
      const recall = await client.call('recall', { query: QUERY, limit: 3 });
      const callId = callIdIn(modelSees(recall));
      const results = [
        recall,
        await client.call('get', { event_ids: [HIT], call_id: callId }),
        await client.call('mark_used', { event_ids: [HIT], call_id: callId }),
        await client.call('thread', { event_id: 'evt-thr-b' }),
        await client.call('orient', { project: 'mcpfixture', limit: 3 }),
        await client.call('standup', { window: '2h' }),
      ];
      for (const result of results) {
        assert.equal(result.isError, undefined, result.content[0].text);
        assert.equal(result.structuredContent, undefined, result.content[0].text.split('\n')[0]);
        assert.deepEqual(result.content.map((block) => block.type), ['text']);
      }
    });
  } finally {
    fx.cleanup();
  }
});

test('get says each transcript path once and keeps the record whole', async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, {}, async (client) => {
      const ids = [HIT, 'evt-thr-a', 'evt-thr-b'];
      const fetched = await client.call('get', { event_ids: ids });
      const text = modelSees(fetched);
      const records = recordsIn(text);
      assert.deepEqual(records.map((r) => r.event_id), ids, text);
      for (const record of records) {
        const original = fx.rows.find((row) => row.event_id === record.event_id);
        assert.equal(record.summary, original.summary, 'untruncated');
        assert.equal(record.session_id, original.session_id);
      }
      // Measured: one transcript line per record plus the JSON, no second copy.
      const recordJson = records.reduce((sum, record) => sum + JSON.stringify(record).length, 0);
      assert.ok(text.length <= recordJson + 300 * records.length, `get sent ${text.length} for ${recordJson} of records`);
    });
  } finally {
    fx.cleanup();
  }
});

test('a conversation-turn hit carries its transcript path, because get cannot fetch it', () => {
  const transcript = '/Users/x/.claude/projects/-p/0f7a.jsonl';
  const base = { rank: 1, timestamp: '2026-10-15T22:07:28Z', project: 'p', provider: 'claude', event_type: '',
    source: 'semantic', summary: 'a turn', transcript_path: transcript };
  const turn = hitLines({ ...base, event_id: 'turn-0f7a-566' });
  assert.equal(turn.length, 2);
  assert.match(turn[0], /· turn-0f7a-566$/);
  assert.equal(turn[1], `    transcript: ${transcript}`);
  // An event-log hit leaves its path to get: about 60 tokens a hit saved.
  assert.deepEqual(hitLines({ ...base, event_id: 'evt-abc', event_type: 'git_commit' }).length, 1);
  assert.deepEqual(hitLines({ ...base, event_id: 'turn-0f7a-1', transcript_path: null }).length, 1);
});

// ─── The other lenses ───

test('thread returns the arc oldest first with the anchor marked', async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, {}, async (client) => {
      const arc = modelSees(await client.call('thread', { event_id: 'evt-thr-b' }));
      const events = arc.split('\n').filter((line) => / · evt-\S+$/.test(line))
        .map((line) => [line.split(' · ').at(-1), line.startsWith('★')]);
      assert.deepEqual(events, [['evt-thr-a', false], ['evt-thr-b', true], ['evt-thr-c', false]], arc);
      assert.match(arc, /^★ .* · Modified: \/tmp\/arc\.js · evt-thr-b$/m);

      const none = await client.call('thread', { event_id: 'evt-not-there' });
      assert.equal(none.isError, undefined, 'an unknown anchor is an answer, not a failure');
      assert.match(modelSees(none), /no changelog event evt-not-there/);
    });
  } finally {
    fx.cleanup();
  }
});

test('orient serves under purpose mcp, so its hits can be marked used from here', async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, { CARTOGRAPHER_SESSION_ID: freshSid('orient') }, async (client) => {
      const orient = await client.call('orient', { project: 'mcpfixture' });
      assert.equal(orient.isError, undefined, orient.content[0].text);
      const text = modelSees(orient);
      const callId = callIdIn(text);
      const results = hitsIn(text);
      assert.ok(results.some((r) => r.event_id === 'evt-orient-1'), text);
      // The fixture holds the same words in another project; scope must hold.
      assert.ok(results.every((r) => r.project === 'mcpfixture'));
      assert.match(text, /not a timeline/);

      await client.call('mark_used', { event_ids: ['evt-orient-1'], call_id: callId });
      const useRow = readJsonl(fx.ledger).find((row) => row.source === 'result_used');
      assert.equal(useRow.call_id, callId);
      assert.equal(useRow.attribution_status, 'explicit');
    });
  } finally {
    fx.cleanup();
  }
});

test('standup does not let a fresh peer pass for the caller when the client gave no session', async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z');
  // Ids whose first eight characters differ: the text roster prints that much.
  const freshRows = [
    { event_id: 'evt-peer-old', timestamp: iso(now - 30 * 60e3), type: 'tool_bash', provider: 'claude',
      project: 'mcpfixture', session_id: 'peerold1-session', summary: 'Ran: ls' },
    { event_id: 'evt-peer-fresh', timestamp: iso(now - 20e3), type: 'tool_bash', provider: 'codex',
      project: 'mcpfixture', session_id: 'peerfrsh-session', summary: 'Ran: git status' },
  ];
  const fx = makeFixture({ freshRows });
  try {
    // Without the fix the CLI's heuristic claims the freshest session as "you",
    // which drops a real peer from the roster.
    // CODEX_HOME only here: the search CLI reads its presence as "provider codex".
    const isolated = { CODEX_HOME: path.join(fx.root, 'codex-home') };
    const direct = spawnSync(process.execPath, [STANDUP, '--since', '2h', '--json'],
      { env: cleanEnv(fx, isolated), encoding: 'utf8' });
    assert.equal(direct.status, 0, direct.stderr);
    const claimed = JSON.parse(direct.stdout).sessions.find((s) => s.id === 'peerfrsh-session');
    assert.equal(claimed?.is_self, true, 'the fixture must exercise the newest-event heuristic');
    // And the text marks the claimed one, so its absence below means something.
    const directText = spawnSync(process.execPath, [STANDUP, '--since', '2h'], { env: cleanEnv(fx, isolated), encoding: 'utf8' });
    assert.match(directText.stdout, /\(you\)|you are/);

    await withServer(fx, isolated, async (client) => {
      const standup = await client.call('standup', { window: '2h' });
      assert.equal(standup.isError, undefined, standup.content[0].text);
      const text = modelSees(standup);
      assert.match(text, /peerold1/);
      assert.match(text, /peerfrsh/);
      assert.doesNotMatch(text, /\(you\)|you are/, 'no peer is mistaken for the caller');
    }, { client: 'codex-mcp-client' });
  } finally {
    fx.cleanup();
  }
});

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

test('a facts census through the server agrees with an independent count', async () => {
  const fx = makeFixture();
  const turboEnv = cleanEnv(fx, { CARTOGRAPHER_TURBO_URL: `http://127.0.0.1:${await freePort()}` });
  try {
    await runAsync(process.execPath, [CONTROL, 'start'], { env: turboEnv });
    const readyFile = path.join(turboEnv.CARTOGRAPHER_TURBO_STATE_DIR, 'ready.json');
    for (let i = 0; i < 100; i += 1) {
      try { if (JSON.parse(fs.readFileSync(readyFile, 'utf8')).http === 'listening') break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // Absolute dates are local midnight to facts (the CLI's parseTimeArg), so
    // the window sits a day clear of every fixture timestamp in any timezone.
    const since = '2026-01-08';
    const before = '2026-02-01';
    const inWindow = fx.rows.filter((r) => r.timestamp >= `${since}T00:00:00Z` && r.timestamp < `${before}T00:00:00Z`);
    assert.ok(!fx.rows.some((r) => r.timestamp.startsWith('2026-01-08') || r.timestamp.startsWith('2026-01-09')),
      'no fixture row may sit where the timezone decides it');
    const expectedFixture = inWindow.filter((r) => r.project === 'mcpfixture').length;
    // Without this the window could include everything and prove nothing.
    assert.ok(inWindow.length < fx.rows.length && expectedFixture > 0);

    await withServer(fx, { CARTOGRAPHER_TURBO_URL: turboEnv.CARTOGRAPHER_TURBO_URL }, async (client) => {
      const census = await client.call('facts', { verb: 'census', since, before, top: 10, sample: 2 });
      assert.equal(census.isError, undefined, census.content[0].text);
      const text = modelSees(census);
      assert.match(text, /facts census/);
      assert.equal(Number(text.match(/^([\d,]+) events · /m)?.[1].replace(/,/g, '')), inWindow.length,
        'the census counts what a scan counts');
      // The by_project table row: name, count, sample event_ids.
      const byProject = text.slice(text.indexOf('by_project'), text.indexOf('by_type'));
      const bucket = byProject.match(/^ {2}mcpfixture +(\d+) +(.+)$/m);
      assert.ok(bucket, text);
      assert.equal(Number(bucket[1]), expectedFixture);
      const sampleIds = bucket[2].trim().split(/\s+/);

      // A number is only as good as the ids behind it.
      const fetched = modelSees(await client.call('get', { event_ids: sampleIds }));
      assert.deepEqual(missingIn(fetched), []);
      assert.equal(recordsIn(fetched).length, sampleIds.length);
      assert.ok(recordsIn(fetched).every((r) => r.project === 'mcpfixture'));
    });
  } finally {
    try { await runAsync(process.execPath, [CONTROL, 'stop'], { env: turboEnv }); } catch {}
    fx.cleanup();
  }
});
