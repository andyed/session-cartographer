import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { planConfig, run } from '../../scripts/codex-loopback-setup.js';

test('blank config gets a least-privilege legacy loopback policy', () => {
  const plan = planConfig('');
  assert.equal(plan.mode, 'legacy');
  assert.match(plan.text, /^sandbox_mode = "workspace-write"/);
  assert.match(plan.text, /\[sandbox_workspace_write]\nnetwork_access = true/);
  assert.match(plan.text, /\[features\.network_proxy]/);
  assert.match(plan.text, /enabled = true/);
  assert.match(plan.text, /domains = \{ "localhost" = "allow", "127\.0\.0\.1" = "allow" \}/);
  assert.deepEqual(planConfig(plan.text).changes, []);
});

test('legacy config preserves unrelated settings and existing domain rules', () => {
  const original = `# user choices
sandbox_mode = "workspace-write"
model = "fixture-model"

[features]
memories = true

[features.network_proxy]
enabled = false
domains = { "api.example.com" = "allow", "localhost" = "deny" }
`;
  const plan = planConfig(original);
  assert.match(plan.text, /# user choices/);
  assert.match(plan.text, /model = "fixture-model"/);
  assert.match(plan.text, /memories = true/);
  assert.match(plan.text, /"api\.example\.com" = "allow"/);
  assert.match(plan.text, /"localhost" = "allow"/);
  assert.match(plan.text, /"127\.0\.0\.1" = "allow"/);
  assert.doesNotMatch(plan.text, /"localhost" = "deny"/);
});

test('permission profile config enables network only on the selected profile', () => {
  const original = `default_permissions = "project-edit"

[features]
js_repl = false

[permissions.project-edit]
extends = ":workspace"
`;
  const plan = planConfig(original);
  assert.equal(plan.mode, 'profile');
  assert.equal(plan.profile, 'project-edit');
  assert.match(plan.text, /\[features]\njs_repl = false\nnetwork_proxy = true/);
  assert.match(plan.text, /\[permissions\.project-edit\.network]\nenabled = true/);
  assert.match(plan.text, /\[permissions\.project-edit\.network\.domains]/);
  assert.match(plan.text, /"localhost" = "allow"/);
  assert.match(plan.text, /"127\.0\.0\.1" = "allow"/);
  assert.deepEqual(planConfig(plan.text).changes, []);
});

test('built-in workspace profile is extended instead of being redefined', () => {
  const plan = planConfig('default_permissions = ":workspace"\n');
  assert.equal(plan.profile, 'session-cartographer');
  assert.match(plan.text, /default_permissions = "session-cartographer"/);
  assert.match(plan.text, /\[permissions\.session-cartographer]\nextends = ":workspace"/);
});

test('mixed legacy and permission-profile models require manual review', () => {
  assert.throws(
    () => planConfig('sandbox_mode = "workspace-write"\ndefault_permissions = "project-edit"\n'),
    /mixes legacy sandbox settings with permission profiles/
  );
});

test('apply writes atomically, backs up an existing config, and reports restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-codex-loopback-'));
  const config = path.join(root, 'config.toml');
  const original = 'sandbox_mode = "workspace-write"\n';
  fs.writeFileSync(config, original, { mode: 0o600 });
  try {
    const result = await run(['apply', '--config', config, '--json', '--no-probe'], {
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.config_status, 'updated');
    assert.equal(result.report.restart_required, true);
    assert.equal(result.report.current_task_network, 'disabled');
    assert.ok(result.report.backup_path);
    assert.equal(fs.readFileSync(result.report.backup_path, 'utf8'), original);
    assert.match(fs.readFileSync(config, 'utf8'), /network_access = true/);
    assert.equal(fs.statSync(config).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('generated legacy and profile configs parse in the installed Codex CLI', (t) => {
  const available = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  if (available.error?.code === 'ENOENT') {
    t.skip('Codex CLI is not installed');
    return;
  }
  assert.equal(available.status, 0);

  const fixtures = [
    planConfig('').text,
    planConfig(`default_permissions = "project-edit"

[permissions.project-edit]
extends = ":workspace"
`).text,
  ];
  for (const fixture of fixtures) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-codex-parse-'));
    try {
      fs.writeFileSync(path.join(root, 'config.toml'), fixture, { mode: 0o600 });
      const parsed = spawnSync('codex', ['features', 'list'], {
        encoding: 'utf8',
        env: { ...process.env, CODEX_HOME: root },
      });
      assert.equal(parsed.status, 0, parsed.stderr);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('doctor verifies the same Qdrant and embedder health endpoints used in setup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-codex-doctor-'));
  const bin = path.join(root, 'bin');
  const config = path.join(root, 'config.toml');
  const calls = path.join(root, 'calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(config, planConfig('').text);
  fs.writeFileSync(path.join(bin, 'curl'), `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_CALLS"
printf 200
`);
  fs.chmodSync(path.join(bin, 'curl'), 0o755);
  try {
    const result = await run(['doctor', '--config', config, '--json'], {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_CALLS: calls,
      CODEX_SANDBOX_NETWORK_DISABLED: '0',
    });
    assert.equal(result.report.services.qdrant.status, 'healthy');
    assert.equal(result.report.services.embedder.status, 'healthy');
    const invoked = fs.readFileSync(calls, 'utf8');
    assert.match(invoked, /http:\/\/localhost:6333\/healthz/);
    assert.match(invoked, /http:\/\/localhost:8890\/health/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
