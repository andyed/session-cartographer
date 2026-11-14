// The board as the hub, the ribbon and the pane's station buttons read it. Nothing here touches the engine.
//
// lot-map's board has ten stations. The drawing the Explorer's session map adopted on 2026-11-13 reads the same
// calls another way: what the agent tells the person is the outward lane of You, and a call into what the person
// has open (their own Chrome, tabs, terminal, desktop) is at a station of its own, Your screen. The board keeps
// lot-map's stations, so the terminal's rows and picture are as they were; this file is the other reading.
import type { Board, Entry, StationId } from '../../types'
import { drawHub, hubLayout, hubState } from './workmap/hub.js'
import type { HubAction } from './workmap/hub'
import { drawRibbon, drawSlotRibbon, ribbonCapacity, ribbonOf } from './workmap/ribbon.js'
import type { RibbonCell } from './workmap/ribbon'

/** A station as the hub has them: lot-map's, and Your screen. */
export type HubStation = StationId | 'screen'

/**
 * The width the pictures are drawn for when a surface does not say how wide its pane is, in CSS pixels: a narrow
 * docked pane. Under 400 px the hub carries the model's name and each station's count and no other words.
 */
export const PICTURE_WIDTH = 340
/**
 * A desktop pane says how many cells of its own text fit across it, and stretches a picture to that width. Measured
 * on one pane on 2026-11-14 (macOS, 2x): 44 cells, and the picture 465 CSS pixels across, so 10.6 a cell. Taken a
 * little under that: the hub then never thinks itself wider than it is drawn, so its 16 px words are never under 16.
 */
export const CELL_PX = 10
/** The width to draw for: from the pane's cells where it gives them, and no wider than the hub's own 460. */
export const pictureWidth = (columns: unknown): number =>
  typeof columns === 'number' && Number.isFinite(columns) && columns > 0 ? Math.max(240, Math.min(460, Math.round(columns * CELL_PX))) : PICTURE_WIDTH
const RIBBON_HEIGHT = 20
const LAYOUT = hubLayout()

/** The board's entries as the hub reads them. */
export function hubActions(entries: readonly Entry[]): HubAction[] {
  return entries.map(e => ({
    station: e.yours === true ? 'screen' : e.station === 'you' && e.from !== 'inbound' ? 'tells' : e.station,
    from: e.from,
    startedAt: e.startedAt,
    // An interrupted turn is filed at You as an error. It is the person's doing and no fault of a station.
    status: e.station === 'you' && e.status === 'err' ? 'ok' : e.status,
    ...(e.endedAt !== undefined ? { endedAt: e.endedAt } : {}),
    ...(e.agentId !== undefined ? { agentId: e.agentId } : {}),
    ...(e.wake !== undefined ? { wake: e.wake } : {}),
  }))
}

/** The counts the hub draws: lot-map's, with what the agent told taken out of You and the person's own things out of the stations they were filed under. */
export function hubTotals(state: Board): Record<string, number> {
  const totals: Record<string, number> = {}
  let screen = 0
  for (const [id, n] of Object.entries(state.counts) as [StationId, number | undefined][]) {
    const yours = Math.min(n ?? 0, state.yours?.[id] ?? 0)
    screen += yours
    totals[id] = (n ?? 0) - yours
  }
  const told = Math.min(state.told ?? 0, totals.you ?? 0)
  if (totals.you !== undefined) totals.you -= told
  if (told > 0) totals.tells = told
  if (screen > 0) totals.screen = screen
  return totals
}

/** How many calls a station button stands for. You is both directions: what was said and what was told. */
export function buttonCount(state: Board, id: HubStation): number {
  const totals = hubTotals(state)
  return id === 'you' ? (totals.you ?? 0) + (totals.tells ?? 0) : (totals[id] ?? 0)
}

/**
 * The station whose rows the pane lists in place of the whole feed: the one held, while it has calls. Under the hub
 * it is held by pressing a slot of the ribbon and may be Your screen; under lot-map's hub, by a station button.
 */
export function shownStation(state: Board, isHub: boolean): HubStation | undefined {
  const held = state.shown
  if (held === undefined) return undefined
  if (isHub) return buttonCount(state, held) > 0 ? held : undefined
  return held !== 'screen' && (state.counts[held] ?? 0) > 0 ? held : undefined
}

