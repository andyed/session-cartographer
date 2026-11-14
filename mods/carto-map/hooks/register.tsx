import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Entry, StationId, Status, Visit } from '../types'
import { STATIONS, classify, clean, describeNow, drawMap, firstLine, foldRows, formatMs, memoryIds, nowParts, setupFrom, shortModel, taskNotice, taskOf } from './map'
import type { Setup } from './map'
import { drawPicture, terminalPicture } from './terminal'

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

// Change the tag when a field of Entry or Board changes: it declines what an earlier version stored.
const board = atom({ plugin: 'carto-map', key: 'board' } as const, { entries: [], counts: {} } as Board, { shape: 'board-4' })

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
    }
    await update($, board, b => ({
      ...b,
      ...start.patch,
      entries: kept([...b.entries, entry]),
      counts: start.uncounted ? b.counts : { ...b.counts, [entry.station]: (b.counts[entry.station] ?? 0) + 1 },
      // What a hook brought to memory unasked is counted apart from what was asked for.
      ...(entry.station === 'memory' && entry.from === 'inbound' && !start.uncounted ? { pushed: (b.pushed ?? 0) + 1 } : {}),
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

export const register: Register = (on, options) => {
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
    const notice = e.agentId === undefined ? taskNotice(e.text) : undefined
    if (notice !== undefined) {
      // A background task reporting back is no message of the person's.
      if (notice.status !== undefined) await settle($, notice.id, notice.status)
    } else if (e.agentId === undefined && e.text !== '') {
      // A new message clears what went wrong on the way to the last answer.
      await quietly(() => update($, board, b => (b.faults === undefined ? b : { ...b, faults: {} })))
      await begin($, { station: 'you', label: t.newMessage, from: 'inbound', status: 'ok' })
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
      const seen = classify(e.tool, input, setup)
      // The pages the call went to are kept for the Network and Browser lists.
      if (seen.station === 'web' || seen.station === 'browser') {
        const station = seen.station
        const urls = addressesOf(input)
        if (urls.length > 0) {
          const at = await $.clock.now()
          await update($, board, b => ({ ...b, visits: [...(b.visits ?? []), ...urls.map((url): Visit => ({ station, url, at }))].slice(-VISITS) }))
        }
      }
      return begin($, { ...seen, ...(e.agentId === undefined ? { from: 'core' as const } : { from: 'agents' as const, agentId: e.agentId }) })
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
    const shown = state.shown !== undefined && (state.counts[state.shown] ?? 0) > 0 ? state.shown : undefined
    const listed = shown === undefined ? state.entries : state.entries.filter(x => x.station === shown)

    const rows = foldRows(listed).map(({ entry, times, tookMs }) => {
      const isSwitch = entry.mark === 'switch'
      const mark = isSwitch ? '◆' : entry.status === 'run' ? '●' : entry.status === 'ok' ? '·' : '✕'
      const whole = turnMs.get(entry.id)
      // A row of one moment (a message, what a hook added) took no time: its place in the column holds a dash.
      const took = entry.endedAt === undefined ? t.running : whole !== undefined && whole > 0 ? formatMs(whole, t) : tookMs > 0 ? formatMs(tookMs, t) : '—'
      const isMoment = took === '—'
      // Theme keys, so the rows read on a light theme as well as on a dark one.
      const color = isSwitch || entry.status === 'run' ? 'claude' : entry.status === 'ok' ? undefined : 'error'
      const line = `${mark} ${t.stations[entry.station].padEnd(column)} ${entry.label}${times > 1 ? `  +${times - 1}` : ''}`
      const isDim = entry.status === 'ok' && !isSwitch
      // One row of the pane a row of the feed: the words are cut at the edge, the time keeps a column of its own at the
      // right, so a long label neither wraps nor pushes the time about. A long one can be opened, one at a time.
      const isLong = entry.label.length > LONG_LABEL
      const isOpen = isLong && state.open === entry.id
      return (
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text mono size={size} color={color} dimColor={isDim} wrap={isOpen ? 'wrap' : 'truncate-end'}>
              {line}
            </Text>
          </Box>
          {isLong
            ? [
                <Button
                  key={`open-${entry.id}`}
                  plain
                  dimColor
                  label={isOpen ? '▾' : '▸'}
                  onPress={() => void quietly(() => update($, board, b => ({ ...b, open: isOpen ? undefined : entry.id })))}
                />,
              ]
            : []}
          <Box flexShrink={0} minWidth={TIME_COLUMN} justifyContent="flex-end">
            <Text mono tabular size={size} color={isMoment ? undefined : color} dimColor={isDim || isMoment} wrap="truncate-end">
              {took}
            </Text>
          </Box>
        </Box>
      )
    })
    const feed = rows.length > 0 ? rows : [<Text dimColor>{t.nothingYet}</Text>]
    // What runs now at the left, cut if it must be. Where there is no drawing to say them, the context and the model
    // stand at the right, whole; beside the drawing they would be said a second time.
    const now2 = nowParts(state, t)
    const what = now2.what
    const meter = e.surface === 'terminal' ? now2.meter : ''
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
                <Text mono tabular size={size} dimColor>
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

    // The map is one picture, so its stations cannot be pressed. This row is their press targets: one per
    // station the session has used, with its count. Pressing one shows that station alone; again, the whole feed.
    const stations = STATIONS.filter(s => (state.counts[s.id] ?? 0) > 0).map(s => (
      <Button
        key={`station-${s.id}`}
        plain
        dimColor={shown !== undefined && shown !== s.id}
        label={`${t.stations[s.id]} ${state.counts[s.id]}`}
        onPress={() => void quietly(() => update($, board, b => ({ ...b, shown: b.shown === s.id ? undefined : s.id })))}
      />
    ))

    // Network and Browser open on the pages visited, newest first, each a link.
    const visits = shown === 'web' || shown === 'browser' ? (state.visits ?? []).filter(v => v.station === shown).reverse() : []
    const pages = visits.map((visit, i) => (
      <Box key={`visit-${i}`} flexDirection="row" gap={1} alignItems="flex-start">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text size={size} wrap="truncate-end">
            {isLinkable(visit.url) ? <Link href={visit.url} label={shortAddress(visit.url)} /> : shortAddress(visit.url)}
          </Text>
        </Box>
        <Box flexShrink={0} minWidth={TIME_COLUMN} justifyContent="flex-end">
          <Text mono tabular size={size} dimColor wrap="truncate-end">
            {formatMs(Math.max(0, now - visit.at), t)}
          </Text>
        </Box>
      </Box>
    ))

    // The pane holds the last rows of a live session. The Explorer holds all of it, and other sessions.
    const sessionId = shown === undefined ? undefined : await quietly(() => $.session.id())
    const beyond =
      shown !== undefined && typeof sessionId === 'string' && sessionId !== ''
        ? [
            <Text key="explorer" size={size} dimColor>
              <Link href={`${EXPLORER}/map?session=${encodeURIComponent(sessionId)}&station=${shown}`} label={`${t.stations[shown]}: whole session in the Explorer`} />
            </Text>,
          ]
        : []

    return (
      <Box flexDirection="column">
        <Svg source={drawMap(state, now, setup)} alt={`${t.title}. ${describeNow(state, t)}`} />
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
        {beyond}
      </Box>
    )
  })
}
