// One colour per kind of work, shared by every drawing of a session: the hub,
// the head, the ribbon, the tape and the pane's station buttons.
//
// Five hues and two neutrals. Red is not among them: it means a call failed and
// nothing else. The hues differ in lightness as well as hue, because hues of one
// lightness collapse for a red-green colour-blind reader: at equal lightness the
// two closest hues measured 1.0 apart for a deuteranope (OKLab distance x100,
// Machado 2009 simulation), and 6.3 as they are now. tests/unit/flowmap-directions.test.js
// holds the floor.
//
// Measured on the map's ground #0a0a0f: contrast, then the distance to the nearest
// other family for normal, protan and deutan vision.
//
//   you     #edf0f5  17.29   14.9 own      14.7 own      15.0 own
//   own     #b9c0cb  10.78   14.9 you      11.6 out      14.8 memory
//   files   #b99558   7.06   13.7 memory    7.3 memory    9.8 memory
//   shell   #96cc3a  10.34   16.5 files    14.7 files    10.0 files
//   out     #4ba4de   7.21   12.0 memory   11.0 agents    6.3 agents
//   memory  #4ea48f   6.61   12.0 out       7.3 files     9.8 files
//   agents  #9174d9   5.36   13.9 out      11.0 out       6.3 out
//
// Red #ffa2a6 is 12.0 / 6.0 / 6.0 from its nearest, the grey of `own`; a failed
// cell is also taller than any call, so that pair never rests on colour.
// Files and Shell alternate more than any other two stations, and are 16.5 / 14.7 / 10.0 apart.
//
// These colour marks, never letters: a name beside a mark is drawn in the map's own ink.

import { LIGHT } from './palette.js'

/** The colour of each family, and of a failed call. */
export const KIND = {
  you: '#edf0f5',
  own: '#b9c0cb',
  files: '#b99558',
  shell: '#96cc3a',
  out: '#4ba4de',
  memory: '#4ea48f',
  agents: '#9174d9',
}
export const FAULT = '#ffa2a6'

/**
 * The same families on the light ground: the marks are darker, so each still holds against #f5f2ea (a mark, never a
 * letter, but the failed call's count is lettered in it, so FAULT is the light palette's own red, 8:1).
 */
export const LIGHT_KIND = {
  you: '#1f2228',
  own: '#5f6570',
  files: '#a8741a',
  shell: '#4f7a0a',
  out: '#1f6fb0',
  memory: '#177a6c',
  agents: '#6a4cc0',
}
export const LIGHT_FAULT = '#812a1c'

/** The family colours and the failed call's colour that go with a palette: the light ones on the light ground. */
export const inkOf = palette => (palette.ground === LIGHT.ground ? { KIND: LIGHT_KIND, FAULT: LIGHT_FAULT } : { KIND, FAULT })

/** The families in the order a key lists them. */
export const FAMILIES = ['you', 'files', 'shell', 'out', 'memory', 'agents', 'own']

export const FAMILY_NAMES = { you: 'You', files: 'Files', shell: 'Shell', out: 'Network and browser', memory: 'Memory', agents: 'Agents', own: 'Model, skills, hooks' }

/**
 * By place: a station has one colour, so the hub is its own key.
 * `screen` is the person's own running things (their Chrome, their tabs, their terminal): the person's side.
 */
const PLACE = {
  you: 'you',
  tells: 'you',
  screen: 'you',
  model: 'own',
  skills: 'own',
  hooks: 'own',
  memory: 'memory',
  files: 'files',
  shell: 'shell',
  web: 'out',
  browser: 'out',
  agents: 'agents',
}

/**
 * By what the head does with it: the organs of portrait.js. The eye takes in (the network, a browser, a file
 * read), the hand acts (a command, an edit), so Files is two colours here and Shell shares one with an edit.
 */
