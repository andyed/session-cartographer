// What one call did, in a line: the second half of a work-map row.
//
// lot-map's label says which tool ran ("cartographer-search", "browser batch").
// A session holds a dozen of those in a row, so the list reads as one word
// repeated. The transcript already holds what tells them apart: the query a
// search ran, the lines an edit changed, the page a fetch asked for, how many
// calls a subagent made. This module reads those out.
//
// Everything here is a pure function of one call's recorded input and result.
// The Explorer serves whole transcripts on the same loopback origin, so a
// command line or a prompt is not a new disclosure here. Credentials are still
// masked (scrub): a row is glanced at, screenshotted and shared in a way a
// transcript is not.

const ELLIPSIS = '…';

/** One line, bounded. Cut on a code point, never inside a surrogate pair. */
export function clip(value, max = 140) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join('').trimEnd()}${ELLIPSIS}` : text;
}

/** Masks what a row should never show: URL credentials and query strings, and values named like secrets. */
export function scrub(value) {
  return String(value ?? '')
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]+@/g, '$1')
    .replace(/(https?:\/\/[^\s?"'<>]+)\?[^\s"'<>]*/g, '$1')
    .replace(/\b(Bearer\s+)[\w.~+/-]+=*/gi, `$1${ELLIPSIS}`)
    .replace(/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s;&|]+)/gi, `$1${ELLIPSIS}`)
    .replace(/(--?[\w-]*(?:token|secret|password|passwd|api[_-]?key|credential)[\w-]*\s+)("[^"]*"|'[^']*'|[^\s;&|-][^\s;&|]*)/gi, `$1${ELLIPSIS}`);
}

const line = (...parts) => parts.filter(part => part !== undefined && part !== null && part !== '').join(' · ');
const str = value => (typeof value === 'string' ? value : '');
const quoted = text => `“${clip(text, 110)}”`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** 464 → "464", 92 634 → "93k", 1 240 000 → "1.2M". */
export function compact(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function urlParts(url) {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname === '/' ? '' : u.pathname };
  } catch {
    return { host: '', path: '' };
  }
}

// ─── Session Cartographer's own calls ───────────────────────────────────────
//
// A recall is the one call whose result has a canonical view elsewhere in the
// Explorer: the Memory Desk lists what the call served, in rank order, and
// which hits were marked used. The join key is the call id the search prints
// and `--get`/`--touch` carry back.

const CALL_ID = /\bcall-\d{8}T\d{6}-[\w-]+/;
const SEARCH_VALUE_FLAGS = new Set(['--project', '--limit', '--format', '--since', '--before', '--intent', '--thread', '--get', '--touch', '--call-id', '--purpose', '--min-score']);

const LAUNCHERS = new Set(['bash', 'sh', 'zsh', 'node', 'exec', 'time', 'command', 'env', 'nohup']);

/**
 * A shell line as its commands, each a list of words, split where the shell splits: on `;`, `|`, `&`,
 * parentheses, backticks and newlines that are not inside quotes. A regex cannot do this: the `|` in
 * `grep "a\|cartographer-pulse" file` and the `(` in `jq 'test("session-cartographer")'` are text.
 */
function shellCommands(text) {
  const commands = [];
  let words = [];
  let word = null;
  let quote = '';
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
      else if (ch === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      word ??= '';
    } else if (ch === '\\' && i + 1 < text.length) {
      word = (word ?? '') + text[++i];
    } else if (ch === '&' && word !== null && /[<>]$/.test(word)) {
      word += ch; // 2>&1 is one redirection, not the end of a command
    } else if (';|&()`\n'.includes(ch)) {
      endCommand();
    } else if (ch === ' ' || ch === '\t') {
      endWord();
    } else {
      word = (word ?? '') + ch;
    }
  }
  endCommand();
  return commands;
}

/**
 * The arguments a shell line passes to a script it runs, or null when the line only names the script.
 * "Runs" means the script is the program of a command: its first word after any `VAR=value` and launcher
 * words, with the name in the file's own name. `grep -n x scripts/cartographer-feed.sh` names it; so do a
 * heredoc that mentions it, `R=~/dev/session-cartographer` and `bash session-cartographer/run.sh`.
 */
