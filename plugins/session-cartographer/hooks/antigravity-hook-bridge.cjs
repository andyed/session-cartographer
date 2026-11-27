/* Antigravity lifecycle hook bridge: translates camelCase stdin to Cartographer
 * snake_case payloads, runs the target shell hook under run-hook.cjs's bounded
 * timeout/slot/circuit-breaker discipline, and ALWAYS writes valid Antigravity
 * response JSON on stdout so a hook fault never breaks Antigravity's sync loop. */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { resolveBash, acquireSlot, launchHook, HOOKS } = require('./run-hook.cjs');

const COOLDOWN_MS = 30000;
const PRE_INVOCATION_MAX_FILES = 200;
const PRE_INVOCATION_KEEP_FILES = 100;
const PRE_INVOCATION_TTL_MS = 24 * 60 * 60 * 1000;

function isResolved(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'unknown';
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return '';
}

function inferEventFromHook(hookName) {
  switch (hookName) {
    case 'check-edit-collision.sh':
      return 'PreToolUse';
    case 'log-tool-use.sh':
    case 'log-research.sh':
      return 'PostToolUse';
    case 'surface-recall-on-prompt.sh':
    case 'deliver-notes-on-prompt.sh':
      return 'PreInvocation';
    case 'log-session-milestones.sh':
      return 'Stop';
    case 'warn-missing-jq-on-start.sh':
    case 'start-transcript-catch-up.sh':
    case 'surface-turbo-on-start.sh':
    case 'surface-focus-on-start.sh':
      return 'SessionStart';
    default:
      return '';
  }
}

function defaultResponse(agyEventName, hookName = '') {
  const ev = agyEventName || inferEventFromHook(hookName);
  if (ev === 'PreToolUse') return { decision: 'allow' };
  return {};
}

function mapToolCall(toolCall) {
  const rawName = typeof toolCall.name === 'string' ? toolCall.name : '';
  const args = (toolCall.args && typeof toolCall.args === 'object') ? toolCall.args : {};

  switch (rawName) {
    case 'run_command':
      return {
        tool_name: 'Bash',
        tool_input: { command: firstString(args.CommandLine, args.command) },
      };
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content':
      return {
        tool_name: 'Edit',
        tool_input: { file_path: firstString(args.Path, args.TargetFile, args.file_path) },
      };
    case 'write_file':
    case 'write_to_file':
      return {
        tool_name: 'Write',
        tool_input: { file_path: firstString(args.Path, args.TargetFile, args.file_path) },
      };
    case 'search_web':
      return {
        tool_name: 'WebSearch',
        tool_input: { query: firstString(args.query, args.Query) },
      };
    case 'read_url_content':
    case 'fetch_url':
      return {
        tool_name: 'WebFetch',
        tool_input: { url: firstString(args.Url, args.url) },
      };
    default:
      return {
        tool_name: rawName,
        tool_input: args,
      };
  }
}

function translateInput(agyPayload) {
  const agy = (agyPayload && typeof agyPayload === 'object') ? agyPayload : {};
  const workspace0 = (Array.isArray(agy.workspacePaths) && typeof agy.workspacePaths[0] === 'string')
    ? agy.workspacePaths[0]
    : '';

  const out = {
    session_id: typeof agy.conversationId === 'string' ? agy.conversationId : '',
    transcript_path: typeof agy.transcriptPath === 'string' ? agy.transcriptPath : '',
    cwd: (typeof agy.cwd === 'string' && agy.cwd) ? agy.cwd : workspace0,
    model: typeof agy.modelName === 'string' ? agy.modelName : '',
    prompt: typeof agy.lastUserInput === 'string' ? agy.lastUserInput : '',
  };

  if (agy.toolCall && typeof agy.toolCall === 'object') {
    const mapped = mapToolCall(agy.toolCall);
    out.tool_use_id = typeof agy.toolCall.id === 'string' ? agy.toolCall.id : '';
    out.tool_name = mapped.tool_name;
    out.tool_input = mapped.tool_input;
  }

  if (agy.toolResponse !== undefined) {
    out.tool_response = agy.toolResponse;
  }

  const rawEvent = typeof agy.hookEventName === 'string' ? agy.hookEventName : '';
  const hasError = typeof agy.error === 'string'
    ? agy.error.trim().length > 0
    : Boolean(agy.error);

  switch (rawEvent) {
    case 'SessionStart':
      out.hook_event_name = 'SessionStart';
      out.source = (typeof agy.source === 'string' && agy.source) ? agy.source : 'startup';
      break;
    case 'PreInvocation':
      out.hook_event_name = 'UserPromptSubmit';
      break;
    case 'PreToolUse':
      out.hook_event_name = 'PreToolUse';
      break;
    case 'PostToolUse':
      out.hook_event_name = (hasError && out.tool_name === 'Bash') ? 'PostToolUseFailure' : 'PostToolUse';
      if (hasError) out.error = agy.error;
      break;
    case 'Stop':
      out.hook_event_name = 'Stop';
      break;
    default:
      out.hook_event_name = rawEvent;
      break;
  }

  return out;
}

