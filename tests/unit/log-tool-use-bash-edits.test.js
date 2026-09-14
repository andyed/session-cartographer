/**
 * tests/unit/log-tool-use-bash-edits.test.js
 *
 * Under auto mode the harness prefers Bash over Edit/Write, so most real edits
 * arrive as `cd <repo> && python3 - <<PY …`, `sed -i`, or `cat > f <<EOF`.
 *
 * The hook's noise filter used to match the FIRST TOKEN of a compound command:
 *
 *     case "$COMMAND" in
 *       ls*|cat\ *|…|cd\ *|…) exit 0 ;;
 *     esac
 *
 * so `cd <repo> && <anything>` was read as "a cd" and dropped outright, and
 * `cat > src/f.js <<EOF` was read as "a cat". Measured on session 7c9b94b3:
 * ~1,050 lines changed across 11 files, of which the log captured 4 file edits —
 * all four of them Write-tool calls. Every bash-driven edit vanished, and
 * session-digest's `files` panel reported that fraction as the whole session.
 *
 * The assertions below are the ones the original bug would have failed.
 *
 * Run with: node --test tests/unit/log-tool-use-bash-edits.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HOOK = path.join(ROOT, 'plugins', 'session-cartographer', 'hooks', 'log-tool-use.sh');

function makeWorkspace() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-hook-'));
    const repo = path.join(dir, 'repo');
    const dev = path.join(dir, 'dev');
    fs.mkdirSync(repo, { recursive: true });
    fs.mkdirSync(dev, { recursive: true });
    spawnSync('git', ['init', '-q', '.'], { cwd: repo });
    return { dir, repo, dev };
}

/** Fire the hook with a Bash payload; return the changelog records it wrote. */
function fire(ws, command, toolResponse) {
    const payload = {
        tool_name: 'Bash',
        session_id: 'testsess',
        cwd: ws.repo,
        transcript_path: '/tmp/t.jsonl',
        tool_input: { command }
    };
    if (toolResponse) payload.tool_response = { stdout: toolResponse };
    spawnSync('bash', [HOOK], {
        input: JSON.stringify(payload),
        env: { ...process.env, CARTOGRAPHER_LOG_TOOL_USE: 'true', CARTOGRAPHER_DEV_DIR: ws.dev }
    });
    const log = path.join(ws.dev, 'changelog.jsonl');
    if (!fs.existsSync(log)) return [];
    return fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

const last = recs => recs[recs.length - 1];

test('bash edits behind a `cd <repo> &&` hop are recorded as file edits', () => {
    const ws = makeWorkspace();
    try {
        const recs = fire(ws, `cd ${ws.repo} && python3 - <<'PY'\nopen('src/app.js','w').write('x')\nPY`);
        assert.equal(recs.length, 1, 'the dominant auto-mode edit shape must not be dropped');
        assert.equal(last(recs).type, 'tool_file_edit');
        assert.match(last(recs).summary, /src\/app\.js/);
        // Same weight as an Edit/Write call — which tool changed the file is an
        // implementation detail; downstream only asks what changed.
        assert.equal(last(recs).salience, 0.4);
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('`sed -i` and heredoc `cat >` writes are recorded with their target path', () => {
    const ws = makeWorkspace();
    try {
        let recs = fire(ws, `cd ${ws.repo} && sed -i '' 's/a/b/' src/main.js`);
        assert.equal(last(recs).type, 'tool_file_edit');
        assert.match(last(recs).summary, /src\/main\.js/);

        // Both a real edit AND a `cat ` — so write-detection has to outrank the
        // noise filter, not run after it.
        recs = fire(ws, `cat > src/config.js <<'EOF'\nbody\nEOF`);
        assert.equal(last(recs).type, 'tool_file_edit');
        assert.match(last(recs).summary, /src\/config\.js/);
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('python heredocs are detected whether the path is a literal or a variable', () => {
    const ws = makeWorkspace();
    try {
        // The literal form.
        let recs = fire(ws, `cd ${ws.repo} && python3 - <<'PY'\nopen('src/app.js','w').write('x')\nPY`);
        assert.equal(last(recs).type, 'tool_file_edit');
        assert.match(last(recs).summary, /src\/app\.js/);

        // The idiomatic form binds the path first — a literal-only regex misses
        // exactly the shape that is most common in practice, which is how the
        // first cut of this fix still logged a real CHANGELOG.md edit as bash.
        recs = fire(ws, `cd ${ws.repo} && python3 - <<'PY'\np='CHANGELOG.md'\ns=open(p).read()\nopen(p,'w').write(s)\nPY`);
        assert.equal(last(recs).type, 'tool_file_edit');
        assert.match(last(recs).summary, /CHANGELOG\.md/);
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a variable-bound write is still found when the content carries a fake `>` or a `2>/dev/null`', () => {
    const ws = makeWorkspace();
    try {
        // Session 24b90edb, 2026-09-13: `p='/Users/andyed/CLAUDE.md' … open(p,'w')`
        // logged as `Ran:` twice while the same shape logged as `Modified:` once.
        // The variable-bound fallback was gated on the RAW harvest being empty,
        // and two incidental things made it non-empty before the filter ran:
        //
        //   1. a `<project>` placeholder inside the quoted content — the redirect
        //      harvester reads `>` + the following backtick as a write target;
        //   2. a `2>/dev/null` elsewhere in the compound command, which
        //      harvests `/dev/null`.
        //
        // Both were then correctly filtered out, leaving nothing, so a real edit
        // logged as a plain command.
        let recs = fire(ws, [
            `cd ${ws.repo} && grep -n 'marker' CLAUDE.md && python3 - <<'EOF'`,
            `import re,io`,
            `p='/Users/andyed/CLAUDE.md'`,
            `s=open(p).read()`,
            'old="- `/focus <project>` to orient. `/remember <query>` to recover history.\\n"',
            'new=old+"""- **Memory web UI:** http://127.0.0.1:2527/memory — open it with `open "http://127.0.0.1:2527/memory"`.',
            '"""',
            `assert old in s`,
            `open(p,'w').write(s.replace(old,new,1))`,
            `EOF`,
            `sed -n '/Notes/,/FrakBot/p' CLAUDE.md`
        ].join('\n'));
        assert.equal(last(recs).type, 'tool_file_edit', 'a `<placeholder>` in the content hid the write');
        assert.match(last(recs).summary, /\/Users\/andyed\/CLAUDE\.md/);
        // The URL in the content is quoted and slashed, but it is not a file.
        assert.doesNotMatch(last(recs).summary, /http:/);

        recs = fire(ws, [
            `cd ${ws.repo} && python3 - <<'PYEOF'`,
            `p='CHANGELOG.md'`,
            `s=open(p).read()`,
            `open(p,'w').write(s.replace('a','b',1))`,
            `PYEOF`,
            `grep -c "marker" some/dir/hook.sh 2>/dev/null | head -3`
        ].join('\n'));
        assert.equal(last(recs).type, 'tool_file_edit', 'a `2>/dev/null` after the heredoc hid the write');
        assert.match(last(recs).summary, /CHANGELOG\.md/);
        assert.doesNotMatch(last(recs).summary, /dev\/null/);

        // A real explicit target still suppresses the content harvest: the test
        // file being written names src/app.js inside a python string, and only
        // the redirect target must be reported.
        recs = fire(ws, `cat > tests/t.test.js <<'EOF'\nconst cmd = "p='src/app.js'\\nopen(p,'w')";\nEOF`);
        assert.equal(last(recs).type, 'tool_file_edit');
        assert.match(last(recs).summary, /tests\/t\.test\.js/);
        assert.doesNotMatch(last(recs).summary, /src\/app\.js/);
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a read-only heredoc is not called a write, and regexes are not harvested as paths', () => {
    const ws = makeWorkspace();
    try {
        // No write mode → the path-harvesting branch must not run at all.
        let recs = fire(ws, `cd ${ws.repo} && python3 - <<'PY'\nprint(open('README.md').read())\nPY`);
        assert.equal(last(recs).type, 'tool_bash');

        // `'[a-z]+\.[a-z]+'` is dotted and quoted but is a pattern, not a file.
        recs = fire(ws, `cd ${ws.repo} && grep -oE '[a-z]+\\.[a-z]+' notes.txt`);
        assert.equal(last(recs).type, 'tool_bash');
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('a long heredoc is detected — the command is truncated for the summary only', () => {
    const ws = makeWorkspace();
    try {
        // The write sits well past the 500-char summary cap. Detecting against the
        // truncated copy missed precisely the LARGEST edits: a big CHANGELOG.md
        // rewrite logged as tool_bash while a two-line one was caught.
        const filler = '# padding padding padding padding padding padding\n'.repeat(40);
        const cmd = `cd ${ws.repo} && python3 - <<'PY'\np='CHANGELOG.md'\n${filler}open(p,'w').write('x')\nPY`;
        assert.ok(cmd.length > 1500, 'fixture must exceed the truncation window');
        const recs = fire(ws, cmd);
        assert.equal(last(recs).type, 'tool_file_edit');
        assert.match(last(recs).summary, /CHANGELOG\.md/);
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('genuine noise is still skipped, including behind a cd hop', () => {
    const ws = makeWorkspace();
    try {
        for (const cmd of ['ls -la', 'head -50 file.txt', 'cat package.json', `cd ${ws.repo}`, `cd ${ws.repo} && ls -la`]) {
            assert.equal(fire(ws, cmd).length, 0, `expected no event for: ${cmd}`);
        }
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('reads and redirections that are not edits are not mistaken for writes', () => {
    const ws = makeWorkspace();
    try {
        // 2>&1 is an fd dup, /dev/null is a device, /tmp is scratch — none are work.
        for (const cmd of ['npm test 2>&1 | tail -5', 'node build.js > /dev/null', 'grep -rn foo src/ > /tmp/out.txt']) {
            const recs = fire(ws, cmd);
            if (recs.length) assert.equal(last(recs).type, 'tool_bash', `misread as a write: ${cmd}`);
        }
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('the `ls*` glob no longer swallows lsof/lsblk', () => {
    const ws = makeWorkspace();
    try {
        const recs = fire(ws, 'lsof -i :8090');
        assert.equal(recs.length, 1, 'lsof matched the unanchored `ls*` noise glob and was dropped');
        assert.equal(last(recs).type, 'tool_bash');
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});

test('git commit classification is unchanged', () => {
    const ws = makeWorkspace();
    try {
        fs.writeFileSync(path.join(ws.repo, 'f.js'), 'x');
        spawnSync('git', ['add', '-A'], { cwd: ws.repo });
        const out = spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'fix: a real fix'],
            { cwd: ws.repo, encoding: 'utf8' }).stdout;
        const recs = fire(ws, `cd ${ws.repo} && git commit -m 'fix: a real fix'`, out);
        assert.equal(last(recs).type, 'git_commit');
        assert.equal(last(recs).commit_type, 'fix');
        assert.equal(last(recs).salience, 0.7);
    } finally { fs.rmSync(ws.dir, { recursive: true, force: true }); }
});
