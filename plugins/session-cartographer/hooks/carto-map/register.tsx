import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Entry, StationId, Status, Visit } from '../../types'
import { STATIONS, classify, clean, describeNow, drawMap, firstLine, foldRows, formatMs, memoryIds, nowParts, setupFrom, shortModel, taskNotice, taskOf } from './map'
import type { Setup } from './map'
import { drawPicture, terminalPicture } from './terminal'
import { hubPicture, isAt, pictureWidth, ribbonRuns, ribbonSlots, shownStation, slotRibbonPicture, themeFromConfig } from './hubview'
import type { HubStation } from './hubview'
import { isScreen } from './workmap/kinds.js'
import { SLOT_CALLS } from './workmap/ribbon.js'

const PANE = 'carto-map'
const KEEP = 80
/** A label longer than this may not fit a docked pane, so its row gets a control that opens it. */
const LONG_LABEL = 28
/** The least the time takes at the end of a row, so that short times line up: `107 ms`. A longer one widens its own row. */
const TIME_COLUMN = 6
const CREW = 12
/** Pages kept for the Network and Browser lists. A long session visits a few hundred. */
const VISITS = 300
/**
 * Where Session Cartographer's Explorer listens. The pane links there for the whole of a session.
 * Spelled `localhost`: the desktop surface makes a link only of an https address or of http://localhost.
 */
const EXPLORER = 'http://localhost:2527'

/** How long an answer about the Explorer is good for, in ms. */
const EXPLORER_EVERY = 60_000
/**
 * Whether the Explorer answered when it was last asked, and when that was. The pane offers a way there only while
 * it does (the owner, 2026-11-14: "this should be contingent on the user having explorer running"). It is asked
 * beside the session's own events and never while drawing, so neither a call nor the pane waits on it.
 */
let explorer = { isUp: false, askedAt: -EXPLORER_EVERY }

// Change the tag when a field of Entry or Board changes its meaning or is taken away: it declines what an earlier
// version stored, and with it the session's counts. A field only added, and optional, needs no new tag.
const board = atom({ plugin: 'session-cartographer', key: 'board' } as const, { entries: [], counts: {} } as Board, { shape: 'board-5' })

/** The name of the station lot-map does not have. English only: the other six languages of text.ts have no word for it yet. */
const SCREEN_NAME = 'Your screen'
/** The desktop app's tools for other sessions share a server prefix with its reports to the person, which lot-map files under You. They are work with other agents. */
const SESSION_TOOLS = /__ccd_session_mgmt__|__ccd_window__|__ccd_sidebar__/
/** When the drawing is asked to cool after the newest call, in ms: a station's light is mostly gone by the first, a leg of the route by the last. */
const COOL_AT = [6_000, 20_000, 61_000]

