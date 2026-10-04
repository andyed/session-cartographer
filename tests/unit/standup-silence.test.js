/**
 * tests/unit/standup-silence.test.js
 *
 * SILENT and UNCLAIMED exist because standup's other failure is invisible: a session whose
 * hooks never fire is not idle, it is absent. On 2026-10-04 a Codex session edited files in
 * psychodeli-webgl-port for an hour while standup showed every session idle — 0.8.1 had moved
 * Codex to hooks/codex-hooks.json and every trust record in ~/.codex/config.toml still named
 * hooks/hooks.json, so Codex skipped the hooks without a word for a week.
 *
 * The end-to-end fixture reproduces that shape: a Codex rollout written in the window with no
 * events, an untrusted hook file, and a tracked file changed with no logged edit. The unit
 * cases pin each check on its own, including the rule that a logged command naming the file
 * outranks transcript mentions (an edit through a Python heredoc logs only `Ran: …`).
 *
 * Run with: node --test tests/unit/standup-silence.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  codexRollouts, codexHookTrust, unclaimedChanges, transcriptMentions, commandEvidence,
} from '../../scripts/standup-silence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT = path.join(ROOT, 'scripts', 'cartographer-standup.js');
const PLUGIN = 'session-cartographer@session-cartographer';
const CODEX_ID = '01a107bc-551f-7441-8451-91be4bc8ebce';
const CLAUDE_ID = 'aaaaaaaa-1111-4111-8111-111111111111';

const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const pad = (n) => String(n).padStart(2, '0');
const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
const git = (...args) => {
  const res = spawnSync('git', args, { encoding: 'utf-8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
};

/** A Codex home with the plugin installed (manifest → hookFile) and trust for `trustedFile`. */
function codexHome({ hookFile = 'hooks/codex-hooks.json', trustedFile = 'hooks/hooks.json', trustedEvents } = {}) {
  const home = tmp('codex-home-');
  const ver = path.join(home, 'plugins', 'cache', 'session-cartographer', 'session-cartographer', '0.8.1');
  fs.mkdirSync(path.join(ver, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(ver, 'hooks'), { recursive: true });
  fs.writeFileSync(path.join(ver, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'session-cartographer', hooks: `./${hookFile}` }));
  fs.writeFileSync(path.join(ver, hookFile), JSON.stringify({ hooks: { SessionStart: [], PostToolUse: [], Stop: [] } }));
  const events = trustedEvents || ['session_start', 'post_tool_use', 'stop'];
  const toml = events.map((e) => `[hooks.state."${PLUGIN}:${trustedFile}:${e}:0:0"]\ntrusted_hash = "sha256:00"\n`).join('\n');
  fs.writeFileSync(path.join(home, 'config.toml'), `model = "x"\n\n[hooks.state]\n\n${toml}`);
  return home;
}

