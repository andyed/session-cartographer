import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { codexActions, FLOWMAP_OPTIONS } from '../../explorer/server/flowmap.js';
import { classify } from '../../explorer/shared/flowmap/classify.js';
import { isScreen, seatScreen } from '../../explorer/shared/flowmap/kinds.js';
import { setupFrom } from '../../explorer/shared/flowmap/setup.js';

const setup = setupFrom(FLOWMAP_OPTIONS);
const T0 = Date.parse('2026-11-15T12:00:00.000Z');
const at = s => new Date(T0 + s * 1000).toISOString();
const PWSH = 'C:\\Program Files\\WindowsApps\\OpenAI.CodexPrimaryRuntime_26.1112\\dependencies\\native\\powershell\\pwsh.exe';

// Codex on Windows runs every command as ["…\\pwsh.exe", "-Command", "<script>"], and drives the desktop through
// `cua_repl` and the browser through `node_repl`, each call carrying a `title`. Recorded on BIGFU, 2026-11-15.
function rollout(t, items) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'carto-codex-win-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'rollout.jsonl');
  const rows = [
    { timestamp: at(0), type: 'session_meta', payload: { id: 'thread', cwd: 'C:\\dev', source: 'vscode' } },
    ...items.map((body, i) => ({ timestamp: at(1 + i), type: 'event_msg', payload: { type: 'item_completed', item: body } })),
  ];
  fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return codexActions(file, setup);
}

const command = script => ({ type: 'CommandExecution', id: `e-${script.length}`, command: [PWSH, '-Command', script], status: 'completed', duration: { secs: 0, nanos: 100_000_000 } });

test('a PowerShell command in a Codex rollout is read by PowerShell\'s rules', t => {
  const { actions, notes } = rollout(t, [
    command("Get-Content -LiteralPath 'C:\\dev\\a.md'; Get-Content -LiteralPath 'C:\\dev\\b.md'"),
    command('git push origin main'),
    command('Invoke-RestMethod https://example.com/api'),
    command('Get-Process | Stop-Process'),
  ]);
  assert.deepEqual(actions.map(a => a.station), ['files', 'web', 'web', 'shell']);
  assert.equal(actions[0].label, 'Get-Content');
  assert.deepEqual(notes.unknown_items, {});
});

test('a PowerShell script is labelled by its first command, not by an assignment or an expression', t => {
  const { actions } = rollout(t, [
    command('$codexBin=(Get-ChildItem C:\\tools -Filter codex.exe)\nGet-Content $codexBin'),
    command('$probe = Get-Command node\n$probe.Source'),
    command('[Environment]::GetEnvironmentVariable("Path","Machine")'),
    command('try {\n  Remove-Item C:\\tmp\\x\n} catch {}'),
    command('& "C:\\Program Files\\Git\\cmd\\git.exe" status'),
  ]);
  assert.deepEqual(actions.map(a => a.label), ['Get-ChildItem', 'Get-Command', 'powershell', 'Remove-Item', 'git']);
});

test('a macOS command in a Codex rollout is still read as a shell line', t => {
  const { actions } = rollout(t, [{ type: 'CommandExecution', id: 'z1', command: ['/bin/zsh', '-lc', 'rg foo src'], status: 'completed', duration: { secs: 0, nanos: 1 } }]);
  assert.equal(actions[0].station, 'files');
  assert.equal(actions[0].label, 'rg');
});

test("Codex's computer use and browser are at Browser, labelled by the title the call gave, and computer use is Your screen", t => {
  const { actions } = rollout(t, [
    { type: 'McpToolCall', id: 'm1', server: 'cua_repl', tool: 'js', arguments: { code: 'await cua.listApps()', title: 'Finding the active dialog' }, status: 'completed' },
    { type: 'McpToolCall', id: 'm2', server: 'node_repl', tool: 'js', arguments: { code: 'sky.list_apps()', title: 'Opening NVIDIA App' }, status: 'completed' },
    { type: 'McpToolCall', id: 'm3', server: 'node_repl', tool: 'js', arguments: { code: 'x' }, status: 'completed' },
    { type: 'McpToolCall', id: 'm4', server: 'codex_apps', tool: 'github_fetch_file', arguments: {}, status: 'completed' },
  ]);
  assert.deepEqual(actions.map(a => [a.station, a.label]), [['browser', 'Finding the active dialog'], ['browser', 'Opening NVIDIA App'], ['browser', 'js'], ['web', 'codex_apps: github fetch file']]);
  assert.deepEqual(seatScreen(actions).map(a => a.station), ['screen', 'browser', 'browser', 'web']);
  assert.equal(isScreen({ tool: 'node_repl.js' }), false);
  // The code the call ran is never in a label.
  assert.ok(actions.every(a => !/listApps|sky\./.test(a.label)));
  assert.equal(classify('mcp__cua_repl__js', { title: 'x'.repeat(200) }, setup).label.length <= 72, true);
});

test('a spawned agent is a call at Agents, and a requested pause is no work', t => {
  const { actions, notes } = rollout(t, [
    { type: 'SubAgentActivity', id: 'a1', kind: 'started', agent_thread_id: 'thread-2', agent_path: '/root/proof_visual_review', model: 'gpt-6-astra' },
    { type: 'Extension', id: 'x1', kind: 'clock.sleep', durationMs: 45_000 },
  ]);
  assert.deepEqual(actions.map(a => [a.station, a.label, a.tool]), [['agents', 'proof_visual_review', 'spawn_agent']]);
  assert.deepEqual(notes.unknown_items, {});
});
