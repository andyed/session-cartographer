#!/usr/bin/env node
/**
 * One definition of "is this the corpus owner's work."
 *
 * `backfill-git-history.sh` walks repositories and imports commits. It had no
 * author filter, so backfilling a cloned repository ingested every
 * contributor's commits as the owner's own session memory. Two consumers
 * noticed and each grew its own fix — `build-profile.js` and `trust-digest.js`
 * carried byte-identical copies of `gitUserName()`, `OWNERS` and `isOwn`, the
 * second annotated "same definitions build-profile.js uses", which is a comment
 * standing where a shared module belongs.
 *
 * Everything else inherited nothing. Search, the facts census and tempo, the
 * pulse's commit list, and the Explorer all counted strangers' commits as the
 * owner's activity. That mattered more once counts began to be presented as
 * fact: a ranked result gets eyeballed, a census reads as authoritative.
 *
 * The rule itself is deliberately loose in one direction. A commit made inside
 * one of the owner's own sessions counts as theirs whatever the commit author
 * says, because agent-authored commits are what the owner shipped. It is strict
 * in the other: a commit with no session and an unrecognised author is somebody
 * else's, and stays out.
 */

import { execFileSync } from 'node:child_process';

/**
 * The owner's git identity. `--global` on purpose: a per-repository
 * `user.name` is frequently an employer identity or a one-off, and the
 * question here is who owns the corpus, not who owns the checkout.
 */
export function gitUserName() {
  try {
    return execFileSync('git', ['config', '--global', 'user.name'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * Names that count as the owner. `CARTOGRAPHER_PROFILE_AUTHORS` is a
 * comma-separated override for anyone whose commits carry more than one name.
 */
export function ownerNames(env = process.env) {
  return new Set(
    (env.CARTOGRAPHER_PROFILE_AUTHORS || gitUserName())
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      // Agent-authored commits made inside the owner's sessions are the owner's
      // work — they are what the owner shipped.
      .concat(['Claude', 'claude']),
  );
}

/**
 * True when an event is the owner's own work.
 *
 * Only `git_commit` rows are filtered. Everything else in the corpus was
 * produced by the owner's own agent sessions by construction, and testing it
 * against an author list would drop rows that carry no author at all.
 */
export function isOwnEvent(event, owners = ownerNames()) {
  if (event.type !== 'git_commit') return true;
  if (event.session_id) return true;
  return owners.has(event.author || '');
}

// `--authors` lets the shell backfill ask for the same list rather than
// re-deriving it. One definition, two languages.
if (process.argv[2] === '--authors') {
  process.stdout.write([...ownerNames()].join('\n') + '\n');
}