/** A rollout transcript under the local-date directory, as Codex files them. */
function writeRollout(home, id, body, minutesAgo = 1) {
  const d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-10-04T09-25-45-${id}.jsonl`);
  fs.writeFileSync(file, body);
  const t = new Date(Date.now() - minutesAgo * 60e3);
  fs.utimesSync(file, t, t);
  return file;
}

test('codexHookTrust: trust recorded only for the old hook file reads as untrusted', () => {
  const r = codexHookTrust({ codexHome: codexHome() });
  assert.equal(r.status, 'untrusted');
  assert.equal(r.hookFile, 'hooks/codex-hooks.json');
  assert.deepEqual(r.trustedFiles, ['hooks/hooks.json']);
});

test('codexHookTrust: trusted, partial, and not installed', () => {
  assert.equal(codexHookTrust({ codexHome: codexHome({ trustedFile: 'hooks/codex-hooks.json' }) }).status, 'trusted');
  const partial = codexHookTrust({ codexHome: codexHome({ trustedFile: 'hooks/codex-hooks.json', trustedEvents: ['session_start'] }) });
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.missingEvents.sort(), ['post_tool_use', 'stop']);
  assert.equal(codexHookTrust({ codexHome: tmp('codex-none-') }).status, 'not-installed');
});

test('codexRollouts: only transcripts written inside the window, id parsed from the name', () => {
  const home = tmp('codex-rollouts-');
  writeRollout(home, CODEX_ID, '{}\n', 5);
  writeRollout(home, 'bbbbbbbb-2222-4222-8222-222222222222', '{}\n', 600);
  const got = codexRollouts({ codexHome: home, sinceMs: Date.now() - 60 * 60e3 });
  assert.deepEqual(got.map((r) => r.id), [CODEX_ID]);
});

test('unclaimedChanges: tracked, in the window, not claimed — untracked and old files are not news', () => {
  const repo = tmp('unclaimed-');
  for (const f of ['a.js', 'b.js', 'old.js']) fs.writeFileSync(path.join(repo, f), '1\n');
  git('-C', repo, 'init', '-q');
  git('-C', repo, 'add', '.');
  git('-C', repo, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture');
  for (const f of ['a.js', 'b.js', 'old.js']) fs.writeFileSync(path.join(repo, f), '2\n');
  fs.writeFileSync(path.join(repo, 'untracked.js'), '1\n');
  const long = new Date(Date.now() - 5 * 3600e3);
  fs.utimesSync(path.join(repo, 'old.js'), long, long);
  const claimed = new Set([path.join(repo, 'b.js')]);
  const got = unclaimedChanges({ repo, sinceMs: Date.now() - 3600e3, claimed });
  assert.deepEqual(got.map((u) => u.rel), ['a.js']);
});

test('commandEvidence: a logged command naming the file just before it changed', () => {
  const mtimeMs = Date.now();
  const events = [
    { timestamp: iso(1), session_id: CLAUDE_ID, provider: 'claude', summary: "Ran: python3 - <<'EOF' p='src/app.js'" },
    { timestamp: iso(30), session_id: 'cccccccc-3333-4333-8333-333333333333', provider: 'claude', summary: 'Ran: sed -n 1,9p src/app.js' },
  ];
  const hits = commandEvidence({ events, rel: 'src/app.js', abs: '/x/src/app.js', mtimeMs });
  assert.equal(hits.length, 1, 'the 30-minute-old read is outside the 10-minute window');
  assert.equal(hits[0].id, CLAUDE_ID);
});

test('transcriptMentions: per-transcript counts for each path', () => {
  const dir = tmp('mentions-');
  const a = path.join(dir, 'a.jsonl');
  const b = path.join(dir, 'b.jsonl');
  fs.writeFileSync(a, 'edit src/app.js\nagain src/app.js and docs/x.md\n');
  fs.writeFileSync(b, 'nothing here\n');
  const m = transcriptMentions({
    transcripts: [{ id: 'a', provider: 'codex', path: a, mtimeMs: 1 }, { id: 'b', provider: 'claude', path: b, mtimeMs: 2 }],
    needles: ['src/app.js', 'docs/x.md', 'never.js'],
  });
  assert.deepEqual(m.get('src/app.js'), [{ id: 'a', provider: 'codex', mtimeMs: 1, count: 2 }]);
  assert.equal(m.get('docs/x.md')[0].count, 1);
  assert.deepEqual(m.get('never.js'), []);
});

test('end to end: a hookless Codex editor shows as SILENT and its change as UNCLAIMED', () => {
  const dev = tmp('standup-silent-');
  const repo = path.join(dev, 'widgetworks');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), '1\n');
  fs.writeFileSync(path.join(repo, 'src', 'logged.js'), '1\n');
  git('-C', repo, 'init', '-q');
  git('-C', repo, 'add', '.');
  git('-C', repo, '-c', 'user.name=F', '-c', 'user.email=f@example.invalid', 'commit', '-qm', 'fixture');
  fs.writeFileSync(path.join(repo, 'src', 'app.js'), '2\n');       // the Codex edit: no event
  fs.writeFileSync(path.join(repo, 'src', 'logged.js'), '2\n');    // a logged Claude edit
  fs.writeFileSync(path.join(dev, 'changelog.jsonl'), JSON.stringify({
    event_id: 'evt-1', provider: 'claude', type: 'tool_file_edit', timestamp: iso(2),
    session_id: CLAUDE_ID, project: 'widgetworks', cwd: repo, summary: 'Modified: src/logged.js',
  }) + '\n');
  const home = codexHome();
  writeRollout(home, CODEX_ID, '{"cmd":"apply_patch src/app.js"}\n{"cmd":"cat src/app.js"}\n', 1);

  const res = spawnSync(process.execPath, [SCRIPT, '--project', 'widgetworks', '--since', '1h'], {
    encoding: 'utf-8', cwd: dev,
    env: { ...process.env, CARTOGRAPHER_DEV_DIR: dev, CARTOGRAPHER_SESSION_ID: CLAUDE_ID,
           CLAUDE_SESSION_ID: '', CLAUDE_CODE_SESSION_ID: '', CODEX_SESSION_ID: '',
           CODEX_HOME: home, CLAUDE_CONFIG_DIR: tmp('claude-empty-') },
  });
  assert.equal(res.status, 0, res.stderr);
  const out = res.stdout;
  assert.match(out, /SILENT — activity the event log did not record/);
  assert.match(out, /codex {2}01a107bc {2}transcript written .* · 0 events logged/);
  assert.match(out, /Codex hooks untrusted: hooks\/codex-hooks\.json \(0\.8\.1\) has no trust record \(trust is recorded for hooks\/hooks\.json\)/);
  assert.match(out, /\/hooks in the Codex CLI/);
  assert.match(out, /UNCLAIMED — tracked files changed in the window that no logged session edited/);
  assert.match(out, /src\/app\.js {3}changed .* · mentioned by codex 01a107bc \(no events logged\) \(2×/);
  assert.doesNotMatch(out, /src\/logged\.js {3}changed/, 'a logged edit claims its file');
});