/** Whether an entry is one of a station's rows, as the buttons count them. */
export const isAt = (e: Entry, id: HubStation): boolean => (id === 'screen' ? e.yours === true : e.yours !== true && e.station === id)

const sized = (svg: string, from: { width: number; height: number }, width: number): string =>
  svg.replace(`width="${from.width}" height="${from.height}"`, `width="${width}" height="${Math.round((width * from.height) / from.width)}"`)

/**
 * The hub at the pane's width: the route and the stations in their colours, with each station's running count from 280 px up and its name from 400.
 * Every station is drawn from the first call on. A recorded session knows which stations it used and leaves the
 * rest out; a live one does not know yet, and a ring that grows a station at a time reads as a broken picture.
 */
export function hubPicture(state: Board, now: number, options: { names: Record<string, string>; coreName: string; model: string; motion: 'full' | 'reduced'; pressed?: string; width?: number }): string {
  const { width = PICTURE_WIDTH, ...rest } = options
  const totals = hubTotals(state)
  const hub = hubState(hubActions(state.entries), now, { totals, ...(state.context !== undefined ? { context: state.context } : {}) })
  return sized(drawHub(hub, { layout: LAYOUT, size: width, present: new Set(LAYOUT.order), ...rest }), LAYOUT, width)
}

/**
 * How many slots the ribbon has in a pane so many cells across: ten from 40 cells (a slot is then 42 px or more, the
 * least a thing to press should be), five under that, and five where the pane does not say. Only counts that divide
 * a hundred: a Box takes its width as a whole percentage, and the row of controls under the ribbon is that many
 * equal boxes.
 */
export const ribbonSlots = (columns: unknown): number => (typeof columns === 'number' && Number.isFinite(columns) && columns >= 40 ? 10 : 5)

/** One slot of the ribbon: calls that followed one another at one station. `key` is its first call's id, so it is the same slot's name while the run grows. */
export type Run = { key: string; station: HubStation; cells: RibbonCell[] }

/**
 * The calls as runs, oldest first, no more than `slots`: the ribbon's slots, and the things pressed under them.
 * The model's own steps are left out, as on the plain ribbon. What the agent tells the person and what the person
 * said are both You. A held station always has a slot: where none of the newest runs is its, the oldest slot gives
 * way to its last run, so there is always something to press to let it go.
 */
export function ribbonRuns(state: Board, now: number, slots: number, held?: HubStation): Run[] {
  const entries = state.entries.filter(e => e.station !== 'model' && e.startedAt <= now)
  const cells = ribbonOf(hubActions(entries), now, entries.length)
  const all: Run[] = []
  entries.forEach((e, i) => {
    const cell = cells[i]
    if (cell === undefined) return
    const station: HubStation = e.yours === true ? 'screen' : e.station
    const last = all[all.length - 1]
    if (last !== undefined && last.station === station) last.cells.push(cell)
    else all.push({ key: e.id, station, cells: [cell] })
  })
  const runs = all.slice(-slots)
  if (held === undefined || runs.some(run => run.station === held)) return runs
  const own = all.filter(run => run.station === held).at(-1) ?? { key: `held-${held}`, station: held, cells: [] }
  return [own, ...runs.slice(runs.length < slots ? 0 : 1)]
}

/** The ribbon in slots, one a run, with a bar under the held station's; and what it says for a reader who cannot see it. */
export function slotRibbonPicture(runs: readonly Run[], slots: number, width: number = PICTURE_WIDTH, held?: HubStation): string {
  return drawSlotRibbon(runs, { width, height: RIBBON_HEIGHT, slots, ...(held !== undefined ? { held } : {}) })
}

/** The last calls in one row, oldest to newest, in the stations' colours; and how many of them it holds. */
export function ribbonPicture(state: Board, now: number, width: number = PICTURE_WIDTH): { svg: string; shown: number } {
  const cells = ribbonOf(hubActions(state.entries), now, 80)
  return { svg: drawRibbon(cells, { width, height: RIBBON_HEIGHT }), shown: Math.min(cells.length, ribbonCapacity(width, RIBBON_HEIGHT)) }
}