function scriptArgs(command, script) {
  const lines = command.replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '');
  for (const words of shellCommands(lines)) {
    let i = 0;
    while (i < words.length && (/^\w+=/.test(words[i]) || LAUNCHERS.has(words[i]) || (i > 0 && LAUNCHERS.has(words[i - 1]) && words[i].startsWith('-')))) i++;
    if (i >= words.length || !words[i].split('/').pop().includes(script)) continue;
    const args = [];
    for (let j = i + 1; j < words.length; j++) {
      // Where the output went is not an argument.
      if (/^\d*[<>]+$/.test(words[j])) j++;
      else if (!/^\d*[<>]/.test(words[j])) args.push(words[j]);
    }
    return args;
  }
  return null;
}

function flags(words, valued) {
  const out = { _: [] };
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (!word.startsWith('--')) out._.push(word);
    else if (valued.has(word)) out[word.slice(2)] = words[++i] ?? '';
    else out[word.slice(2)] = true;
  }
  return out;
}

const idCount = value => (Array.isArray(value) ? value : String(value ?? '').split(',')).filter(Boolean).length;

/** One recall-shaped call, whichever way it was made: `recall` is its kind, `call` the id that joins it to the Memory Desk. */
function recallDetail({ kind, query, ids, call, project, since, before, results }) {
  const scope = line(project && `project ${project}`, since && `since ${since}`, before && `before ${before}`);
  if (kind === 'search') return { recall: 'search', label: quoted(query), query: clip(query, 200), call, detail: line('search', scope, Number.isFinite(results) ? plural(results, 'result') : '') };
  if (kind === 'get') return { recall: 'get', label: `get ${plural(ids, 'record')}`, call, detail: 'full records' };
  if (kind === 'mark') return { recall: 'mark', label: `marked ${ids} used`, call, detail: 'recorded as used' };
  return null;
}

function cartoShell(command, resultText) {
  const search = scriptArgs(command, 'cartographer-search');
  if (search !== null) {
    const f = flags(search, SEARCH_VALUE_FLAGS);
    const carried = CALL_ID.exec(str(f['call-id']))?.[0];
    if (f.get !== undefined) return recallDetail({ kind: 'get', ids: idCount(f.get), call: carried });
    if (f.touch !== undefined) return recallDetail({ kind: 'mark', ids: idCount(f.touch), call: carried });
    if (f.thread !== undefined) return { label: 'thread', detail: line('how an event came about', clip(f.thread, 40)) };
    if (f._[0]) return recallDetail({ kind: 'search', query: f._[0], call: carried ?? CALL_ID.exec(resultText)?.[0], project: str(f.project), since: str(f.since), before: str(f.before) });
  }
  const facts = scriptArgs(command, 'cartographer-facts');
  if (facts !== null) {
    const f = flags(facts, new Set(['--verb', '--project', '--since', '--before', '--top', '--cursor']));
    const verb = ['census', 'tempo', 'delta'].find(v => v === str(f.verb) || v === f._[0]);
    if (verb) return { label: `facts ${verb}`, detail: line('counted, not ranked', f.project && `project ${f.project}`, f.since && `since ${f.since}`) };
  }
  for (const script of ['cooccurrence-graph', 'cartographer-standup', 'cartographer-pulse', 'cartographer-feed', 'session-digest']) {
    const args = scriptArgs(command, script);
    if (args !== null) return { label: script.replace(/^cartographer-/, ''), detail: clip(scrub(args.join(' ')), 120) };
  }
  return null;
}