function extractAdditionalContext(hookStdout) {
  if (typeof hookStdout !== 'string') return '';
  const trimmed = hookStdout.trim();
  if (!trimmed) return '';

  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const candidate = JSON.parse(lines[i]);
        if (candidate && typeof candidate === 'object') {
          parsed = candidate;
          break;
        }
      } catch {}
    }
  }

  if (!parsed || typeof parsed !== 'object') return '';
  const ctx = (parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === 'object'
    ? parsed.hookSpecificOutput.additionalContext
    : undefined) ?? parsed.systemMessage ?? '';
  return typeof ctx === 'string' ? ctx.trim() : '';
}

function translateOutput(agyEventName, hookStdout) {
  const additionalContext = extractAdditionalContext(hookStdout);

  switch (agyEventName) {
    case 'PreToolUse':
      return additionalContext
        ? { decision: 'allow', reason: additionalContext }
        : { decision: 'allow' };
    case 'PostToolUse':
      return {};
    case 'SessionStart':
    case 'PreInvocation':
      return additionalContext
        ? { injectSteps: [{ systemMessage: { systemMessage: additionalContext } }] }
        : {};
    case 'Stop':
      return {};
    default:
      return {};
  }
}

function shouldSkipStop(agyPayload) {
  if (!agyPayload || typeof agyPayload !== 'object') return false;
  return agyPayload.continuationActive === true || agyPayload.terminationReason === 'USER_CANCELED';
}

function defaultStateDir(env = process.env) {
  if (env.CARTOGRAPHER_HOOK_STATE_DIR) return env.CARTOGRAPHER_HOOK_STATE_DIR;
  const user = os.userInfo().username.replace(/[^a-z0-9_-]/gi, '_');
  return path.join(os.tmpdir(), 'cartographer-hook-launcher-' + user);
}

function prunePreInvocationDir(dir, now = Date.now()) {
  try {
    const names = fs.readdirSync(dir);
    if (names.length <= PRE_INVOCATION_MAX_FILES) return;
    const entries = [];
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        const stat = fs.statSync(full);
        if (now - stat.mtimeMs > PRE_INVOCATION_TTL_MS) {
          fs.unlinkSync(full);
        } else {
          entries.push({ full, mtimeMs: stat.mtimeMs });
        }
      } catch {}
    }
    if (entries.length > PRE_INVOCATION_MAX_FILES) {
      entries.sort((a, b) => a.mtimeMs - b.mtimeMs);
      const drop = entries.length - PRE_INVOCATION_KEEP_FILES;
      for (let i = 0; i < drop; i++) {
        try { fs.unlinkSync(entries[i].full); } catch {}
      }
    }
  } catch {}
}

function shouldRunPreInvocation(agyPayload, stateDir) {
  if (!agyPayload || typeof agyPayload !== 'object') return false;
  const isFirst = agyPayload.invocationNum === 1;
  const key = isResolved(agyPayload.conversationId)
    ? agyPayload.conversationId.trim()
    : (isResolved(agyPayload.transcriptPath) ? agyPayload.transcriptPath.trim() : '');

  if (!key) {
    return isFirst || agyPayload.invocationNum === undefined || agyPayload.invocationNum === null;
  }

  const promptText = typeof agyPayload.lastUserInput === 'string' ? agyPayload.lastUserInput : '';
  const promptHash = crypto.createHash('sha256').update(promptText).digest('hex');
  const keyHash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  const dedupDir = path.join(stateDir, 'pre-invocation');
  const stateFile = path.join(dedupDir, keyHash + '.sha256');

  let prevHash = null;
  try {
    prevHash = fs.readFileSync(stateFile, 'utf8').trim();
  } catch {}

  const changed = prevHash !== promptHash;
  const shouldRun = isFirst || changed;
  if (shouldRun) {
    try {
      fs.mkdirSync(dedupDir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(stateFile, promptHash, { mode: 0o600 });
      prunePreInvocationDir(dedupDir);
    } catch {}
  }
  return shouldRun;
}

function readStdin(stream = process.stdin) {
  return new Promise(resolve => {
    if (!stream || stream.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve(data);
      }
    };
    stream.setEncoding('utf8');
    stream.on('data', chunk => { data += chunk; });
    stream.once('end', done);
    stream.once('error', done);
  });
}

