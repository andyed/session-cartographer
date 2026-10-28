#!/usr/bin/env node
/**
 * classify-prompt-intent.js — Rule-based prompt-intent classifier.
 *
 * Ported from crispierry/codex-log-viewer
 * (packages/analytics/src/prompt-intents.ts), then retuned against this user's
 * own transcript corpus. Classifies a single user prompt into one of 17 intent
 * categories via a priority-ordered cascade of regex predicates. Deterministic,
 * English-only, zero dependencies, no LLM call.
 *
 * Local retuning (diverges from the upstream port):
 *   - isNonPromptNoise: tooling/agent/system messages injected as `user` turns
 *     (slash-command wrappers, task notifications, skill preambles, compaction
 *     summaries, memory-observer prompts) route straight to "other".
 *   - Pasted-image markers are stripped during normalization, so screenshots
 *     stop inflating content-creation and image-only turns fall to "other".
 *   - Question detection widened (contractions, trailing "?"); bug-report
 *     phrasings and /plan invocations added; bare "production"/"prod" dropped
 *     from deploy-release to cut false positives.
 *
 * Two-stage normalization: a literal form (lowercased, whitespace-collapsed)
 * and a command form (politeness scaffolding like "can you" / "please"
 * stripped). Predicates match against the literal, the command form, or both
 * concatenated — the original code's intent is preserved verbatim.
 *
 * Used by reconstruct-history.js to tag transcript turns with the human's
 * intent before they are indexed into Qdrant.
 *
 * CLI: node scripts/classify-prompt-intent.js "fix the failing tests"
 */
import { fileURLToPath } from 'url';

export const promptIntentCategories = {
  featureDesign: { key: 'feature-design', label: 'Feature design' },
  implementation: { key: 'implementation', label: 'Implementation' },
  bugFixes: { key: 'bug-fixes', label: 'Bug fixes' },
  gitCommands: { key: 'git-commands', label: 'Git commands' },
  deployRelease: { key: 'deploy-release', label: 'Deploy/release' },
  runBuildApp: { key: 'run-build-app', label: 'Run/build app' },
  codeReviewQa: { key: 'code-review-qa', label: 'Code review/QA' },
  planningStrategy: { key: 'planning-strategy', label: 'Planning/strategy' },
  research: { key: 'research', label: 'Research' },
  documentation: { key: 'documentation', label: 'Documentation' },
  testingVerification: { key: 'testing-verification', label: 'Testing/verification' },
  refactorCleanup: { key: 'refactor-cleanup', label: 'Refactor/cleanup' },
  contentCreation: { key: 'content-creation', label: 'Content creation' },
  dataAnalysis: { key: 'data-analysis', label: 'Data/metrics' },
  feedbackContext: { key: 'feedback-context', label: 'Feedback/context' },
  planApprovals: { key: 'plan-approvals', label: 'Plan approvals' },
  other: { key: 'other', label: 'Other' },
};

