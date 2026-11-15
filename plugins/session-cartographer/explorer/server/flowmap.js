// Reads one recorded session into the actions a flow map is drawn from.
//
// The transcript is the source, not the hook logs. The hooks record a finished
// Bash call, an edit or a fetch; a transcript also records when each call
// started, the reads and searches, skills, model requests, and which subagent
// made a call. Both providers write one, so one map serves both, and a session
// that ended months ago draws the same way as one still running.
//
// Nothing here writes, and nothing here opens a file a transcript names: only
// the transcript itself and the subagent transcripts beside it.
//
// A row has two parts. `label` is the classifier's name for the call; `detail`
// (flowmap-detail.js) is what that call did: the query, the lines changed, the
// command. A recall also carries its `call` id and an edit its `file`, which is
// how the list links them to the Memory Desk's views of the same thing.
//
// Each action also says where the transcript reader shows it: `uuid` is the
// reader's message id (transcript-evidence.js, normalizeEvidenceEntries) and
// `block` the index of the part inside that message. A list row links there.

import { existsSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

import { readTranscriptText } from '../../scripts/transcript-file.js';

import { tally } from '../shared/flowmap/board.js';
import { classify, shortModel } from '../shared/flowmap/classify.js';
import { starterOf, wakeLabel } from '../shared/flowmap/kinds.js';
import { STATIONS, setupFrom } from '../shared/flowmap/setup.js';
import { describeCodexItem, describeHook, describePrompt, describeTool, describeUsage, promptText, runsScript } from './flowmap-detail.js';

/**
 * lot-map files a shell line under Memory by the words of its first command: `grep -n x scripts/cartographer-feed.sh`
 * counts as a recall, and `cd repo; node scripts/cartographer-facts.js census` does not. Here a line is a memory
 * command exactly when it runs one, wherever in the line. Measured on one session: 6 of 15 Memory rows ran none.
 * A line that reads or writes a memory file is Memory either way; that rule is the classifier's and is kept.
 */
/**
 * lot-map files a tool that reports to the person (a task-list update, a wrap-up, a question, a file sent) under
 * "you". Every such row is the agent's call, so it moves to "tells". Only a message the person wrote is "you".
 */
const toTells = (found, tool = '') => {
  if (found.station !== 'you') return found;
  // The desktop app's session tools share a server prefix with its reporting tools, and lot-map files the lot
  // under "you". Reading or messaging another session is work with other agents, not a report to the person.
  return { ...found, station: /__ccd_session_mgmt__|__ccd_window__|__ccd_sidebar__/.test(tool) ? 'agents' : 'tells' };
};

/**
 * Something arrived in the person's turn. Only what the person typed is filed under "you". A background task
 * reporting back, a reminder the harness added and a summary written at a compaction woke the agent without
 * anyone speaking: they are filed under Hooks, which is where the map keeps what fires on an event, and
 * carry `wake` so a drawing can start a new stretch of the route there as it does at a message.
 */
function arrival(content, setup, ts, uuid) {
  const text = promptText(content);
  const starter = starterOf(text);
  if (starter === 'person') return { station: 'you', label: describePrompt(content) || setup.t.stations.you, from: 'inbound', startedAt: ts, endedAt: ts, status: 'ok', uuid };
  // What arrived is markup written for the agent: the row says what it was, in words.
  return { station: 'hooks', label: wakeLabel(text), from: 'inbound', wake: starter, startedAt: ts, endedAt: ts, status: 'ok', uuid };
}

/** The tokens a model request had in its context: what it was sent, cached or not. */
const contextTokens = usage => (usage && typeof usage === 'object' ? ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'].reduce((sum, key) => sum + (Number(usage[key]) || 0), 0) : 0);

/**
 * A Claude transcript records how many tokens each request read, and not how many the model could have read.
 * The window is 200k, or 1M on the long-context variants, so a session that has read more than 200k in one
 * request is on a 1M window, and a model id that says so is believed. A session on a 1M window that never
 * passed 200k is read as 200k and its ring runs up to five times too full; `source` says the size was worked out.
 */
function claudeWindow(model, peak) {
  if (peak === 0) return null;
  const long = /\[1m\]/i.test(String(model ?? '')) || peak > 200_000;
  return { window: long ? 1_000_000 : 200_000, source: 'inferred' };
}

function classifyCall(name, input, setup) {
  const found = toTells(classify(name, input, setup), name);
  if (name !== 'Bash' && name !== 'PowerShell') return found;
  const runs = setup.memoryCommands.some(script => runsScript(String(input.command ?? ''), script));
  if (runs) return { ...found, station: 'memory' };
  return found.station === 'memory' ? classify(name, input, { ...setup, memoryCommands: [] }) : found;
}

/** How much of a result is searched for what a row shows (a call id, a result count). Both print in the first lines. */
const RESULT_HEAD = 4000;

/** Lays what flowmap-detail.js found over an action. A label is replaced only by one that says more. */
function enrich(action, found) {
  for (const key of ['label', 'detail', 'op', 'file', 'call', 'recall', 'query', 'spawned']) {
    if (found?.[key] !== undefined && found[key] !== '') action[key] = found[key];
  }
  // A second line that repeats the first says nothing.
  if (typeof action.detail === 'string' && action.detail.toLowerCase() === String(action.label).toLowerCase()) delete action.detail;
  return action;
}

const resultText = content => (typeof content === 'string' ? content : (Array.isArray(content) ? content : []).map(p => (typeof p?.text === 'string' ? p.text : '')).join('\n')).slice(0, RESULT_HEAD);

/** Carto's own recall is memory, whichever way the agent reached it: the MCP server or the scripts. */
export const FLOWMAP_OPTIONS = Object.freeze({
  memoryServers: 'memory,cartographer,plugin_session-cartographer_cartographer',
  memoryCommands: 'cartographer,cooccurrence-graph',
});

function* rows(path) {
  for (const line of readTranscriptText(path).split('\n')) {
    if (line === '') continue;
    try {
      yield JSON.parse(line);
    } catch {
      // A torn or partial last line is skipped: the session may still be writing.
    }
  }
}

// ─── Claude Code ────────────────────────────────────────────────────────────

function readClaude(path, agentId, setup, actions, state) {
  const open = new Map();
  const requests = new Map();
  const from = agentId === undefined ? 'core' : 'agents';
  // The last row the reader shows. A hook's own row is not one, so it links to the row it ran beside.
  let lastShown;

  for (const row of rows(path)) {
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) continue;
    const uuid = typeof row.uuid === 'string' && row.uuid !== '' ? row.uuid : undefined;
    if (uuid !== undefined && (row.type === 'assistant' || row.type === 'user')) lastShown = uuid;

    if (row.type === 'assistant') {
      const message = row.message ?? {};
      // One model request is written as several lines, one per content block, under one message id.
      if (typeof message.id === 'string') {
        if (!requests.has(message.id)) {
          if (agentId === undefined && typeof message.model === 'string') state.model = message.model;
          const request = { station: 'model', label: shortModel(message.model ?? 'model'), from, agentId, startedAt: ts, endedAt: ts, status: 'ok', uuid };
          requests.set(message.id, request);
          actions.push(request);
        }
        // The output count grows line by line; the last line of the request holds the whole of it.
        const said = describeUsage(message.usage);
        if (said !== '') requests.get(message.id).detail = said;
        // What the request read is how full the context window was when it ran. The main loop's only: a
        // subagent has a window of its own.
        const read = contextTokens(message.usage);
        if (agentId === undefined && read > 0) {
          requests.get(message.id).ctx = read;
          state.peak = Math.max(state.peak, read);
        }
      }
      for (const [block, part] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (part.type !== 'tool_use') continue;
        const { station, label } = classifyCall(String(part.name), part.input ?? {}, setup);
        // `step` is the model request the call came from: calls of one step went out together.
        const action = enrich({ station, label, from, agentId, startedAt: ts, status: 'ok', tool: String(part.name), uuid, block, step: typeof message.id === 'string' ? message.id : undefined }, describeTool(String(part.name), part.input ?? {}, {}, station));
        open.set(part.id, { action, input: part.input ?? {} });
        actions.push(action);
      }
      continue;
    }

    if (row.type === 'user') {
      const content = row.message?.content;
      const parts = Array.isArray(content) ? content : [];
      let answered = false;
      for (const part of parts) {
        if (part.type !== 'tool_result') continue;
        answered = true;
        const call = open.get(part.tool_use_id);
        if (call === undefined) continue;
        const { action } = call;
        action.endedAt = ts;
        if (part.is_error === true) action.status = 'err';
        // The answer says what the question could not: the lines an edit changed, the call id a search was given.
        enrich(action, describeTool(action.tool, call.input, { text: resultText(part.content), meta: row.toolUseResult }, action.station));
        open.delete(part.tool_use_id);
      }
      const hasText = typeof content === 'string' ? content.trim() !== '' : parts.some(p => p.type === 'text');
      // A subagent's "user" lines are its parent's prompts, not the person.
      if (agentId === undefined && !answered && hasText && row.isMeta !== true) {
        actions.push(arrival(content, setup, ts, uuid));
      }
      continue;
    }

    const hook = row.type === 'attachment' ? String(row.attachment?.type ?? '') : '';
    if (hook.startsWith('hook')) {
      const name = String(row.attachment?.hookName ?? row.attachment?.hookEvent ?? 'hook');
      actions.push({ station: 'hooks', label: name, from, agentId, startedAt: ts, endedAt: ts, status: hook.includes('error') ? 'err' : 'ok', uuid: lastShown, detail: describeHook(row.attachment) });
    }
  }

  // A call with no answer in the file keeps no end, so it reads as still running.
  state.unanswered += open.size;
}

export function claudeActions(transcriptPath, setup) {
  const actions = [];
  const state = { model: undefined, unanswered: 0, peak: 0 };
  readClaude(transcriptPath, undefined, setup, actions, state);

  // Claude Code writes each subagent's own transcript under <session>/subagents/.
  const subagents = join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents');
  // A subagent's calls are read from its own file, so that file is where the reader shows them.
  const agents = {};
  if (existsSync(subagents)) {
    for (const name of readdirSync(subagents)) {
      const m = /^agent-(.+)\.jsonl$/.exec(name);
      if (m === null) continue;
      agents[m[1]] = join(subagents, name);
      readClaude(agents[m[1]], m[1], setup, actions, state);
    }
  }

  // A report sent in the same step as other work rode beside it: the step went to that work, not to the person.
  const steps = new Map();
  for (const a of actions) {
    if (a.step === undefined) continue;
    const key = `${a.agentId ?? ''}\0${a.step}`;
    steps.set(key, (steps.get(key) ?? false) || a.station !== 'tells');
  }
  for (const a of actions) {
    if (a.station === 'tells' && a.step !== undefined && steps.get(`${a.agentId ?? ''}\0${a.step}`) === true) a.aside = true;
    delete a.step;
  }

  // A subagent's row says how much it did: the calls read from its own transcript.
  const calls = {};
  for (const a of actions) if (a.agentId !== undefined && a.tool !== undefined) calls[a.agentId] = (calls[a.agentId] ?? 0) + 1;
  for (const a of actions) {
    if (a.spawned === undefined) continue;
    // A finished subagent reports its own count; one still running, or run in the background, does not.
    if (calls[a.spawned] !== undefined && !/tool uses?\b/.test(a.detail ?? '')) a.detail = [a.detail, `${calls[a.spawned]} calls so far`].filter(Boolean).join(' · ');
    if (agents[a.spawned] === undefined) delete a.spawned;
  }

  actions.sort((a, b) => a.startedAt - b.startedAt);
  return { actions, model: state.model, agents, context: claudeWindow(state.model, state.peak), sessionId: basename(transcriptPath, '.jsonl'), notes: { subagent_transcripts: Object.keys(agents).length, unanswered: state.unanswered } };
}

// ─── Codex ──────────────────────────────────────────────────────────────────
//
// Codex writes each finished item as an `item_completed` event with a type of
// its own, a status and usually a duration, so a start is the completion less
// the duration.
//
// The reader does not show those events. It shows the model's own rows
// (`response_item`), and a tool item's id (`exec-…`) appears in none of them.
// So an item links to the last row the reader shows before it. Measured on one
// 303-item session, that row was the model call the item ran inside for 254
// items; the other 49 were commands that outlived their call, and the row was
// that call's answer or the message after it.
const CODEX_CALLS = new Set(['function_call', 'custom_tool_call']);
const CODEX_SHOWN = new Set([...CODEX_CALLS, 'function_call_output', 'custom_tool_call_output', 'message', 'agent_message']);

const durationMs = d => (d && typeof d === 'object' ? (Number(d.secs) || 0) * 1000 + (Number(d.nanos) || 0) / 1e6 : 0);

function parseObject(value) {
  if (value && typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value ?? ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

export function codexActions(rolloutPath, setup) {
  const actions = [];
  const unknownItems = {};
  let model;
  let subagent = false;
  let sessionId;
  let lastShown;
  let window;
  let lastModelAction;

  for (const row of rows(rolloutPath)) {
    const ts = Date.parse(row.timestamp);
    if (!Number.isFinite(ts)) continue;

    if (row.type === 'response_item') {
      const p = row.payload ?? {};
      // The reader keys a row on its id, and only a call without one on its call_id.
      const shown = [p.id, CODEX_CALLS.has(p.type) ? p.call_id : ''].find(v => typeof v === 'string' && v !== '');
      if (CODEX_SHOWN.has(p.type) && shown !== undefined) lastShown = shown;
      continue;
    }

    if (row.type === 'session_meta') {
      // A guardian review or a spawned agent has a rollout of its own; its work belongs to the Agents station.
      subagent = row.payload?.source?.subagent !== undefined;
      if (typeof row.payload?.id === 'string') sessionId = row.payload.id;
      continue;
    }
    const from = subagent ? 'agents' : 'core';
    const push = (station, label, startedAt, status = 'ok', more = {}, found = null) => actions.push(enrich({ station, label, from, startedAt, endedAt: ts, status, uuid: lastShown, block: 0, ...more }, found));

    if (row.type === 'turn_context') {
      if (typeof row.payload?.model === 'string') model = row.payload.model;
      continue;
    }
    // One usage record per model request: the nearest thing a rollout has to a model step.
    if (row.type === 'token_usage_record') {
      push('model', shortModel(model ?? 'model'), ts, 'ok', {}, { detail: describeUsage(row.payload?.usage) });
      lastModelAction = subagent ? undefined : actions[actions.length - 1];
      continue;
    }
    // Codex states both halves after each request: the tokens it had in context and the model's window.
    if (row.type === 'event_msg' && row.payload?.type === 'token_count') {
      const info = row.payload.info ?? {};
      const read = Number(info.last_token_usage?.input_tokens);
      if (Number.isFinite(Number(info.model_context_window)) && Number(info.model_context_window) > 0) window = Number(info.model_context_window);
      if (lastModelAction !== undefined && Number.isFinite(read) && read > 0) lastModelAction.ctx = read;
      continue;
    }
    if (row.type !== 'event_msg' || row.payload?.type !== 'item_completed') continue;

    const item = row.payload.item ?? {};
    const startedAt = ts - durationMs(item.duration);
    const status = item.status === 'failed' ? 'err' : 'ok';
    switch (item.type) {
      case 'UserMessage':
        if (!subagent) {
          const uuid = typeof item.id === 'string' && item.id !== '' ? item.id : undefined;
          if (uuid !== undefined) lastShown = uuid;
          actions.push(arrival(item.content, setup, ts, uuid));
        }
        break;
      case 'CommandExecution': {
        // The command arrives as the argv Codex ran: ["/bin/zsh", "-lc", "<the line>"].
        const command = Array.isArray(item.command) ? String(item.command.at(-1) ?? '') : String(item.command ?? '');
        const c = classifyCall('Bash', { command }, setup);
        push(c.station, c.label, startedAt, status, { tool: 'exec_command' }, describeCodexItem(item, c.station));
        break;
      }
      case 'McpToolCall': {
        const c = toTells(classify(`mcp__${item.server}__${item.tool}`, parseObject(item.arguments), setup));
        push(c.station, c.label, startedAt, status, { tool: `${item.server}.${item.tool}` }, describeCodexItem(item, c.station));
        break;
      }
      case 'FileChange': {
        const paths = Object.keys(parseObject(item.changes));
        const c = classify('Edit', { file_path: paths[0] ?? '' }, setup);
        push(c.station, paths.length > 1 ? `${c.label} +${paths.length - 1}` : c.label, startedAt, status, { tool: 'apply_patch' }, describeCodexItem(item, c.station));
        break;
      }
      case 'ImageView': {
        const c = classify('Read', { file_path: String(item.path ?? '') }, setup);
        push(c.station, c.label, startedAt, 'ok', { tool: 'view_image' }, describeCodexItem(item, c.station));
        break;
      }
      case 'Extension': {
        const kind = String(item.kind ?? '');
        if (kind.startsWith('web')) push('web', hostOf(parseObject(item.action).url) || setup.t.webSearch, startedAt, 'ok', { tool: kind }, describeCodexItem(item, 'web'));
        else unknownItems[`Extension:${kind}`] = (unknownItems[`Extension:${kind}`] ?? 0) + 1;
        break;
      }
      case 'ContextCompaction':
        push('model', 'compaction', ts);
        break;
      case 'Reasoning':
      case 'AgentMessage':
        // Parts of a model request already counted by its usage record.
        break;
      default:
        unknownItems[String(item.type)] = (unknownItems[String(item.type)] ?? 0) + 1;
    }
  }

  actions.sort((a, b) => a.startedAt - b.startedAt);
  return { actions, model, sessionId, context: window === undefined ? null : { window, source: 'recorded' }, notes: { subagent_thread: subagent, unknown_items: unknownItems } };
}

// ─── One session, either provider ───────────────────────────────────────────

/** A Codex rollout opens with a `session_meta` row; a Claude transcript never has one. */
export function providerOfTranscript(path) {
  for (const row of rows(path)) return row.type === 'session_meta' || row.payload !== undefined ? 'codex' : 'claude';
  return 'claude';
}

/**
 * The whole of one session as the map needs it. An action carries one clipped,
 * credential-masked line about its call, never a result or a file's contents.
 * What the call returned is one link away, in the reader, at the action's
 * `uuid`; `agents` names each subagent's transcript for the same link.
 */
export function sessionFlowmap(transcriptPath) {
  const provider = providerOfTranscript(transcriptPath);
  const setup = setupFrom(FLOWMAP_OPTIONS);
  const read = provider === 'codex' ? codexActions(transcriptPath, setup) : claudeActions(transcriptPath, setup);
  const { actions } = read;
  const totals = tally(actions);
  const last = actions.reduce((max, a) => Math.max(max, a.endedAt ?? a.startedAt), 0);
  return {
    provider,
    model: read.model ?? null,
    span: actions.length === 0 ? null : { first: actions[0].startedAt, last },
    // Stations the session used at all. The map leaves the others undrawn.
    present: STATIONS.map(s => s.id).filter(id => totals[id] !== undefined),
    totals,
    actions,
    agents: read.agents ?? {},
    // The model's context window, for the ring round the core. Each main-loop model action carries `ctx`, the
    // tokens its request read. `source` is `recorded` when the transcript states the window and `inferred` when not.
    context: read.context ?? null,
    // The id the Memory Desk knows this session by: its file review and recall views are addressed with it.
    session_id: read.sessionId ?? null,
    notes: read.notes,
  };
}