function cartoMcp(tool, input, resultText) {
  const call = CALL_ID.exec(str(input.call_id))?.[0] ?? CALL_ID.exec(resultText)?.[0];
  if (tool === 'recall') {
    const results = /(\d+) results?\b/.exec(resultText);
    return recallDetail({ kind: 'search', query: str(input.query), call, project: str(input.project), since: str(input.since), before: str(input.before), results: results ? Number(results[1]) : NaN });
  }
  if (tool === 'get') return recallDetail({ kind: 'get', ids: idCount(input.event_ids), call });
  if (tool === 'mark_used') return recallDetail({ kind: 'mark', ids: idCount(input.event_ids), call });
  if (tool === 'facts') return { label: `facts ${str(input.verb) || 'census'}`, detail: line('counted, not ranked', input.project && `project ${input.project}`, input.since && `since ${input.since}`) };
  if (tool === 'orient') return { label: `orient ${str(input.project)}`.trim(), detail: 'recent state of a project' };
  if (tool === 'thread') return { label: 'thread', detail: line('how an event came about', clip(str(input.event_id), 40)) };
  if (tool === 'standup') return { label: 'standup', detail: 'who else is working' };
  return null;
}

/** Whether a shell line runs a script named like `name`, as against reading, searching or printing one. */
export const runsScript = (command, name) => scriptArgs(String(command ?? ''), name) !== null;

// ─── Every other tool ───────────────────────────────────────────────────────

const PRIORITY = ['description', 'query', 'command', 'url', 'file_path', 'path', 'pattern', 'prompt', 'text', 'title', 'name', 'message', 'id'];

