import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDesk, sessionWorkState, resumeCommand } from '../../explorer/src/components/memory-desk.js';
const at = 20000000;
const session = (id, events, notes = []) => ({ id, title: id, group: 'project', projects: {project: events.length}, events, notes });
test('recent observations do not turn an explicit handoff into running; newer work reopens it', () => {
  const end = { t: at - 1000, type: 'milestone_session_end', text: 'Stopped' };
  const s = session('ended', [[at - 1000, 'lifecycle']], [end]);
  assert.equal(sessionWorkState(s, at).id, 'settled');
  s.events.push([at, 'edit']);
  assert.equal(sessionWorkState(s, at).id, 'flight');
  assert.equal(sessionWorkState(s, at + 20 * 60000).id, 'quiet');
});
test('catch-up excludes the checkpoint and future replay evidence but keeps recorded outcomes independent of recent notes', () => {
  const one = session('one', [[at-2000,'edit'],[at-1000,'commit'],[at+1,'commit']]);
  one.outcomes = [{ t: at-1000, id: 'commit', type: 'git_commit', text: 'Commit abc' },{ t: at+1, type: 'git_commit', text: 'Future' }];
  const data = { start: at-10000, end: at, sessions: [one, session('quiet', [[at-3000,'edit']])], files: {} };
  const desk = projectDesk(data, { since: at-2000, filter:'changed' });
  assert.deepEqual(desk.sessions.map(row=>row.session.id), ['one']);
  assert.equal(desk.commits, 1);
  assert.equal(desk.outcomes.length, 1);
  assert.equal(desk.outcomes[0].note.id, 'commit');
});
test('artifact search and shared-file attribution use exact paths across sessions', () => {
  const data = { start:0,end:at,sessions:[session('a',[[at,'edit']]),session('b',[[at,'edit']])],files:{a:[{path:'/project/plan.md',edits:[{t:at}]}],b:[{path:'/project/plan.md',edits:[{t:at}]}]} };
  assert.deepEqual(projectDesk(data,{query:'plan.md'}).owners.get('/project/plan.md'), ['a','b']);
  assert.equal(projectDesk(data,{query:'missing'}).sessions.length,0);
});
test('resume commands require a known provider and cannot inject shell input through ids or cwd', () => {
  assert.equal(resumeCommand({id:'abc',provider:'codex'}), 'codex resume abc');
  assert.equal(resumeCommand({id:'abc',provider:'unknown'}), null);
  assert.equal(resumeCommand({id:'$(id)',provider:'codex'}), null);
  assert.equal(resumeCommand({id:'abc',provider:'claude',cwd:"/work/it's fine"}), "cd '/work/it'\\''s fine' && claude --resume abc");
});