const newId = (now: number): string => `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** Whatever goes wrong on the map must never reach the tool, the turn or the conversation. */
async function quietly<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}

/** A web address as the list shows it: http or https, with a login in it dropped. */
function addressOf(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const found = /^(https?:\/\/)(?:[^\s/@]*@)?([^\s@]+)$/i.exec(raw.trim())
  return found === null ? undefined : `${found[1]}${found[2]}`.slice(0, 500)
}

/** The addresses one call went to: its own `url`, and those of the steps of a batch. */
function addressesOf(input: Record<string, unknown>): string[] {
  const steps = Array.isArray(input.actions) ? input.actions : []
  const all = [input.url, ...steps.map(step => (step as { input?: { url?: unknown } } | null)?.input?.url)]
  return all.map(addressOf).filter((url): url is string => url !== undefined)
}

/** Whether the desktop surface will make a link of the address. Any other is shown as text, to be read or copied. */
const isLinkable = (url: string): boolean => /^https:\/\//i.test(url) || /^http:\/\/localhost(?=[:/?#]|$)/i.test(url)

/** The calls that change a file, and where each says which. The Explorer reviews a file a session changed, not one it only read. */
const EDITS: Readonly<Record<string, string>> = { Edit: 'file_path', MultiEdit: 'file_path', Write: 'file_path', NotebookEdit: 'notebook_path' }

/** The file a call changed, as an absolute path; nothing for any other call. */
function editedFile(tool: string, input: Record<string, unknown>): string | undefined {
  const field = EDITS[tool]
  const path = field === undefined ? undefined : input[field]
  return typeof path === 'string' && path.startsWith('/') && path.length <= 1000 ? path : undefined
}

/** The Explorer's review of what a session changed in one file. It answers for files under the Explorer's own root. */
const reviewLink = (sessionId: string, path: string): string => `${EXPLORER}/memory?session=${encodeURIComponent(sessionId)}&file=${encodeURIComponent(path)}&review=changes`

/** The address without its scheme, for a row: the host and the path are what tell two pages apart. */
const shortAddress = (url: string): string => url.replace(/^https?:\/\//i, '').replace(/\/$/, '')

type Start = {
  station: StationId
  label: string
  from?: Entry['from']
  status?: Status
  agentId?: string
  mark?: Entry['mark']
  /** Adds nothing to the station's count: a second view of something already counted. */
  uncounted?: boolean
  yours?: true
  wake?: 'task'
  href?: string
  startedAt?: number
  endedAt?: number
  patch?: Partial<Pick<Board, 'model' | 'step' | 'switchedAt'>>
}

/** The newest rows, and beside them every background task still going, however long ago it started. */
const kept = (entries: Entry[]): Entry[] => {
  const from = entries.length - KEEP
  return from <= 0 ? entries : entries.filter((e, i) => i >= from || (e.status === 'run' && e.task !== undefined))
}

const isFault = (status: Status): boolean => status === 'err' || status === 'block'

const oneMore = (faults: Board['faults'], station: StationId): Board['faults'] => ({ ...faults, [station]: (faults?.[station] ?? 0) + 1 })

/** Asks the Explorer whether it is there, at most once a minute, and redraws the pane when the answer changed. */
async function askExplorer($: EngineInterface): Promise<void> {
  await quietly(async () => {
    const now = await $.clock.now()
    if (now - explorer.askedAt < EXPLORER_EVERY) return
    const was = explorer.isUp
    explorer = { isUp: was, askedAt: now }
    // Its health answer names the logs it reads: some other program on the port does not pass for it.
    // It listens on 127.0.0.1 alone, and a host that takes `localhost` for ::1 would find nothing there: the number
    // is asked first, the name after.
    let isUp = false
    for (const at of ['http://127.0.0.1:2527', EXPLORER]) {
      isUp = (await quietly(async () => {
        const got = await $.http.fetch(`${at}/api/health`)
        return got.ok && got.text.includes('"changelog"')
      })) === true
      if (isUp) break
    }
    explorer = { isUp, askedAt: now }
    if (isUp !== was) await update($, board, b => ({ ...b, tick: (b.tick ?? 0) + 1 }))
  })
}

async function begin($: EngineInterface, start: Start): Promise<string | undefined> {
  return quietly(async () => {
    const now = await $.clock.now()
    const entry: Entry = {
      id: newId(now),
      station: start.station,
      label: clean(start.label),
      from: start.from ?? 'core',
      startedAt: start.startedAt ?? now,
      status: start.status ?? 'run',
      ...(start.status !== undefined ? { endedAt: start.endedAt ?? now } : {}),
      ...(start.agentId !== undefined ? { agentId: start.agentId } : {}),
      ...(start.mark !== undefined ? { mark: start.mark } : {}),
      ...(start.yours === true ? { yours: true as const } : {}),
      ...(start.wake !== undefined ? { wake: start.wake } : {}),
      ...(start.href !== undefined ? { href: start.href } : {}),
    }
    const isTold = entry.station === 'you' && entry.from !== 'inbound' && !start.uncounted
    await update($, board, b => ({
      ...b,
      ...start.patch,
      entries: kept([...b.entries, entry]),
      counts: start.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
      // What a hook brought to memory unasked is counted apart from what was asked for.
      ...(entry.station === 'memory' && entry.from === 'inbound' && !start.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
      // What the agent told the person is counted apart from what the person said, and a call into what the
      // person has open apart from the station lot-map files it under: the hub draws both readings' figures.
      ...(isTold ? { told: (b.told ?? 0) + 1 } : {}),
      ...(entry.yours === true && !start.uncounted ? { yours: { ...b.yours, [entry.station]: (b.yours?.[entry.station] ?? 0) + 1 } } : {}),
      // An interrupted turn lands on the person's own station and is no fault of anything.
      ...(isFault(entry.status) && entry.station !== 'you' ? { faults: oneMore(b.faults, entry.station) } : {}),
      ...(entry.agentId !== undefined && !(b.agents ?? []).includes(entry.agentId)
        ? { agents: [...(b.agents ?? []), entry.agentId].slice(-CREW) }
        : {}),
    }))
    return entry.id
  })
}

async function finish($: EngineInterface, id: string | undefined, status: Status, patch?: Pick<Board, 'context'>): Promise<void> {
  if (id === undefined) return
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => {
      const open = b.entries.find(e => e.id === id && e.status === 'run')
      return {
        ...b,
        ...patch,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(open !== undefined && isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** The call started work that goes on after it answered: its row stays open under the task's id. */
async function background($: EngineInterface, id: string | undefined, task: string): Promise<void> {
  if (id === undefined) return
  await quietly(() => update($, board, b => ({ ...b, entries: b.entries.map(e => (e.id === id && e.status === 'run' ? { ...e, task } : e)) })))
}

/** A background task ended: its row closes, as a fault when the task failed. */
async function settle($: EngineInterface, task: string, status: Status): Promise<void> {
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, board, b => {
      const open = b.entries.find(e => e.task === task && e.status === 'run')
      if (open === undefined) return b
      return {
        ...b,
        entries: b.entries.map(e => (e === open ? { ...e, status, endedAt: now } : e)),
        ...(isFault(status) ? { faults: oneMore(b.faults, open.station) } : {}),
      }
    })
  })
}

/** How full the context window is, as the status line has it; costs nothing. */
async function contextOf($: EngineInterface): Promise<Pick<Board, 'context'>> {
  const percent = await quietly(async () => (await $.session.usage()).context.percent)
  return typeof percent === 'number' ? { context: percent } : {}
}

/** What a settings hook added to the context: shown as the hook acting and, when it brought records, as memory. */
async function noteContext($: EngineInterface, context: readonly string[] | undefined, when: string, setup: Setup): Promise<void> {
  const { t } = setup
  const text = (context ?? []).join('\n')
  if (text.trim() === '') return
  const ids = setup.hookRecords ? memoryIds(text) : []
  if (ids.length === 0) {
    await begin($, { station: 'hooks', label: t.addedContext(when), status: 'ok' })
    return
  }
  await begin($, { station: 'hooks', label: t.addedMemory(when), status: 'ok' })
  const shown = ids.slice(0, 6).map(id => `#${id}`).join(' ')
  await begin($, {
    station: 'memory',
    label: t.records(ids.length, `${shown}${ids.length > 6 ? ' …' : ''}`),
    from: 'inbound',
    status: 'ok',
  })
}

