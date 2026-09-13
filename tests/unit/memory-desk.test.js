import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDesk, filterMemoryByQuery, sessionWorkState, resumeCommand } from '../../explorer/src/components/memory-desk.js';
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


test('global search preserves exact matching identities and facts across titles, projects, notes and files', () => {
  const data = { start:0, end:at, groups:['project','other'], total:3, unattributed:2,
    sessions:[session('a',[[at,'edit']],[{t:at,text:'Brush provenance'}]), session('b',[[at,'edit']]), {...session('future',[[at+1,'edit']]),group:'other'}],
    files:{a:[{path:'/project/plan.md',edits:[{t:at}]}],b:[{path:'/project/later.md',edits:[{t:at+1}]}]},
  };
  const original = structuredClone(data);
  for (const [query, expected] of [[' A ',['a']], ['PROJECT',['a','b']], ['provenance',['a']], ['plan.md',['a']], ['later.md',[]], ['future',[]], ['missing',[]]]) {
    const projected = filterMemoryByQuery(data,{query});
    assert.deepEqual(projected.sessions.map(s=>s.id), expected, query);
    assert.deepEqual(projected.sessions.map(s=>s.id).sort(), projectDesk(data,{query}).all.map(row=>row.session.id).sort(), 'desk and chart membership diverged');
    assert.deepEqual(Object.keys(projected.files),expected,'unmatched artifact owners leaked');
    assert.deepEqual(projected.groups,expected.length?['project']:[]);
    assert.equal(projected.total,expected.length);
    for (const s of projected.sessions) assert.equal(s,data.sessions.find(source=>source.id===s.id),'source facts were rewritten');
  }
  assert.equal(filterMemoryByQuery(data,{query:'  '}),data,'clearing search must restore original snapshot');
  assert.deepEqual(data,original,'search mutated source data');
  assert.deepEqual(filterMemoryByQuery(data,{query:'later.md',at:at+1}).sessions.map(s=>s.id),['b'],'later replay frame failed to reveal newly recorded file evidence');
});

test('artifacts group by path across threads, documents first, with the query narrowing files and not just threads', () => {
  const plan = path => ({ path, name: path.split('/').at(-1), edits: [{ t: at - 5000 }, { t: at - 1000 }] });
  const rows = [
    { ...session('a', [[at, 'edit']]), title: 'Write the plan' },
    { ...session('b', [[at - 2000, 'edit']]), title: 'Fix the parser' },
    { ...session('c', [[at - 3000, 'edit']], [{ t: at - 3000, text: 'Provenance sweep' }]), title: 'Sweep' },
  ];
  const data = { start: 0, end: at, sessions: rows, files: {
    a: [{ path: '/p/TODO.md', name: 'TODO.md', edits: [{ t: at - 100 }] }, { path: '/p/src/app.js', name: 'app.js', edits: [{ t: at - 50 }] }],
    b: [{ path: '/p/TODO.md', name: 'TODO.md', edits: [{ t: at - 2000 }] }, { path: '/p/src/parser.js', name: 'parser.js', edits: [{ t: at - 2000 }] }],
    c: [{ path: '/p/README.md', name: 'README.md', edits: [{ t: at - 3000 }] }, plan('/p/src/app.js')],
  } };
  const all = projectDesk(data, {}).artifacts;
  assert.deepEqual(all.map(g => g.path), ['/p/TODO.md', '/p/README.md', '/p/src/app.js', '/p/src/parser.js'], 'documents lead, then latest edit');
  const todo = all[0];
  assert.deepEqual(todo.threads.map(t => t.session.id), ['a', 'b'], 'newest thread first');
  assert.equal(todo.last, at - 100);
  assert.equal(todo.isDoc, true);
  assert.equal(all[2].threads.length, 2, 'app.js is shared by a and c');
  assert.deepEqual(all[2].threads.map(t => t.last), [at - 50, at - 1000], 'a file edit after the replay frame never counts');
  assert.deepEqual(projectDesk(data, { at: at - 1500 }).artifacts.map(g => `${g.path}:${g.threads.length}`), ['/p/TODO.md:1', '/p/README.md:1', '/p/src/parser.js:1', '/p/src/app.js:1'], 'replay frames exclude later threads and re-rank by the edits that remain');
  assert.deepEqual(projectDesk(data, { kind: 'md' }).artifacts.map(g => g.path), ['/p/TODO.md', '/p/README.md']);
  assert.deepEqual(projectDesk(data, { query: '.md' }).artifacts.map(g => g.path), ['/p/TODO.md', '/p/README.md'], 'a path query drops the non-matching files of matching threads');
  assert.deepEqual(projectDesk(data, { query: 'provenance' }).artifacts.map(g => g.path), ['/p/README.md', '/p/src/app.js'], 'a note query keeps every file of the matching thread');
  assert.deepEqual(projectDesk(data, { query: 'parser' }).artifacts.map(g => `${g.path}:${g.threads.map(t => t.session.id)}`), ['/p/src/parser.js:b'], 'a title and path match on the same thread still narrows to the path');
  const changed = projectDesk(data, { filter: 'changed', since: at - 2500 }).artifacts;
  assert.deepEqual(changed.map(g => `${g.path}:${g.threads.map(t => t.session.id)}`), ['/p/TODO.md:a,b', '/p/src/app.js:a', '/p/src/parser.js:b'], 'work filters scope the trail before grouping, so a quiet thread drops out of a shared file');
});