async function runTranslatedHook(scriptPath, translatedPayload, {
  timeoutMs = 10000,
  env = process.env,
  bash,
  spawnImpl = spawn,
} = {}) {
  const inputJson = JSON.stringify(translatedPayload) + '\n';
  let stdout = '';
  let resolveStdoutDone;
  const stdoutDone = new Promise(resolve => { resolveStdoutDone = resolve; });

  const result = await launchHook(scriptPath, {
    bash: bash || resolveBash(process.platform, env),
    timeoutMs,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    spawnImpl: (exe, spawnArgs, spawnOpts) => {
      const child = spawnImpl(exe, spawnArgs, spawnOpts);
      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stdout.once('end', () => resolveStdoutDone());
        child.stdout.once('close', () => resolveStdoutDone());
      } else {
        resolveStdoutDone();
      }
      if (child.stderr) {
        child.stderr.resume();
      }
      if (child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(inputJson);
      }
      return child;
    },
  });

  if (!result.fault) {
    let drainTimer;
    await Promise.race([
      stdoutDone,
      new Promise(resolve => {
        drainTimer = setTimeout(resolve, 100);
        if (typeof drainTimer.unref === 'function') drainTimer.unref();
      }),
    ]);
    clearTimeout(drainTimer);
  }

  return { ...result, stdout };
}

async function main(args = process.argv.slice(2), opts = {}) {
  const env = opts.env || process.env;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const hookDir = opts.hookDir || __dirname;
  const [name = '', budget = '10000'] = args;

  const rawStdin = opts.stdinText !== undefined ? opts.stdinText : await readStdin(opts.stdin || process.stdin);
  let agyPayload = null;
  if (typeof rawStdin === 'string' && rawStdin.trim()) {
    try {
      const parsed = JSON.parse(rawStdin);
      if (parsed && typeof parsed === 'object') agyPayload = parsed;
    } catch {}
  }

  const agyEventName = (agyPayload && typeof agyPayload.hookEventName === 'string' && agyPayload.hookEventName)
    || inferEventFromHook(name);

  const emit = obj => {
    stdout.write(JSON.stringify(obj) + '\n');
  };

  if (env.CARTOGRAPHER_HOOK_ACTIVE === '1') {
    emit(defaultResponse(agyEventName, name));
    return 0;
  }

  const timeoutMs = Number(budget);
  const allowCustomScript = Boolean(opts.scriptPath);
  if (
    args.length < 1 ||
    args.length > 2 ||
    (!allowCustomScript && !HOOKS.has(name)) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 100 ||
    timeoutMs > 10000
  ) {
    stderr.write('[cartographer agy-hook] Invalid hook name or timeout\n');
    emit(defaultResponse(agyEventName, name));
    return 0;
  }

  if (!agyPayload) {
    emit(defaultResponse(agyEventName, name));
    return 0;
  }

  const stateDir = opts.stateDir || defaultStateDir(env);
  const breaker = path.join(stateDir, 'failed-at');

  if (agyEventName === 'PreInvocation' && name === 'surface-recall-on-prompt.sh') {
    if (!shouldRunPreInvocation(agyPayload, stateDir)) {
      emit({});
      return 0;
    }
  }

  if (agyEventName === 'Stop' && shouldSkipStop(agyPayload)) {
    emit({});
    return 0;
  }

  let release;
  try {
    try {
      if (Date.now() - Number(fs.readFileSync(breaker, 'utf8')) < COOLDOWN_MS) {
        emit(defaultResponse(agyEventName, name));
        return 0;
      }
    } catch {}

    release = acquireSlot(stateDir);
    if (!release) {
      stderr.write('[cartographer agy-hook] Concurrent hook limit reached; skipped\n');
      emit(defaultResponse(agyEventName, name));
      return 0;
    }

    const translated = translateInput(agyPayload);
    const childEnv = {
      ...env,
      CARTOGRAPHER_PROVIDER: 'antigravity',
    };
    if (isResolved(agyPayload.conversationId)) {
      childEnv.ANTIGRAVITY_CONVERSATION_ID = agyPayload.conversationId.trim();
    }

    const scriptPath = opts.scriptPath || path.join(hookDir, name);
    const result = await runTranslatedHook(scriptPath, translated, {
      timeoutMs,
      env: childEnv,
      bash: opts.bash,
      spawnImpl: opts.spawnImpl,
    });

    if (result.fault) {
      try { fs.writeFileSync(breaker, String(Date.now())); } catch {}
      stderr.write('[cartographer agy-hook] ' + result.fault + '; hooks paused for 30 seconds\n');
      emit(defaultResponse(agyEventName, name));
      return 0;
    }

    emit(translateOutput(agyEventName, result.stdout));
    return 0;
  } catch (error) {
    try {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(breaker, String(Date.now()));
    } catch {}
    stderr.write('[cartographer agy-hook] ' + error.message + '; no retry\n');
    emit(defaultResponse(agyEventName, name));
    return 0;
  } finally {
    if (release) release();
  }
}

module.exports = {
  translateInput,
  translateOutput,
  shouldRunPreInvocation,
  shouldSkipStop,
  defaultResponse,
  inferEventFromHook,
  extractAdditionalContext,
  main,
};

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}
