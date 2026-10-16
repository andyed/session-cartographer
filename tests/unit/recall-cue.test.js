/**
 * tests/unit/recall-cue.test.js
 *
 * recallCue() decides when surface-recall-on-prompt.sh runs a search on the
 * user's behalf, so a false positive costs ~600 characters of context the agent
 * did not ask for, and a false negative leaves the status quo (the agent did not
 * recall after 68 of 72 measured cues). The positives below are real prompts from
 * 30 days of Claude and Codex transcripts (2026-09-15 to 2026-10-15) plus the
 * seed phrasings; the near-misses are the in-session questions and agent-runtime
 * messages that the first pass of these patterns fired on.
 *
 * Run with: node --test tests/unit/recall-cue.test.js
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RECALL_CUE_MAX_CHARS,
  classifyPromptIntent,
  isRecallCuePrompt,
  recallCue,
  recallQuery,
} from '../../scripts/classify-prompt-intent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CLI = path.join(ROOT, 'scripts', 'classify-prompt-intent.js');

const POSITIVES = [
  // Seed phrasings from the 2026-10-15 measurement.
  ['thought we fixed the wheel jank?', 'thought-we'],
  ['I thought we had a helper for this', 'thought-we'],
  ['we already have a parser for this, right?', 'we-already'],
  ["we've already tried bumping the timeout", 'we-already'],
  ['did we implement the export button?', 'did-we'],
  ['what did we decide about the cache key?', 'what-decided'],
  ['last time the build broke like this it was the cert', 'last-time'],
  ['this came up in a previous session', 'previous-session'],
  ["let's pick up where we left off on the parser", 'left-off'],
  ['I think we made a helper for the toast queue', 'i-think-we'],
  ["didn't we fix the toolbar overlap?", 'didnt-we'],
  ['not sure where we tried that (which agent)', 'which-agent'],
  // Real prompts, verbatim or lightly trimmed.
  ['eval rejected count went up? i thought we determined cursor wasn\'t good at predicting that?', 'thought-we'],
  ['Oh, did we ship seasonal colors to Apple TV? That’d be a hit', 'did-we'],
  ['ok, lets wrap lalal -- does the setting still enable nodes to go offscreen? or did we kill the impetus?', 'did-we'],
  ['dont we have one with the pattern inside the logo?', 'do-we-have'],
  ['do we have a TF build with nodePair?', 'do-we-have'],
  ['still not seeing a face mesh in mas app -- we tried to fix that last nite?', 'temporal'],
  ['revert to a working build, we had this', 'we-tried'],
  ['maybe when we added cmd-l. seems like it leaves the mid sized now playing open sometimes?', 'where-we-tried'],
  ['head rotation doesn\'t produce the head icon rotation it did previously', 'previously'],
  ["let's add the figures we created yesterday", 'temporal'],
  ['Squabble hollow was the phrase I was trying to recall', 'remember-when'],
  ['we already ahve hicks law etc ?', 'we-already'],
  ['i thought it was fixed in the tvos build', 'thought-we'],
  ['the pie menu is broken again', 'again'],
  ['this used to work before the refactor', 'used-to-work'],
];

const NEAR_MISSES = [
  // In-session questions about what the agent just did.
  'what did you change with wheel',
  'did you run the tests?',
  'did we just break the build?',
  'what did we decide above about naming?',
  "why didn't we get an error there?",
  'why the hell didn\'t we do this hours ago',
  'we have a pie menu for gyro in reactivity',
  'i thought it showed LAN when i connected',
  // "other/another" names a session running right now, which is /standup's job.
  'lets let the other session do the sidecar',
  'sorry, android was for other agent, please continue',
  // Agent-runtime messages that arrive as prompts.
  'The app was quit while you were working. Please continue from where you left off.',
  'This session is being continued from a previous conversation that ran out of context.',
  '<task-notification> did we fix the wheel? </task-notification>',
  'The following is the Codex agent history added since your last approval assessment. Earlier...',
  // Recall already requested explicitly.
  'Can we do a geiss like view? /remember geiss',
  // Instructions, not questions about the past.
  'remember to run the tests before committing',
  'please remember that we use polars here',
  'try again',
  'for the last time, stop adding emoji',
  '',
];

test('each seed and measured cue fires, under the expected name', () => {
  for (const [prompt, name] of POSITIVES) {
    const cue = recallCue(prompt);
    assert.ok(cue, `expected a cue in: ${prompt}`);
    assert.equal(cue.cue, name, `wrong cue for: ${prompt}`);
    assert.equal(isRecallCuePrompt(prompt), true);
  }
});

test('in-session questions, runtime messages, and explicit recall do not fire', () => {
  for (const prompt of NEAR_MISSES) {
    assert.equal(recallCue(prompt), null, `should not fire: ${prompt}`);
  }
});

test('an in-session marker vetoes a weak cue but not a strong one', () => {
  // The guard on the guard: without the marker both fire.
  assert.equal(recallCue("didn't we fix the toolbar overlap?")?.cue, 'didnt-we');
  assert.equal(recallCue("didn't we just fix the toolbar overlap?"), null);
  assert.equal(recallCue('last time we fixed this above, it was the cert')?.cue, 'last-time');
});

test('a pasted brief past the length cap is not a cue, however many cue phrases it quotes', () => {
  const head = 'did we ship the parser? ';
  assert.ok(recallCue(head), 'the opening alone is a cue');
  const brief = head + 'context '.repeat(Math.ceil(RECALL_CUE_MAX_CHARS / 8));
  assert.ok(brief.length > RECALL_CUE_MAX_CHARS);
  assert.equal(recallCue(brief), null);
});

test('recallQuery drops the cue span and counts the topic that is left', () => {
  const prompt = "didn't we fix the wheel scroll jank already?";
  const { query, topic } = recallQuery(prompt, recallCue(prompt));
  assert.equal(query, 'fix the wheel scroll jank already?');
  assert.equal(topic, 3, 'wheel, scroll, jank');

  // Nothing to search for once the cue is gone: the hook abstains on topic 0.
  const bare = "didn't we fix this already?";
  assert.equal(recallQuery(bare, recallCue(bare)).topic, 0);
  const thought = 'thought we fixed this?';
  assert.equal(recallQuery(thought, recallCue(thought)).topic, 0);
});

test('recallQuery caps the query at a word boundary', () => {
  const prompt = `did we ship ${'parser '.repeat(80)}`;
  const { query } = recallQuery(prompt, recallCue(prompt), 60);
  assert.ok(query.length <= 60, query);
  assert.match(query, /parser$/);
});

test('the cue detector leaves intent classification unchanged', () => {
  assert.equal(classifyPromptIntent('fix the failing tests').key, 'testing-verification');
  assert.equal(classifyPromptIntent('yes').key, 'plan-approvals');
  assert.equal(classifyPromptIntent('did we ship the export button?').key, 'deploy-release');
});

function cli(input) {
  return spawnSync('node', [CLI, '--recall-cue'], { input, encoding: 'utf8' });
}

test('--recall-cue reads stdin and prints cue, strength, topic and query on one line', () => {
  const hit = cli("didn't we fix the wheel scroll jank already?\n");
  assert.equal(hit.status, 0, hit.stderr);
  assert.equal(hit.stdout, 'didnt-we\tweak\t3\tfix the wheel scroll jank already?\n');

  // A multi-line prompt still yields a single line: the hook splits on tabs.
  const multi = cli('last time\nwe hit the cert\terror on deploy');
  assert.equal(multi.stdout.split('\n').filter(Boolean).length, 1);
  assert.equal(multi.stdout.split('\t').length, 4);
});

test('--recall-cue prints nothing and exits 0 when there is no cue', () => {
  const miss = cli('rename the wheel handler to onWheel');
  assert.equal(miss.status, 0, miss.stderr);
  assert.equal(miss.stdout, '');
});

test('the intent CLI is unchanged', () => {
  const res = spawnSync('node', [CLI, 'fix the failing tests'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, 'testing-verification\tTesting/verification\n');
});