/** A call this module has no rule for: its most telling argument, then the next scalars. */
function generic(input) {
  const entries = Object.entries(input ?? {}).filter(([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && v !== '');
  const first = PRIORITY.map(key => entries.find(([k]) => k === key)).find(Boolean) ?? entries[0];
  if (!first) return '';
  const rest = entries.filter(e => e !== first && String(e[1]).length <= 40).slice(0, 2).map(([k, v]) => `${k} ${v}`);
  return line(clip(scrub(first[1]), 120), ...rest);
}

function patchLines(patch) {
  let added = 0;
  let removed = 0;
  for (const hunk of Array.isArray(patch) ? patch : []) {
    for (const l of Array.isArray(hunk?.lines) ? hunk.lines : []) {
      if (l.startsWith('+')) added++;
      else if (l.startsWith('-')) removed++;
    }
  }
  return added + removed === 0 ? '' : `+${added} −${removed}`;
}

const lineCount = text => (text === '' ? 0 : text.replace(/\n$/, '').split('\n').length);

function browserStep(name, input, brief = false) {
  const short = name.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '').replace(/_/g, ' ');
  if (name.endsWith('__navigate') || name.endsWith('__preview_start')) {
    const { host, path } = urlParts(str(input.url));
    return line(short, host ? `${host}${path}` : str(input.name));
  }
  if (name.endsWith('__computer')) return line(str(input.action).replace(/_/g, ' '), str(input.action_summary));
  if (name.endsWith('__find')) return line('find', quoted(str(input.query)));
  if (name.endsWith('__javascript_tool')) return brief ? 'script' : line('script', clip(scrub(str(input.text)), 90));
  return short;
}

/**
 * What a Claude Code tool call did. `outcome.text` is the result as text, `outcome.meta` the structured
 * result Claude Code records beside it (`toolUseResult`). Returns only the fields it can fill:
 * `label` replaces the classifier's when it says more, `detail` is the row's second line.
 */
export function describeTool(name, input = {}, outcome = {}, station = '') {
  const text = str(outcome.text);
  const meta = outcome.meta && typeof outcome.meta === 'object' ? outcome.meta : {};

  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp && /cartographer/.test(mcp[1])) return cartoMcp(mcp[2], input, text) ?? { detail: generic(input) };

  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const command = str(input.command);
      const carto = station === 'memory' ? cartoShell(command, text) : null;
      const shown = clip(scrub(command), 120);
      if (carto) return carto;
      // A memory-station command that ran no carto script only named one: say what it did instead.
      return { ...(station === 'memory' && str(input.description) ? { label: clip(input.description, 110) } : {}), detail: shown };
    }
    case 'Read': {
      const from = Number(input.offset);
      const count = Number(input.limit);
      const total = Number(meta.file?.totalLines ?? meta.file?.numLines);
      const range = Number.isFinite(from) && Number.isFinite(count) ? `lines ${from}–${from + count - 1}` : Number.isFinite(total) ? plural(total, 'line') : '';
      return { op: 'read', detail: line('read', range) };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { op: 'edit', file: str(input.file_path ?? input.notebook_path), detail: line('edit', patchLines(meta.structuredPatch), input.replace_all === true ? 'every match' : '') };
    case 'Write':
      return { op: 'write', file: str(input.file_path), detail: line(meta.type === 'create' ? 'created' : 'wrote', plural(lineCount(str(input.content)), 'line')) };
    case 'Grep':
      return { op: 'search', detail: line('search', quoted(str(input.pattern)), str(input.glob) || str(input.type)) };
    case 'Glob':
      return { op: 'search', detail: line('find files', quoted(str(input.pattern))) };
    case 'WebFetch': {
      const { path } = urlParts(str(input.url));
      return { detail: line('fetch', path, str(input.prompt) && quoted(clip(input.prompt, 80))) };
    }
    case 'WebSearch':
      return { label: quoted(str(input.query)), detail: 'web search' };
    case 'Agent':
    case 'Task': {
      const uses = Number(meta.totalToolUseCount);
      const tokens = Number(meta.totalTokens);
      return {
        spawned: str(meta.agentId) || undefined,
        detail: line(str(input.subagent_type) || str(meta.agentType), meta.isAsync === true ? 'in the background' : '', Number.isFinite(uses) ? plural(uses, 'tool use') : '', Number.isFinite(tokens) ? `${compact(tokens)} tokens` : ''),
      };
    }
    case 'Skill':
      return { detail: clip(scrub(str(input.args)), 120) };
    case 'ToolSearch': {
      // Not a skill: the agent fetching the definition of a tool it has only by name. lot-map files it under
      // Skills as "loading tools"; the row names the tool that did it and what it loaded.
      const query = str(input.query)
      const picked = /^select:(.+)$/.exec(query)
      const loaded = picked ? picked[1].split(',').map(name => name.trim()).filter(Boolean) : []
      return { label: 'ToolSearch', detail: picked ? `loaded ${clip(loaded.join(', '), 100)}` : query ? `searched ${quoted(query)}` : '' };
    }
    case 'AskUserQuestion':
      return { detail: clip(str(input.questions?.[0]?.question), 120) };
    case 'SendUserFile':
      return { detail: clip((Array.isArray(input.files) ? input.files : []).map(f => String(f).split('/').pop()).join(', '), 120) };
    default:
  }

  if (name.endsWith('__update_plan')) {
    const items = Array.isArray(input.items) ? input.items : null;
    const current = items?.find(item => item?.status === 'in_progress')?.content;
    return { detail: items ? line(plural(items.length, 'step'), current && clip(current, 80)) : input.advance === true ? 'next step' : generic(input) };
  }
  if (name.endsWith('__wrap_up')) return { detail: clip(str(input.recap), 140) };
  if (name.endsWith('__browser_batch')) {
    const steps = (Array.isArray(input.actions) ? input.actions : []).map(step => browserStep(`mcp__x__${step?.name ?? ''}`, step?.input ?? {}, true));
    const shown = steps.slice(0, 3).join(', ');
    return { detail: line(plural(steps.length, 'step'), clip(steps.length > 3 ? `${shown}, ${ELLIPSIS}` : shown, 130)) };
  }
  if (station === 'browser') return { detail: browserStep(name, input) };
  return { detail: generic(input) };
}

/** A model request: what it produced and how much context it read to do it. */
export function describeUsage(usage) {
  if (!usage || typeof usage !== 'object') return '';
  const out = Number(usage.output_tokens);
  const read = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cached_input_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0);
  // Codex counts its cached tokens inside input_tokens; Claude counts them beside it.
  const context = usage.cached_input_tokens !== undefined ? Number(usage.input_tokens) || 0 : read;
  return line(Number.isFinite(out) ? `${compact(out)} tokens out` : '', context > 0 ? `${compact(context)} context` : '');
}

