/**
 * tests/unit/hook-rows-golden.test.js
 *
 * The two hot hooks — log-tool-use.sh (every Bash/Edit call) and
 * log-session-milestones.sh (every turn) — were rewritten on 2026-10-07 to
 * extract their fields with one jq call, read the command's text in one awk
 * pass, and build each row pair with one jq, after a fork census put a plain
 * `npm test` at 64 processes and ~230 ms (19 jq, 12 awk, 8 head, 5 tr, 5 grep)
 * and the per-turn Claude Stop no-op at 24 processes. Afterwards: 7 and 2.
 *
 * The contract of that rewrite is that the rows do not change. This test holds
 * it: tests/fixtures/hook-rows/expected.txt is what the hooks AS THEY STOOD
 * BEFORE the rewrite (commit 2c7d469) wrote for the fixture payloads in
 * tests/fixtures/hook-rows/run.sh — a plain command, noise, heredoc and
 * sed/tee/open() writes, Edit/Write/apply_patch, commits read from the
 * reflog and from HEAD, a push, a failed call, and every lifecycle event —
 * with only ids, timestamps, shas and the temp workspace path masked.
 *
 * It asserts composition, not just presence (docs/TESTING.md): the fixture
 * set must still produce the rows the old hooks produced, row for row and
 * byte for byte, and the rows that must NOT appear (noise, a noisy path, a
 * failed call, a Claude Stop, a skipped agent type, a dead session end) are
 * absent because the capture has no row for them.
 *
 * Needs bash, jq, git and awk, like the hooks. Run with:
 *   node --test tests/unit/hook-rows-golden.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOKS = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks');
const RUNNER = path.join(ROOT, 'tests', 'fixtures', 'hook-rows', 'run.sh');
const EXPECTED = path.join(ROOT, 'tests', 'fixtures', 'hook-rows', 'expected.txt');

test('the hooks write the rows the pre-rewrite hooks wrote, byte for byte', () => {
    // The runner pins its own HOME, git identity, session variables and index
    // URLs, and hands the hooks a no-op index-event.sh beside the real
    // diff-shape.sh from this checkout.
    const run = spawnSync('bash', [RUNNER, HOOKS, ROOT], { encoding: 'utf8', timeout: 120000 });
    assert.equal(run.status, 0, `runner failed:\n${run.stderr}`);
    assert.equal(run.stderr, '', `the hooks must stay silent on stderr:\n${run.stderr}`);

    const expected = fs.readFileSync(EXPECTED, 'utf8');
    const got = run.stdout;
    const expectedRows = expected.split('\n').filter(l => l.startsWith('{'));
    const gotRows = got.split('\n').filter(l => l.startsWith('{'));
    assert.ok(expectedRows.length >= 60, `the capture holds ${expectedRows.length} rows; the fixture set has shrunk`);
    // Row by row first, so a failure names the row rather than a 60-line diff.
    for (let i = 0; i < Math.min(expectedRows.length, gotRows.length); i++) {
        assert.equal(gotRows[i], expectedRows[i], `row ${i + 1} differs`);
    }
    assert.equal(gotRows.length, expectedRows.length, 'row count differs');
    assert.equal(got, expected, 'the full capture (headers included) differs');
});

test('every row kind the hooks can write is in the capture', () => {
    const expected = fs.readFileSync(EXPECTED, 'utf8');
    const rows = expected.split('\n').filter(l => l.startsWith('{')).map(JSON.parse);
    const types = new Set(rows.map(r => r.type).filter(Boolean));
    for (const t of ['tool_bash', 'tool_file_edit', 'git_commit', 'git_push',
                     'milestone_turn_stop', 'milestone_compaction_auto', 'milestone_compaction_manual',
                     'milestone_agent_Explore', 'milestone_agent_Plan',
                     'milestone_session_end_prompt_input_exit', 'milestone_session_end_other']) {
        assert.ok(types.has(t), `no ${t} row in the capture`);
    }
    const tools = new Set(rows.map(r => r.tool).filter(Boolean));
    for (const t of ['Bash', 'Edit', 'Write', 'apply_patch']) assert.ok(tools.has(t), `no ${t} row`);
    const providers = new Set(rows.map(r => r.provider));
    assert.deepEqual([...providers].sort(), ['claude', 'codex']);
    // The reflog path (commit_action set) and the HEAD path (none) both appear.
    assert.ok(rows.some(r => r.type === 'git_commit' && r.commit_action === 'commit'), 'no reflog-read commit');
    assert.ok(rows.some(r => r.type === 'git_commit' && r.commit_action === undefined), 'no HEAD-read commit');
    // Byte cuts inside a multibyte character survive as U+FFFD, as head -c left them.
    assert.ok(rows.some(r => typeof r.summary === 'string' && r.summary.includes('�')), 'no mid-character cut');
});