// The hub is drawn when the board changes, and a station's light and a leg of the route are worked out from how
// long ago a call was. With nothing new the picture would stay lit for as long as the session sat idle, so each
// call books a few later redraws, and a newer call books its own in their place.
let cooling: { cancel: () => void }[] = []

function cool($: EngineInterface): void {
  for (const timer of cooling) timer.cancel()
  cooling = []
  try {
    cooling = COOL_AT.map(ms => $.clock.after(ms, () => void quietly(() => update($, board, b => ({ ...b, tick: (b.tick ?? 0) + 1 })))))
  } catch {
    cooling = []
  }
}

export const register: Register = (on, options) => {
  // The pane ships inside Session Cartographer, whose other parts (recall, the hooks, the Explorer) a person may want
  // without it. Off, this module hooks nothing.
  if ((options as { workMap?: unknown }).workMap === false) return

  const setup = setupFrom(options)
  const { t } = setup

  // The feed's second column fits the longest station name of the language.
  const column = Math.max(8, ...Object.values(t.stations).map(name => name.length))

  // Calls a settings hook refused, so that the tool's own row reads as blocked and not as an error.
  // Loses nothing across a reload that matters: a reload never lands in the middle of a call.
  const refused = new Set<string>()

  // The model the main loop last ran on: in this session, or else in the last session in this folder.
  // The one thing the map keeps between sessions, and only its name.
  let lastModel: string | undefined
  let modelKey = 'model'

  // In a terminal, the map's picture above the rows, for a person who asked for it.
  const picture = terminalPicture(setup)

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'carto-map', description: t.command }))
    void quietly(() => $.ui.open({ id: PANE, title: t.title }))
    void askExplorer($)
    await quietly(async () => {
      modelKey = `model:${e.cwd}`
      const kept = await $.store.get(modelKey)
      if (lastModel === undefined && typeof kept === 'string') lastModel = kept
    })
    return next(e)
  })

  on('command.run', { command: 'carto-map' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: t.title })
    return { text: opened.isPlaced ? t.opened : t.cannotOpen(String(opened.reason)) }
  })

  on('turn.start', async ($, e, next) => {
    void askExplorer($)
    const notice = e.agentId === undefined ? taskNotice(e.text) : undefined
    if (notice !== undefined) {
      // A background task reporting back is no message of the person's. It did wake the agent, and the hub starts
      // a stretch of the route there, from Hooks, as it starts one from You at a message.
      if (notice.status !== undefined) await settle($, notice.id, notice.status)
      await begin($, { station: 'hooks', label: 'background task reported', from: 'inbound', status: 'ok', wake: 'task' })
      cool($)
    } else if (e.agentId === undefined && e.text !== '') {
      // A new message clears what went wrong on the way to the last answer.
      await quietly(() => update($, board, b => (b.faults === undefined ? b : { ...b, faults: {} })))
      await begin($, { station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' })
      cool($)
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain && lastModel !== e.model) {
      const before = lastModel
      lastModel = e.model
      void quietly(() => $.store.set(modelKey, e.model))
      if (before !== undefined) {
        const now = await quietly(() => $.clock.now())
        await begin($, {
          station: 'model',
          label: `${shortModel(before)} → ${shortModel(e.model)}`,
          status: 'ok',
          mark: 'switch',
          uncounted: true,
          ...(now !== undefined ? { patch: { switchedAt: now } } : {}),
        })
      }
    }
    const id = await begin($, {
      station: 'model',
      label: `${shortModel(e.model)} · ${t.step(e.index + 1)}${isMain ? '' : ` · ${t.subagent}`}`,
      from: isMain ? 'core' : 'agents',
      ...(isMain ? { patch: { model: e.model, step: e.index + 1 } } : { agentId: e.agentId }),
    })
    try {
      return yield* next(e)
    } finally {
      await finish($, id, 'ok', isMain ? await contextOf($) : undefined)
    }
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      // A subagent's loop is over: it leaves the agents station, and a call of its that never reported back is settled.
      const agentId = e.agentId
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          agents: (b.agents ?? []).filter(id => id !== agentId),
          entries: b.entries.map(x => (x.status === 'run' && (x.agentId === agentId || x.task === agentId) ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    } else {
      await begin($, {
        station: 'you',
        label: e.isAborted ? t.turnAborted : t.answerReady,
        status: e.isAborted ? 'err' : 'ok',
        ...(e.isAborted ? {} : { mark: 'done' as const }),
      })
      // An interrupted call never reports back; left alone its row would pulse for the rest of the session.
      await quietly(async () => {
        const now = await $.clock.now()
        await update($, board, b => ({
          ...b,
          entries: b.entries.map(x => (x.status === 'run' && x.from === 'core' && x.task === undefined ? { ...x, status: 'ok' as const, endedAt: now } : x)),
        }))
      })
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = await quietly(async () => {
      const input = e as unknown as Record<string, unknown>
      const found = classify(e.tool, input, setup)
      const seen = found.station === 'you' && SESSION_TOOLS.test(e.tool) ? { ...found, station: 'agents' as const } : found
      // The main loop reading or acting in what the person has open: their own Chrome, tabs, terminal, desktop.
      const yours = e.agentId === undefined && isScreen({ tool: e.tool })
      // The pages the call went to are kept for the Network, Browser and Your screen lists.
      let href: string | undefined
      if (seen.station === 'web' || seen.station === 'browser' || yours) {
        const station = yours ? ('screen' as const) : (seen.station as 'web' | 'browser')
        const urls = addressesOf(input)
        if (urls.length > 0) {
          const at = await $.clock.now()
          await update($, board, b => ({ ...b, visits: [...(b.visits ?? []), ...urls.map((url): Visit => ({ station, url, at }))].slice(-VISITS) }))
        }
        // The row is a link to the page it went to: the first of a batch's.
        href = urls.find(isLinkable)
      }
      // A row that changed a file is a link to the Explorer's review of that file in this session.
      const file = seen.station === 'files' ? editedFile(e.tool, input) : undefined
      if (file !== undefined) {
        const sessionId = await quietly(() => $.session.id())
        if (typeof sessionId === 'string' && sessionId !== '') href = reviewLink(sessionId, file)
      }
      const id = await begin($, { ...seen, ...(href !== undefined ? { href } : {}), ...(yours ? { yours: true as const } : {}), ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
      cool($)
      void askExplorer($)
      return id
    })
    try {
      const ran = await next(e)
      const wasRefused = ran.deny !== undefined || (e.tool_use_id !== undefined && refused.delete(e.tool_use_id))
      const task = wasRefused || ran.isError === true ? undefined : taskOf(ran.result)
      if (task !== undefined) {
        await background($, id, task)
        return ran
      }
      await finish($, id, wasRefused ? 'block' : ran.isError === true ? 'err' : 'ok')
      return ran
    } catch (failure) {
      await finish($, id, 'err')
      throw failure
    }
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const startedAt = (await quietly(() => $.clock.now())) ?? 0
    const decided = await next(e)
    const endedAt = (await quietly(() => $.clock.now())) ?? startedAt
    if (decided.deny !== undefined) {
      if (e.tool_use_id !== undefined) refused.add(e.tool_use_id)
      await begin($, { station: 'hooks', label: (setup.hookReasons ? firstLine(decided.deny) : '') || t.stopped(e.tool), status: 'block', startedAt })
    } else if (decided.ask !== undefined) {
      await begin($, { station: 'hooks', label: t.askedPermission(e.tool), status: 'ok', startedAt, endedAt })
    } else if (endedAt - startedAt >= 400) {
      // A check that took a moment is worth seeing; the instant ones are not.
      await begin($, { station: 'hooks', label: t.checkBefore(e.tool), status: 'ok', startedAt, endedAt })
    }
    return decided
  })

  // A notification delivered into a running turn starts no turn of its own; this is where it is seen.
  on('prompt.submit', async ($, e, next) => {
    await quietly(async () => {
      if (e.origin?.kind !== 'task-notification') return
      const notice = taskNotice(e.text)
      if (notice?.status !== undefined) await settle($, notice.id, notice.status)
    })
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.toMessage, setup)
    return result
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    await noteContext($, result.additionalContext, t.atStart, setup)
    return result
  })

  on('skill.prompt', async ($, e, next) => {
    const result = await next(e)
    // A skill the model called is already on the map as its tool call; this one catches a typed slash command.
    await quietly(async () => {
      const now = await $.clock.now()
      await update($, board, b => {
        const label = clean(e.skill)
        if (b.entries.some(x => x.station === 'skills' && x.status === 'run' && x.label === label)) return b
        const entry: Entry = { id: newId(now), station: 'skills', label, from: 'core', startedAt: now, endedAt: now, status: 'ok' }
        return { ...b, entries: kept([...b.entries, entry]), counts: { ...b.counts, skills: (b.counts.skills ?? 0) + 1 } }
      })
    })
    return result
  })

  on('session.compact', async ($, e, next) => {
    const id = await begin($, { station: 'model', label: t.compacting })
    try {
      return await next(e)
    } finally {
      await finish($, id, 'ok', await contextOf($))
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const state = await read($, board)
    const now = await $.clock.now()
    const { Box, Text, Button } = $.ui.resolve(e)
    const size = setup.textSize
    // The desktop app's dim text measured 6.4:1 on its pane (#9c9c9c on #191919, a capture of 2026-11-14), under the
    // 8:1 this pane's words are held to. So only a terminal, whose dim is the person's own theme, dims anything here.
    const dims = e.surface === 'terminal'
    const { Link: RowLink } = e.surface === 'terminal' ? { Link: undefined } : $.ui.resolve(e)

    // How long each answer took, from the person's message to it: the one time a row of the moment has to show.
    const turnMs = new Map<string, number>()
    let askedAt: number | undefined
    for (const x of state.entries) {
      if (x.station === 'you' && x.from === 'inbound' && x.mark === undefined) askedAt = x.startedAt
      if (x.mark === 'done' && askedAt !== undefined) {
        turnMs.set(x.id, x.startedAt - askedAt)
        askedAt = undefined
      }
    }

    // A pressed station narrows the rows to its own. A station with nothing left to show is not held open.
    // On a terminal the stations are lot-map's; on the other surfaces they are the hub's, where a call into what
    // the person has open is Your screen's and not the station lot-map files it under.
    const isHub = e.surface !== 'terminal' && setup.theme !== 'light'
    // A station held narrows the rows to its own. Under the hub it is held by pressing a slot of the ribbon, and a
    // call into what the person has open is Your screen's; under lot-map's hub, by a station button.
    const shown = shownStation(state, isHub)
    const listed = shown === undefined ? state.entries : state.entries.filter(x => (isHub ? isAt(x, shown) : x.station === shown))

    // The pane holds the last rows of a live session. The Explorer holds all of it, and other sessions. The picture
    // takes no press (drawn in the desktop's frame for pictures, a link inside it went nowhere when the owner tried
    // one on 2026-11-14), so while the Explorer is running the way to a station there is its name at the head of
    // each of its rows, and one more link, the last thing in the pane, goes to the session's map whole.
    const sessionId = explorer.isUp && e.surface !== 'terminal' ? await quietly(() => $.session.id()) : undefined
    const there = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined

    const rows = foldRows(listed).map(({ entry, times, tookMs }) => {
      const isSwitch = entry.mark === 'switch'
      const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
      const whole = turnMs.get(entry.id)
      // A row of one moment (a message, what a hook added) took no time: its place in the column holds a dash.
      const took = entry.endedAt === undefined ? t.running : whole !== undefined && whole > 0 ? formatMs(whole, t) : tookMs > 0 ? formatMs(tookMs, t) : '—'
      const isMoment = took === '—'
      // Theme keys, so the rows read on a light theme as well as on a dark one.
      const color = isSwitch || entry.status === 'run' ? 'claude' : entry.status === 'ok' ? undefined : 'error'
      const where = isHub && entry.yours === true ? SCREEN_NAME : t.stations[entry.station]
      const head = `${mark} ${where.padEnd(column)} `
      const more = times > 1 ? `  +${times - 1}` : ''
      const line = `${head}${entry.label}${more}`
      const isDim = dims && entry.status === 'ok' && !isSwitch
      // Where the row went, if it went somewhere a press can follow: a page, or the Explorer's review of a file.
      // A link into the Explorer is one only while the Explorer is there to answer it.
      const href = RowLink !== undefined && entry.href !== undefined && isLinkable(entry.href) && (explorer.isUp || !entry.href.startsWith(`${EXPLORER}/`)) ? entry.href : undefined
      // One row of the pane a row of the feed: the words are cut at the edge, the time keeps a column of its own at the
      // right, so a long label neither wraps nor pushes the time about. A long one can be opened, one at a time.
      const isLong = entry.label.length > LONG_LABEL
      const isOpen = isLong && state.open === entry.id
      return (
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text mono size={size} color={color} dimColor={isDim} wrap={isOpen ? 'wrap' : 'truncate-end'}>
              {RowLink !== undefined && (href !== undefined || there !== undefined)
                ? [
                    `${mark} `,
                    there !== undefined ? (
                      <RowLink href={`${EXPLORER}/map?session=${encodeURIComponent(there)}&station=${isHub && entry.yours === true ? 'screen' : entry.station}`} label={where} />
                    ) : (
                      where
                    ),
                    `${' '.repeat(Math.max(0, column - where.length))} `,
                    href !== undefined ? <RowLink href={href} label={entry.label} /> : entry.label,
                    more,
                  ]
                : line}
            </Text>
          </Box>
          {isLong
            ? [
                <Button
                  key={`open-${entry.id}`}
                  plain
                  dimColor={dims}
                  label={isOpen ? '▾' : '▸'}
                  onPress={() => void quietly(() => update($, board, b => ({ ...b, open: isOpen ? undefined : entry.id })))}
                />,
              ]
            : []}
          <Box flexShrink={0} minWidth={TIME_COLUMN} justifyContent="flex-end">
            <Text mono tabular size={size} color={isMoment ? undefined : color} dimColor={isDim || (dims && isMoment)} wrap="truncate-end">
              {took}
            </Text>
          </Box>
        </Box>
      )
    })
    const feed = rows.length > 0 ? rows : [<Text dimColor={dims}>{t.nothingYet}</Text>]
    // What runs now at the left, cut if it must be. Where there is no drawing to say them, the context and the model
    // stand at the right, whole; beside the drawing they would be said a second time.
    const now2 = nowParts(state, t)
    const what = now2.what
    // lot-map's hub wrote the context figure and the model in its core. The hub drawn here has no words at a pane's
    // width, so on those surfaces too the line says them, the figure with its name.
    const figure = state.context === undefined ? '' : `${t.context} ${Math.round(state.context)}%`
    const model = state.model === undefined || state.entries.some(x => x.status === 'run' && x.station === 'model') ? '' : shortModel(state.model)
    const meter = e.surface === 'terminal' ? now2.meter : isHub ? [figure, model].filter(Boolean).join(' · ') : ''
    const current = (
      <Box flexDirection="row" gap={1} alignItems="flex-start">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text mono size={size} wrap="truncate-end">
            {what}
          </Text>
        </Box>
        {meter === ''
          ? []
          : [
              <Box flexShrink={0}>
                <Text mono tabular size={size} dimColor={dims}>
                  {meter}
                </Text>
              </Box>,
            ]}
      </Box>
    )

    if (e.surface === 'terminal') {
      const tally = STATIONS.filter(s => (state.counts[s.id] ?? 0) > 0).map(s => `${t.stations[s.id]} ${state.counts[s.id]}`).join(' · ')
      const map = picture === undefined ? undefined : await quietly(() => drawPicture($, e, state, now, picture))
      return (
        <Box flexDirection="column">
          {map !== undefined ? [map] : []}
          {current}
          <Text dimColor>{tally === '' ? t.noCounts : tally}</Text>
          {feed}
        </Box>
      )
    }

    const { Svg, Link } = $.ui.resolve(e)

    // lot-map's hub, which a light theme still gets, is one picture whose stations cannot be pressed. This row is
    // their press targets: one per station the session has used, with its count. Pressing one shows that station
    // alone; again, the whole feed. The hub drawn everywhere else says each station's name and count itself, and the
    // ribbon over it is the calls in order in the stations' colours, so there the row is gone (the owner, 2026-11-14:
    // "drop the legends").
    const names: Record<string, string> = { ...t.stations, screen: SCREEN_NAME }
    const stations = isHub
      ? []
      : STATIONS.filter(s => (state.counts[s.id] ?? 0) > 0).map(s => (
          <Button
            key={`station-${s.id}`}
            plain
            label={`${names[s.id]} ${state.counts[s.id] ?? 0}`}
            onPress={() => void quietly(() => update($, board, b => ({ ...b, shown: b.shown === s.id ? undefined : s.id })))}
          />
        ))

    // Network, Browser and Your screen open on the pages visited, newest first, each a link.
    const visits = shown === 'web' || shown === 'browser' || shown === 'screen' ? (state.visits ?? []).filter(v => v.station === shown).reverse() : []
    const pages = visits.map((visit, i) => (
      <Box key={`visit-${i}`} flexDirection="row" gap={1} alignItems="flex-start">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size={size} wrap="truncate-end">
            {isLinkable(visit.url) ? <Link href={visit.url} label={shortAddress(visit.url)} /> : shortAddress(visit.url)}
          </Text>
        </Box>
        <Box flexShrink={0} minWidth={TIME_COLUMN} justifyContent="flex-end">
          <Text mono tabular size={size} dimColor={dims} wrap="truncate-end">
            {formatMs(Math.max(0, now - visit.at), t)}
          </Text>
        </Box>
      </Box>
    ))

    // The arrow is the mark of a link that leaves the app.
    const beyond =
      there !== undefined
        ? [
            <Text key="explorer" size={size}>
              <Link href={`${EXPLORER}/map?session=${encodeURIComponent(there)}${shown !== undefined ? `&station=${shown}` : ''}`} label="↗ Explorer" />
            </Text>,
          ]
        : []
    // The pane's body scrolls as one piece and has no footer of its own. Made at least as tall as the room it is
    // given, with what is left over above the link, the link stands at the pane's bottom edge whenever the rest fits;
    // when the rest is taller than the pane it is the end of the scroll.
    const room = e.props.scroll?.bodyRows
    const tall = typeof room === 'number' && Number.isFinite(room) && room > 0 ? { minHeight: room } : {}

    // The drawing the Explorer's session map uses, from the same code: the ribbon of the last calls over the hub.
    // A person who set the light theme keeps lot-map's hub, which has light colours; the new one has none yet.
    const wide = pictureWidth(e.props.bodyColumns)
    // The pictures follow the app's own theme setting where it names a side; the map's own `theme` option, when set, wins.
    const side = setup.theme !== 'auto' ? setup.theme : themeFromConfig((await quietly(() => $.config.list()))?.find(row => row.key === 'theme')?.value)
    // The ribbon is a picture, and a picture takes no press; a Button on the desktop is drawn as its plain label, so
    // a coloured block cannot be one either. So the ribbon is drawn in slots of one width, a slot a run of calls at
    // one station, and under it stands a row of as many equal boxes, each with the control for the slot over it.
    // Pressing one narrows the feed to that slot's station; pressing a slot of the held station lets it go. A slot
    // is a fraction of the width in both, so they line up at any pane width. The mark is hollow, and solid under
    // the held station's runs; the two are one pair of one size (the smaller pair drew at two sizes in a render). A run that grows stays in its slot:
    // the slots move along only when the agent goes to another station.
    const slots = ribbonSlots(e.props.bodyColumns)
    const runs = isHub ? ribbonRuns(state, now, slots, shown) : []
    const press = (station: HubStation) => () => void quietly(() => update($, board, b => ({ ...b, shown: b.shown === station ? undefined : station })))
    const share = `${100 / slots}%`
    const targets = isHub
      ? [
          <Box key="ribbon-press" flexDirection="row" alignItems="flex-start">
            {Array.from({ length: slots }, (_, i) => {
              const run = runs[i - (slots - runs.length)]
              return (
                <Box key={`slot-${i}`} width={share} flexShrink={0} justifyContent="center" minWidth={0}>
                  {run === undefined ? [] : [<Button key={`ribbon-${run.key}`} plain label={run.station === shown ? '▲' : '△'} onPress={press(run.station)} />]}
                </Box>
              )
            })}
          </Box>,
        ]
      : []
    const calls = runs.reduce((n, run) => n + Math.min(run.cells.length, SLOT_CALLS), 0)
    const pictures = isHub
      ? [
          <Svg key="ribbon" source={slotRibbonPicture(runs, slots, wide, shown, side)} alt={`The last ${calls} calls in ${runs.length} runs, oldest to newest`} />,
          ...targets,
          <Svg
            key="hub"
            source={hubPicture(state, now, { names, coreName: setup.core, model: state.model === undefined ? '' : shortModel(state.model), motion: setup.motion, width: wide, theme: side, ...(shown !== undefined ? { pressed: shown } : {}) })}
            alt={`${t.title}. ${describeNow(state, t)}`}
          />,
        ]
      : [<Svg key="hub" source={drawMap(state, now, setup)} alt={`${t.title}. ${describeNow(state, t)}`} />]

    return (
      <Box flexDirection="column" {...tall}>
        {pictures}
        {current}
        {stations.length > 0
          ? [
              <Box key="stations" flexDirection="row" flexWrap="wrap" gap={1} alignItems="flex-start">
                {stations}
              </Box>,
            ]
          : []}
        {pages}
        {pages.length > 0 ? [] : feed}
        <Box key="rest" flexGrow={1} />
        {beyond}
      </Box>
    )
  })
}