export function classifyPromptIntent(message) {
  const literal = normalizeLiteralPrompt(message);
  const command = normalizedCommandText(literal);
  const matchText = command === literal ? command : `${literal} ${command}`;

  if (isNonPromptNoise(literal)) {
    return promptIntentCategories.other;
  }
  if (isPlanApprovalPrompt(literal)) {
    return promptIntentCategories.planApprovals;
  }
  if (isDeployReleasePrompt(command)) {
    return promptIntentCategories.deployRelease;
  }
  if (isGitCommandPrompt(command)) {
    return promptIntentCategories.gitCommands;
  }
  if (isRunBuildAppPrompt(command)) {
    return promptIntentCategories.runBuildApp;
  }
  if (isCodeReviewQaPrompt(command)) {
    return promptIntentCategories.codeReviewQa;
  }
  if (isTestingVerificationPrompt(matchText)) {
    return promptIntentCategories.testingVerification;
  }
  if (isDocumentationPrompt(matchText)) {
    return promptIntentCategories.documentation;
  }
  if (isBugFixPrompt(matchText)) {
    return promptIntentCategories.bugFixes;
  }
  if (isRefactorCleanupPrompt(matchText)) {
    return promptIntentCategories.refactorCleanup;
  }
  if (isPlanningStrategyPrompt(matchText)) {
    return promptIntentCategories.planningStrategy;
  }
  if (isDataAnalysisPrompt(matchText)) {
    return promptIntentCategories.dataAnalysis;
  }
  if (isContentCreationPrompt(matchText)) {
    return promptIntentCategories.contentCreation;
  }
  if (isFeatureDesignPrompt(matchText)) {
    return promptIntentCategories.featureDesign;
  }
  if (isImplementationPrompt(matchText)) {
    return promptIntentCategories.implementation;
  }
  if (isResearchPrompt(matchText)) {
    return promptIntentCategories.research;
  }
  if (isFeedbackContextPrompt(matchText)) {
    return promptIntentCategories.feedbackContext;
  }
  // A prompt that escaped every specific bucket but ends in "?" is an
  // unclassified question — research is a better home than the catch-all.
  if (/\?\s*$/u.test(literal)) {
    return promptIntentCategories.research;
  }
  if (isBroadActionRequestPrompt(matchText)) {
    return promptIntentCategories.implementation;
  }
  return literal ? promptIntentCategories.feedbackContext : promptIntentCategories.other;
}

export function normalizeLiteralPrompt(message) {
  // Drop pasted-image markers ([Image #3], [Image: source: …]) before
  // anything else — they are not prose and otherwise route every screenshot
  // to content-creation. A prompt that was only image markers normalizes to
  // "" and falls through to "other".
  return message
    .replace(/\[image\b[^\]]*\]/giu, ' ')
    .trim()
    .replace(/\s+/gu, ' ')
    .toLowerCase();
}

// Tooling/agent/system content injected into the transcript as `user` turns —
// slash-command wrappers, background-task notifications, skill preambles,
// compaction summaries, memory-observer prompts. None are human prompts, so
// they route straight to "other" rather than polluting a real intent bucket.
export function isNonPromptNoise(literal) {
  if (/^<(task-notification|observed_from_primary_session|command-message|command-name|command-args|local-command-stdout|system-reminder|user-prompt-submit-hook)\b/u.test(literal)) {
    return true;
  }
  if (/^this session is being continued from a previous conversation/u.test(literal)) return true;
  if (/^base directory for this skill:/u.test(literal)) return true;
  if (/^hello,? memory agent/u.test(literal)) return true;
  if (/^you are (a |an )?(claude-?mem|content curator)/u.test(literal)) return true;
  if (/^progress summary checkpoint/u.test(literal)) return true;
  if (/^caveat: the messages below were generated by the user/u.test(literal)) return true;
  return false;
}