const HOOK_OUTCOME = { hook_success: 'ran', hook_additional_context: 'added context', hook_non_blocking_error: 'failed', hook_blocking_error: 'blocked the call', hook_cancelled: 'cancelled', hook_stopped_continuation: 'stopped the turn' };

/** A hook row: what it did and the first line it said. */
export function describeHook(attachment = {}) {
  const said = [attachment.content, attachment.stderr, attachment.blockingError?.blockingError].flat().find(v => typeof v === 'string' && v.trim() !== '');
  return line(HOOK_OUTCOME[attachment.type] ?? str(attachment.type).replace(/^hook_/, '').replace(/_/g, ' '), said ? clip(scrub(said.split('\n')[0]), 110) : '');
}

/** The first line of what the person wrote. */
export function describePrompt(content) {
  const text = typeof content === 'string' ? content : (Array.isArray(content) ? content : []).filter(p => p?.type === 'text' || p?.type === 'input_text').map(p => p.text ?? '').join(' ');
  return clip(scrub(text), 140);
}

// ─── Codex items ────────────────────────────────────────────────────────────

const CHANGE = { add: 'created', update: 'edit', delete: 'deleted' };

function diffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const l of str(diff).split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) added++;
    else if (l.startsWith('-') && !l.startsWith('---')) removed++;
  }
  return added + removed === 0 ? '' : `+${added} −${removed}`;
}

/** What a completed Codex item did, in the same fields as describeTool. */
export function describeCodexItem(item = {}, station = '') {
  switch (item.type) {
    case 'CommandExecution': {
      const command = Array.isArray(item.command) ? String(item.command.at(-1) ?? '') : str(item.command);
      const carto = station === 'memory' ? cartoShell(command, str(item.aggregated_output)) : null;
      if (carto) return carto;
      // Codex parses its own commands: a `cat` is a read, an `rg` a search.
      const parsed = (Array.isArray(item.parsed_cmd) ? item.parsed_cmd : []).filter(p => p && p.type !== 'unknown');
      const what = parsed[0]?.type === 'read' ? `read ${parsed.map(p => p.name).filter(Boolean).slice(0, 3).join(', ')}`
        : parsed[0]?.type === 'search' ? line('search', parsed[0].query && quoted(parsed[0].query))
        : parsed[0]?.type === 'list_files' ? 'list files' : '';
      const exit = Number(item.exit_code);
      return { ...(what ? { label: clip(what, 110) } : {}), detail: line(clip(scrub(command), 120), Number.isFinite(exit) && exit !== 0 ? `exit ${exit}` : '') };
    }
    case 'McpToolCall': {
      let args = item.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { args = {}; }
      }
      // The result is recorded as the MCP envelope, not as text: the call id and the count are inside it.
      const said = typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? '');
      return describeTool(`mcp__${item.server}__${item.tool}`, args && typeof args === 'object' ? args : {}, { text: said.slice(0, 4000) }, station);
    }
    case 'FileChange': {
      const changes = item.changes && typeof item.changes === 'object' ? Object.entries(item.changes) : [];
      const [file, first] = changes[0] ?? ['', {}];
      const kinds = [...new Set(changes.map(([, c]) => CHANGE[c?.type] ?? 'edit'))];
      const lines = changes.map(([, c]) => diffLines(c?.unified_diff ?? c?.diff)).filter(Boolean);
      const created = first?.type === 'add' && typeof first.content === 'string' ? plural(lineCount(first.content), 'line') : '';
      return { op: first?.type === 'add' ? 'write' : 'edit', file, detail: line(kinds.join(', '), changes.length === 1 ? lines[0] ?? created : plural(changes.length, 'file')) };
    }
    case 'ImageView':
      return { op: 'read', detail: 'viewed image' };
    case 'Extension': {
      const action = item.action && typeof item.action === 'object' ? item.action : {};
      const { path } = urlParts(str(action.url));
      const query = str(item.query);
      return { detail: line(str(action.type) === 'openPage' ? 'open page' : str(action.type) === 'search' ? 'web search' : str(action.type), path, query && !/^https?:\/\//.test(query) ? quoted(query) : '') };
    }
    default:
      return {};
  }
}
