// One definition of "is this the corpus owner's work."
//
// backfill-git-history.sh imported every commit in every repository it walked,
// so backfilling one cloned repo wrote strangers' commits into the corpus as
// the owner's own session memory. Measured on this machine: a 9-author clone
// contributed 200 commits unfiltered and 0 once the owner filter applied.
//
// Two consumers had each grown a private fix — build-profile.js and
// trust-digest.js carried byte-identical copies of the rule, the second
// annotated "same definitions build-profile.js uses". Everything else
// inherited nothing, so search, the facts census and tempo, the pulse's commit
// list and the Explorer all counted other people's commits as the owner's
// activity. That matters more now that counts are presented as fact: a ranked
// result gets eyeballed, a census reads as authoritative.

import test from 'node:test';
import assert from 'node:assert/strict';

for (const name of [
  'CARTOGRAPHER_SESSION_ID',
  'CLAUDE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CODEX_SESSION_ID',
]) delete process.env[name];

const { ownerNames, isOwnEvent } = await import('../../scripts/ownership.js');

const OWNERS = ownerNames({ CARTOGRAPHER_PROFILE_AUTHORS: 'Ada Lovelace' });

test('the owner list honours the override and always admits agent authorship', () => {
  assert.ok(OWNERS.has('Ada Lovelace'));
  // Agent-authored commits made inside the owner's sessions are what the owner
  // shipped, so they are the owner's work whatever the commit author says.
  assert.ok(OWNERS.has('Claude'));
  assert.ok(OWNERS.has('claude'));
  assert.ok(!OWNERS.has('Grace Hopper'));
});

test('a comma-separated override admits every name in it', () => {
  const many = ownerNames({ CARTOGRAPHER_PROFILE_AUTHORS: 'Ada Lovelace, Grace Hopper' });
  assert.ok(many.has('Ada Lovelace'));
  assert.ok(many.has('Grace Hopper'));
});

test("a stranger's commit is not the owner's work", () => {
  assert.equal(
    isOwnEvent({ type: 'git_commit', author: 'Grace Hopper' }, OWNERS), false,
    'this is the row that made a cloned repo look like your own activity',
  );
});

test("the owner's own commit is kept", () => {
  assert.equal(isOwnEvent({ type: 'git_commit', author: 'Ada Lovelace' }, OWNERS), true);
});

test('a commit made inside one of the owner\'s sessions is theirs whatever the author says', () => {
  // The rule is deliberately loose in this direction: an agent commit carrying
  // someone else's configured name, made in the owner's session, is still work
  // the owner shipped.
  assert.equal(
    isOwnEvent({ type: 'git_commit', author: 'Grace Hopper', session_id: 'sess-1' }, OWNERS),
    true,
  );
});

test('only git_commit rows are filtered', () => {
  // Everything else in the corpus came from the owner's own agent sessions by
  // construction, and most of it carries no author at all — testing those
  // against an author list would drop them.
  for (const type of ['tool_bash', 'research_fetch', 'milestone_turn_stop', undefined]) {
    assert.equal(
      isOwnEvent({ type, author: 'Grace Hopper' }, OWNERS), true,
      `${String(type)} must not be filtered by commit authorship`,
    );
  }
});

test('an absent author is not silently treated as the owner', () => {
  assert.equal(isOwnEvent({ type: 'git_commit' }, OWNERS), false);
  assert.equal(isOwnEvent({ type: 'git_commit', author: '' }, OWNERS), false);
});
