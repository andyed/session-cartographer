const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function git(corpus, args, timestamp) {
  const iso = new Date(timestamp).toISOString();
  execFileSync('git', ['-C', corpus, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
  });
}

function createFocusWorkspaceFixture(work) {
  const corpus = path.join(work, 'corpus');
  fs.mkdirSync(corpus, { recursive: true });
  // Keep the whole fixed fixture inside the live server's 24-hour source
  // window while making every relationship and millisecond edge deterministic.
  const through = Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR;
  const from = through - HOUR;
  const at = offset => new Date(from + offset).toISOString();
  const shared = path.join(corpus, 'shared-brief.md');
  const unavailable = path.join(corpus, 'unavailable-diff.txt');
  const missing = path.join(corpus, 'missing-recorded-file.txt');
  fs.writeFileSync(shared, '# Shared brief\n\nInitial state.\n');
  execFileSync('git', ['-C', corpus, 'init'], { stdio: 'ignore' });
  git(corpus, ['add', 'shared-brief.md'], from - 2 * MINUTE);
  git(corpus, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Initial shared brief'], from - 2 * MINUTE);

  fs.writeFileSync(shared, '# Shared brief\n\nAlpha added the bounded decision.\n');
  git(corpus, ['add', 'shared-brief.md'], from + 10 * MINUTE);
  git(corpus, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Alpha updates shared brief'], from + 10 * MINUTE);
  fs.writeFileSync(shared, '# Shared brief\n\nAlpha added the bounded decision.\n\nBeta added provenance.\n');
  git(corpus, ['add', 'shared-brief.md'], from + 35 * MINUTE);
  git(corpus, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Beta adds provenance'], from + 35 * MINUTE);
  // Existing workspace content with no commit in the task's bounds exercises
  // the explicit unavailable-diff → current-file path.
  fs.writeFileSync(unavailable, 'Current workspace state only.\n');

  const events = [];
  function event(id, offset, overrides = {}) {
    events.push({
      event_id: id,
      session_id: 'alpha-task',
      session_title: 'Alpha focus boundary task',
      project: 'alpha',
      provider: 'codex',
      timestamp: at(offset),
      type: 'tool_bash',
      summary: `Recorded fixture evidence ${id}`,
      cwd: corpus,
      ...overrides,
    });
  }
  event('alpha-before', -1, { summary: 'Alpha task began before focus' });
  event('alpha-left-edge', 0, { summary: 'Alpha exact left boundary' });
  event('alpha-hidden-match', 1000, { summary: 'buried-needle historical decision' });
  event('alpha-shared-edit', 10 * MINUTE, { type: 'tool_file_edit', file_path: shared, summary: `Modified: ${shared}` });
  event('alpha-commit', 11 * MINUTE, { type: 'git_commit', summary: 'Commit a1pha: bounded decision recorded' });
  for (let index = 0; index < 70; index++) event(`alpha-later-${index}`, 12 * MINUTE + index * 1000, { summary: `Later alpha observation ${index}` });
  event('alpha-right-edge', HOUR, { summary: 'Alpha exact right boundary' });
  event('alpha-after', HOUR + 1, { summary: 'Alpha task continued after focus' });

  event('beta-shared-edit', 30 * MINUTE, {
    session_id: 'beta-task', session_title: 'Beta shared file task', provider: 'claude',
    type: 'tool_file_edit', file_path: shared, summary: `Modified: ${shared}`,
  });
  event('beta-commit', 36 * MINUTE, {
    session_id: 'beta-task', session_title: 'Beta shared file task', provider: 'claude',
    type: 'git_commit', summary: 'Commit b3ta: shared provenance recorded',
  });
  event('solo-event', 15 * MINUTE, {
    session_id: 'solo-task', session_title: 'One recorded observation',
    summary: 'The only observation for this task',
  });
  event('anonymous-legacy-event', 16 * MINUTE, {
    session_id: undefined, session_title: undefined,
    summary: 'Anonymous legacy observation remains reachable',
  });
  event('key-only-anonymous-a', 17 * MINUTE, {
    event_id: undefined, session_id: undefined, session_title: undefined,
    summary: 'First same-time key-only legacy observation',
  });
  event('key-only-anonymous-b', 17 * MINUTE, {
    event_id: undefined, session_id: undefined, session_title: undefined,
    summary: 'Second same-time key-only legacy observation',
  });
  event('unavailable-edit', 25 * MINUTE, {
    session_id: 'unavailable-task', session_title: 'Unavailable bounded changes',
    type: 'tool_file_edit', file_path: unavailable, summary: `Modified: ${unavailable}`,
  });
  event('missing-edit', 26 * MINUTE, {
    session_id: 'missing-task', session_title: 'Missing recorded file',
    type: 'tool_file_edit', file_path: missing, summary: `Modified: ${missing}`,
  });
  event('mixed-project', 20 * MINUTE, {
    session_id: 'other-project-task', session_title: 'Other project control',
    project: 'beta', provider: 'claude', summary: 'This beta-only task must stay outside alpha scope',
  });

  const log = path.join(corpus, 'changelog.jsonl');
  fs.writeFileSync(log, events.map(row => JSON.stringify(row)).join('\n') + '\n');
  return {
    corpus, log, shared, unavailable, missing, from, through,
    isoFrom: new Date(from).toISOString(), isoThrough: new Date(through).toISOString(),
    append(rows) {
      fs.appendFileSync(log, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    },
    newEvent(id, overrides = {}) {
      return {
        event_id: id,
        session_id: id,
        session_title: id === 'new-alpha-task' ? 'New alpha task in fixed focus' : 'Unrelated beta arrival',
        project: id === 'new-alpha-task' ? 'alpha' : 'beta',
        provider: 'codex',
        timestamp: new Date(through - 5 * MINUTE).toISOString(),
        type: 'milestone_session_end',
        summary: id === 'new-alpha-task' ? 'New alpha wrapup in fixed focus' : 'Unrelated beta wrapup',
        cwd: corpus,
        ...overrides,
      };
    },
  };
}

module.exports = { createFocusWorkspaceFixture };