function normalizedCommandText(normalized) {
  let value = normalized;
  let changed = true;
  while (changed) {
    const previous = value;
    value = value
      .replace(/^(ok|okay)[, ]+/u, '')
      .replace(/^(please|pls)[, ]+/u, '')
      .replace(/^(can|could|would) you\s+/u, '')
      .replace(/^i would like (you )?to\s+/u, '')
      .replace(/^i want (you )?to\s+/u, '')
      .replace(/^let'?s\s+/u, '');
    changed = value !== previous;
  }
  return value.replace(/\s+(please|for me)$/u, '').trim();
}

function isPlanApprovalPrompt(normalized) {
  if (normalized.length > 80) {
    return false;
  }
  const value = normalized
    .replace(/[.!]+$/u, '')
    .replace(/\s*,\s*/gu, ', ')
    .trim();
  const oneWordApproval = /^(yes|yeah|yep|yup|sure|ok|okay|approved|confirmed|execute)$/u.test(value);
  const shortApproval =
    /^(yes|yeah|yep|yup|sure|ok|okay),? (please|go ahead|proceed|do it|do that|sounds good|let's do it|lets do it)$/u.test(value);
  const phraseApproval =
    /^(sounds good|looks good|that works|works for me|go ahead|go for it|please do|yes please do|do it|do that|proceed|approved|confirmed|ship it|let's do it|lets do it|let's do that|lets do that|execute it|execute that|execute this|execute the plan|execute the changes)( please)?$/u.test(value);
  return oneWordApproval || shortApproval || phraseApproval;
}

function isDeployReleasePrompt(normalized) {
  if (/\brelease notes?\b/u.test(normalized)) {
    return false;
  }
  const directDeploy =
    /^(publish|deploy|release|ship)( (it|this|the app|the build|the release|the site|the website|to (main|origin|github|production|prod|release)|production|prod))?$/u.test(normalized);
  // Bare "production"/"prod" dropped — too noisy in this corpus ("visual
  // production", "production pipeline"). "deploy to production" still matches
  // via the directDeploy verb.
  const releaseWork =
    /\b(deploy|deployment|release|notariz(?:e|ation)|distribution|ship(?:ped|ping)?)\b/u.test(normalized);
  return directDeploy || releaseWork;
}

function isGitCommandPrompt(normalized) {
  const directGitCommand =
    /^(git )?(commit|comet|push|merge|rebase|branch|checkout|switch|pull|fetch|stash|tag|open pr|create pr|close pr|merge pr)\b/u.test(normalized);
  const explicitGitInspection = /^git (status|diff|log)\b/u.test(normalized);
  const gitObjectAction =
    /^(create|make|open|merge|close|delete|remove|clean|switch|checkout) ((a|the|current|new|this) )*(branch|commit|pull request|pr|worktree|work tree)\b/u.test(normalized);
  const worktreeCleanup = /^(close|delete|remove|clean) ((the|current|this) )*(worktree|work tree)\b/u.test(normalized);
  const commitStateQuestion =
    /^are all files\b/u.test(normalized) ||
    /^(are|is|did|do|does|have|has)\b.*\b(all|everything|files?|changes?|work|worktree|work tree|repo|repository|anything|we)\b.*\b(committed|commited|commit|pushed|push|staged|unstaged|uncommitted|dirty|clean|checked in)\b\??$/u.test(normalized) ||
    /^(all|everything|files?|changes?|anything|repo|repository|worktree|work tree)\b.*\b(committed|commited|pushed|staged|unstaged|uncommitted|dirty|clean)\b\??$/u.test(normalized);
  return directGitCommand || explicitGitInspection || gitObjectAction || worktreeCleanup || commitStateQuestion;
}

function isRunBuildAppPrompt(normalized) {
  const appLaunchCommand =
    /^(run|start|restart|launch|open|relaunch|rerun) (the )?(app|application|desktop app|mac app|macos app|native app|packaged app|server|local server|dev server|development server)\b/u.test(normalized);
  const devServerCommand = /^(run|start|restart) (npm run dev|dev|desktop|local app)\b/u.test(normalized);
  const localBuildCommand =
    /\b(rebuild|build|package|packaged|relaunch|restart|run|start)\b.*\b(app|application|server|local|mac app|macos app|native app)\b/u.test(normalized);
  return appLaunchCommand || devServerCommand || localBuildCommand;
}

function isCodeReviewQaPrompt(normalized) {
  const reviewCommand =
    /^(code review|do a code review|run a code review|review code|review the code|review this code|review the diff|review the changes)\b/u.test(normalized);
  const reviewTarget =
    /^(review|inspect|audit) (the )?(code|diff|changes|change set|pull request|pr|implementation)\b/u.test(normalized);
  const priorityFinding = /\b(p0|p1|p2|p3|regression risk|code review|review finding|finding)\b/u.test(normalized);
  return reviewCommand || reviewTarget || priorityFinding;
}

function isTestingVerificationPrompt(normalized) {
  const directTest =
    /^(run|rerun|execute|fix|update)? ?(the )?(tests?|test suite|lint|smoke test|accessibility check|typecheck|verification)\b/u.test(normalized);
  const verificationTerms =
    /\b(test|tests|tested|testing|lint|typecheck|smoke|qa|verify|verification|accessibility|playwright|screenshot check)\b/u.test(normalized);
  return directTest || verificationTerms;
}

function isDocumentationPrompt(normalized) {
  return /\b(docs?|documentation|readme|usage guide|help|worklog|ai worklog|changelog|release notes?|write-up|guide)\b/u.test(normalized);
}

function isBugFixPrompt(normalized) {
  const directFix =
    /^(fix|repair|resolve|debug|address|correct)\b/u.test(normalized);
  const bugTerms =
    /\b(bug|broken|wrong|not working|doesn'?t work|isn'?t working|fix(?:ed|ing)?|fails?|failing|failure|error|crash|regression|issues?|problem|p0|p1|p2|p3)\b/u.test(normalized);
  const screenshotIssue =
    /\b(still seeing|why do we have|why is|what happened|this is wrong|this looks wrong|it is not|this is not|when i click)\b/u.test(normalized);
  // Phrasings common in this corpus that the generic terms above miss.
  const bugPhrasings =
    /\b(went (white|black|blank|gr[ae]y)|horked|borked|is not right|isn'?t right|still (broke|broken|not|grey|gray|white|black|blank|doesn|don'?t|seeing|happening|wrong|off))\b/u.test(normalized);
  return directFix || bugTerms || screenshotIssue || bugPhrasings;
}

function isRefactorCleanupPrompt(normalized) {
  const cleanupTerms =
    /\b(declutter|clean ?up|cleanup|simplify|reorganize|remove|hide|go away|reclaim|less clutter|we don'?t need|you don'?t need|i don'?t want|move .* menu|move .* bottom|rename|refactor|dedupe|consolidate)\b/u.test(normalized);
  return cleanupTerms;
}

function isPlanningStrategyPrompt(normalized) {
  // A /plan slash-command anywhere — "yes, /plan", "ok /plan the blog".
  if (/\/plan\b/u.test(normalized)) return true;
  const directPlan = /^(create a plan|make a plan|plan this|plan it|create an implementation plan)\b/u.test(normalized);
  const decisionTerms =
    /\b(strategy|roadmap|approach|proposal|prioriti[sz]e|trade-?offs?|recommendation|recommend|honest opinion|do we need|we need to|i think we|i don'?t think|i am not sure|i'?m not sure|are we ready|are we all|are you sure|save this plan|should we|should i|what should|what can we|what are the key|best way|figure out the best|take a step back)\b/u.test(normalized);
  return directPlan || decisionTerms;
}

function isDataAnalysisPrompt(normalized) {
  const dataTerms =
    /\b(data|dataset|spreadsheet|csv|table|chart|graph|metrics?|analytics?|report|dashboard|scorecard|calculate|count|breakdown|visuali[sz]e|pie chart|bar chart)\b/u.test(normalized);
  return dataTerms;
}

function isContentCreationPrompt(normalized) {
  const contentTerms =
    /\b(generate|draft|compose|rewrite|copy|headline|tagline|article|blog post|post|email|letter|logo|image|illustration|poster|deck|slides?|presentation|caption|bio|announcement)\b/u.test(normalized);
  return contentTerms;
}

function isFeatureDesignPrompt(normalized) {
  const designTerms =
    /\b(design|ux|ui|usability|visibility|layout|interaction|experience|principal designer|senior designer|feature|ability to|option for|i want to|i want the|i also want|now i want|i would like|can we|can you also|can you make|should we|what can we|improve|make .* better|this needs to|this should be|center the|slow down|filter(?:ing)?|settings?)\b/u.test(normalized);
  return designTerms;
}

function isImplementationPrompt(normalized) {
  const implementationDirective =
    /^(\/goal|implement|execute|build|add|create|make|change|update|show|enable|disable|support|wire|hook up|connect|integrate|replace|do all of|give me|notice that|also notice that|you are worker)\b/u.test(normalized);
  const implementationTerms =
    /\b(implement|implementation|execute this|build this|add this|make this|change this|update this|hook this up|wire this up|integrate this|support this)\b/u.test(normalized);
  return implementationDirective || implementationTerms;
}

function isResearchPrompt(normalized) {
  const researchTerms =
    /\b(research|investigate|look into|take a look|look at|understand|analy[sz]e|compare|find out|figure out|why|what is|what'?s|whats|what does|what are|what about|how can|how do i|how'?s|hows|how about|where do i|where'?s|wheres|do we have|did we|have we|is there|are there|which|can you tell|can you estimate|get a sense|explore|inspect logs?|explain)\b/u.test(normalized);
  return researchTerms;
}

function isFeedbackContextPrompt(normalized) {
  const contextTerms =
    /\b(i have updated|i updated|for context|context:|this is what|here is|here are|a lot of|note that|also notice|notice that|i'?m seeing|i am seeing|i see|i noticed|it looks like|it seems|there is|there are|the screenshot|screenshot)\b/u.test(normalized);
  return contextTerms;
}

function isBroadActionRequestPrompt(normalized) {
  const broadAction =
    /^(can you|could you|please|let'?s|all right do|alright do|okay can you|can you do|do all of|make sure|ensure)\b/u.test(normalized);
  return broadAction;
}

// ─── Recall cues ─────────────────────────────────────────────────────────────
//
// A recall cue is a prompt that points at shared history the current context
// cannot see: "thought we fixed this?", "did we implement that?", "not sure
// where we tried that (which agent)". Measured 2026-10-15 over 30 days of
// Claude transcripts: 72 mid-session prompts carried one, and the agent ran
// recall after 4 of them. hooks/surface-recall-on-prompt.sh runs the search on
// a cue, so the agent no longer has to remember that a recall skill exists.
//
// Kept apart from classifyPromptIntent on purpose. A cue is orthogonal to
// intent ("thought we fixed the wheel?" is a bug report AND a cue), and an
// eighteenth intent would change the keys already stored on indexed turns.
//
// Each cue is a named pattern so the trial log can say which one fired; a
// pattern that only produces noise is then visible and removable by name.
// Strong cues name the past outright (another session, last time, where we
// left off). Weak cues ("did we", "didn't we", "we already") are just as often
// about the last five minutes, so an in-session marker vetoes them.
const RECALL_CUES = [
  // Temporal adjectives only. "the other agent" / "another session" in this
  // corpus names a session running right now ("let the other session do the
  // sidecar"), which is /standup's question, not recall's.
  { name: 'previous-session', strong: true,
    re: /\b(previous|prior|earlier|last|past|older) (claude |codex )?(sessions?|conversations?|chats?|threads?|agents?)\b/u },
  { name: 'which-agent', strong: true,
    re: /\bwhich (agent|session|conversation|chat|thread|claude|codex)\b/u },
  // Not "where you left off": that is the desktop app's resume message.
  { name: 'left-off', strong: true,
    re: /\b(where|what) (we|i) left off\b|\bpick (it |this |that |things )?(back )?up where\b|\bwhere were we\b/u },
  { name: 'last-time', strong: true,
    re: /(?<!for the )\blast time\b/u },
  { name: 'temporal', strong: true,
    re: /\b(yesterday|last (week|night|nite|month)|the other day|earlier today|(a few|couple( of)?|two|three) days ago)\b/u },
  { name: 'thought-we', strong: true,
    re: /\bthought it (was|were|had been|'d been) (fixed|done|solved|resolved|working|handled|gone|removed)\b|\bthought (we|you|i) ((had|have|already|were|was|'d) )*(fix|fixed|had|did|done|built|added|implemented|solved|resolved|handled|tried|made|decided|determined|established|concluded|agreed|settled|ruled|found|showed|proved|confirmed|figured|removed|changed|shipped|landed|merged|addressed|covered|dealt|sorted|killed|dropped|got rid|switched|moved|wired|turned)\b/u },
  { name: 'remember-when', strong: true,
    re: /\b(do you|you|i|we|can'?t|don'?t|cannot|do not|not sure i|trying to) (remember|recall)\b(?! to\b)/u },
  { name: 'used-to-work', strong: true,
    re: /\bused to (work|be (fine|working|fast|right|there))\b|\bwas working (before|yesterday|last week|earlier)\b/u },
  { name: 'seen-before', strong: true,
    re: /\b(we|i)('ve| have| had)? (seen|done|had|hit|fixed|solved|built|tried|discussed|handled) (this|that|it|something (like|similar)( to)?( this| that)?)( \w+){0,3} before\b|\b(like|as) (we|i) did (it |this |that )?(before|earlier|previously)\b/u },
  { name: 'i-think-we', strong: true,
    re: /\bi think (we|you) (already |previously |once )?(made|built|had|added|fixed|wrote|created|tried|did|decided|implemented|discussed|solved|investigated|wired|shipped|landed|measured|set up)\b/u },
  { name: 'we-already', strong: false,
    re: /\b(we|i|you)('ve| have| had|'d)? already (have|ahve|had|got|built|tried|did|done|made|fixed|added|implemented|discussed|decided|looked|wrote|written|solved|covered|shipped|landed|investigated|measured|tested|ruled|went)\b/u },
  { name: 'what-decided', strong: false,
    re: /\bwhat (did|have|had) we (decide|decided|conclude|concluded|agree|agreed|land on|landed on|settle on|settled on|choose|chose|pick|picked|go with|went with|end up|ended up|call|called|name|named|learn|learned)\b|\bwhat was (the|our) (decision|conclusion|verdict|outcome)\b/u },
  { name: 'did-we', strong: false,
    re: /\b(did|have|had) we (ever |already |actually |previously |once |really |not |never )?(implement|implemented|add|added|build|built|fix|fixed|try|tried|decide|decided|ship|shipped|land|landed|discuss|discussed|change|changed|remove|removed|write|wrote|written|make|made|create|created|measure|measured|investigate|investigated|figure|figured|solve|solved|settle|settled|agree|agreed|rename|renamed|document|documented|wire|wired|set up|port|ported|record|recorded|release|released|benchmark|benchmarked|use|used|have|had|see|seen|hit|end up|ended up|consider|considered|evaluate|evaluated|explore|explored|talk|talked|cover|covered|handle|handled|get rid|drop|dropped|kill|killed|lose|lost|revert|reverted|disable|disabled|address|addressed)\b/u },
  // "why didn't we …" is a complaint about the present, not a question about
  // the past ("why the hell didn't we do this hours ago").
  { name: 'didnt-we', strong: false,
    re: /(?<!\bwhy( \w+){0,2} )\b(didn'?t|did not|haven'?t|have not|hadn'?t) we\b/u },
  { name: 'do-we-have', strong: false,
    re: /\b(do|don'?t|dont|do not) we (already |still )?(have|ahve) (a|an|any|one|the|some|this|that|something|anything)\b/u },
  { name: 'we-tried', strong: false,
    re: /\bwe (tried|attempted) (to|this|that|it)\b|\bwe had (this|it|that) (working|before|fixed|done|solved)\b|\bwe had (this|it)[.!?]*$/u },
  { name: 'where-we-tried', strong: false,
    re: /\b(where|when|how) (we|i) (tried|did|put|saw|discussed|wrote|left|found|fixed|solved|decided|added|implemented|built|set up|handled|measured|tested|looked)\b/u },
  { name: 'previously', strong: false,
    re: /\bpreviously\b/u },
  { name: 'again', strong: false,
    re: /\b(broken|broke|breaking|regressed|regressing|failing|crashing|happening|flaking|back) again\b/u },
];

// "did we just break it", "what did we decide above" — the referent is in the
// visible conversation, and recall would only repeat it.
const IN_SESSION_MARKER = /\b(we|you) just\b|\bjust now\b|\babove\b|\b(in|earlier in) this (session|conversation|chat|thread)\b/u;

// Agent-runtime messages that arrive as user prompts and read like cues: the
// desktop app's resume nudge, Codex's approval-review transcript deltas.
const RECALL_NOISE = /^(the app was quit while you were working|the following is the codex agent history|\[\d+\] (assistant|user)\b)/u;

// Past this length a prompt is a pasted spec, log, or brief, and a cue inside it
// is usually quoted material rather than the user asking. A pasted session brief
// carries "previous session" and "where we left off" as examples, and would
// otherwise fire on every paste.
export const RECALL_CUE_MAX_CHARS = 1200;

/**
 * Name the recall cue in a prompt, or return null.
 *
 * Returns { cue, strong, match } for the first pattern that matches, where
 * `match` is the matched span (lowercased). Tooling noise (anything starting
 * with "<", compaction continuations, skill preambles) is never a cue, and
 * neither is a prompt that already invokes /remember itself.
 */
export function recallCue(message) {
  const literal = normalizeLiteralPrompt(String(message ?? '')).replace(/[\u2018\u2019]/gu, "'");
  if (!literal || literal.startsWith('<') || isNonPromptNoise(literal) || RECALL_NOISE.test(literal)) return null;
  if (literal.length > RECALL_CUE_MAX_CHARS) return null;
  if (/(^|\s)[./]remember\b/u.test(literal)) return null;
  const inSession = IN_SESSION_MARKER.test(literal);
  for (const { name, strong, re } of RECALL_CUES) {
    const found = literal.match(re);
    if (!found) continue;
    if (!strong && inSession) continue;
    return { cue: name, strong, match: found[0] };
  }
  return null;
}

export function isRecallCuePrompt(message) {
  return recallCue(message) !== null;
}

// Words that carry no topic once the cue is gone. "didn't we fix this already?"
// leaves nothing to search for: a query built from it matches "fix" across the
// whole corpus and returns confident noise.
const TOPICLESS = new Set(`
  a about after again agent all already also am an and another any are as at be been before
  being both but by can claude codex could did didn didnt do does doesn don dont done earlier
  either ever fix fixed for from get go going got had has have haven havent he her here him his
  how i if in into is isn it its just last least let like made make maybe me might more most
  much my no nor not now of off ok okay on once one only or other our out over please previous
  previously really same see seen session she should so some still such sure than that the their
  them then there these they thing things think this those thought though time to too tried try
  up us use used very was wasn we were what when where which while who why will with would yet
  you your yeah yes hey hmm um
`.trim().split(/\s+/u));

/**
 * The search query for a cued prompt: the prompt minus the cue span, with
 * whitespace collapsed, capped at `max` characters. `topic` counts the words
 * that survive the stoplist; zero means there is nothing to search for.
 */
export function recallQuery(message, cue, max = 240) {
  let text = String(message ?? '')
    .replace(/\[image\b[^\]]*\]/giu, ' ')
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/\s+/gu, ' ')
    .trim();
  if (cue?.match) {
    const at = text.toLowerCase().indexOf(cue.match);
    if (at >= 0) text = `${text.slice(0, at)} ${text.slice(at + cue.match.length)}`.replace(/\s+/gu, ' ').trim();
  }
  text = text.replace(/^[\s,.;:!?-]+|[\s,;:-]+$/gu, '');
  if (text.length > max) text = text.slice(0, max).replace(/\s+\S*$/u, '');
  const topic = (text.toLowerCase().match(/[a-z0-9][a-z0-9_.-]*/gu) || [])
    .filter((word) => word.length >= 3 && !TOPICLESS.has(word.replace(/'.*$/u, '')))
    .length;
  return { query: text, topic };
}

// CLI: --recall-cue reads one prompt on stdin and prints
// "<cue>\t<strong|weak>\t<topic words>\t<query>" when it carries a cue, nothing
// otherwise. Exit status is 0 either way so a hook can tell "no cue" (empty)
// from "classifier failed" (non-zero). Stdin, not argv: prompts run to
// kilobytes and a shell hook should not have to quote them.
async function recallCueCli() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const prompt = Buffer.concat(chunks).toString('utf8');
  const cue = recallCue(prompt);
  if (!cue) return;
  const { query, topic } = recallQuery(prompt, cue);
  const oneLine = query.replace(/[\t\r\n]+/gu, ' ');
  process.stdout.write(`${cue.cue}\t${cue.strong ? 'strong' : 'weak'}\t${topic}\t${oneLine}\n`);
}

// CLI: print "<key>\t<label>" for a prompt passed as arguments.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv[2] === '--recall-cue') {
  await recallCueCli();
} else if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const input = process.argv.slice(2).join(' ');
  if (!input) {
    console.error('Usage: node classify-prompt-intent.js "<prompt text>"');
    process.exit(1);
  }
  const { key, label } = classifyPromptIntent(input);
  console.log(`${key}\t${label}`);
}