function headFamily(action) {
  switch (action.station) {
    case 'you':
    case 'tells':
      return 'you'
    case 'model':
    case 'skills':
    case 'hooks':
      return 'own'
    case 'memory':
      return 'memory'
    case 'agents':
      return 'agents'
    case 'web':
    case 'browser':
    case 'screen':
      return 'out'
    case 'files':
      return action.op === 'edit' || action.op === 'write' ? 'shell' : 'out'
    default:
      return 'shell'
  }
}

/** The family of one action. `model` is `place` (the hub's key) or `head` (the portrait's). */
export function familyOf(action, model = 'place') {
  if (action.agentId !== undefined && model === 'head') return 'agents'
  return model === 'head' ? headFamily(action) : (PLACE[action.station] ?? 'shell')
}

/** The family of a station, by place. */
export const familyOfStation = station => PLACE[station] ?? 'shell'

/** The head's regions in the same colours, for a portrait drawn as a key. */
export const HEAD_HUES = {
  ear: KIND.you,
  mouth: KIND.you,
  eye: KIND.out,
  hand: KIND.shell,
  hippocampus: KIND.memory,
  peers: KIND.agents,
  cortex: KIND.own,
  cerebellum: KIND.own,
  brainstem: KIND.own,
}

// ─── Who started it ─────────────────────────────────────────────────────────

/**
 * A transcript files everything that arrives in the person's turn as the person's. Much of it is not:
 * a background task reporting back, the harness adding a reminder, a summary written at a compaction.
 * On one 1,192-call session 11 of 55 such rows were not typed by anyone.
 *
 *   person   typed it: a message, a slash command, a shell line, an interruption
 *   task     the agent's own background work, or another session, reporting back
 *   harness  the program around the agent: a reminder, a continuation summary, a command's echo
 */
export function starterOf(text) {
  const head = String(text ?? '').trimStart().slice(0, 64)
  // A linked session's report arrives wrapped as a reminder: it is another agent reporting back, not the harness.
  if (/^<task-notification>|^<system-reminder>\s*The session "/.test(head)) return 'task'
  if (/^<system-reminder>|^<local-command-stdout>|^<local-command-stderr>|^This session is being continued|^Caveat: /.test(head)) return 'harness'
  return 'person'
}

/**
 * What a wake is called in a row or a caption. The text that arrived is markup written for the agent
 * (`<task-notification> <task-id>…`), and a task's summary or output never reaches a label.
 */
export function wakeLabel(text) {
  const all = String(text ?? '')
  const head = all.trimStart().slice(0, 400)
  if (/^<task-notification>/.test(head)) {
    const id = /<task-id>([\w-]{1,64})<\/task-id>/.exec(all)?.[1]
    const status = /<status>(\w{1,24})<\/status>/.exec(all)?.[1]
    return `Background task${id ? ` ${id}` : ''} ${status ?? 'reported'}`
  }
  const session = /^<system-reminder>\s*The session "([^"]{1,60})/.exec(head)?.[1]
  if (session !== undefined) return `Session “${session}” reported back`
  if (/^This session is being continued/.test(head)) return 'Continued from a summary of the conversation'
  if (/^<local-command-std(?:out|err)>/.test(head)) return 'Output of a command the person ran'
  return 'Reminder from the harness'
}

// ─── The person's own running things ────────────────────────────────────────

/**
 * Tools that read or act in what the person has open: their own Chrome, their live tabs and history,
 * their terminal panel, their desktop. The built-in browser pane is the agent's own and is not here.
 */
const SCREEN_TOOL = /^mcp__(?:claude-in-chrome|tabtopia|browsing-context|terminal|computer-use|desktop-control)__/

export const isScreen = action => typeof action.tool === 'string' && action.agentId === undefined && SCREEN_TOOL.test(action.tool)

/**
 * The same actions with the person's own running things at their own station, `screen`.
 * The server still files them under Browser, Network and Shell; this is the candidate reading.
 */
export function seatScreen(actions) {
  return actions.map(a => (isScreen(a) ? { ...a, station: 'screen' } : a))
}
