import { expect, test } from 'claude-code/testing'

import type { Board, Entry } from '../../types'
import { buttonCount, themeFromConfig, CELL_PX, hubActions, hubPicture, hubTotals, isAt, PICTURE_WIDTH, pictureWidth, ribbonPicture, ribbonRuns, ribbonSlots, shownStation, slotRibbonPicture } from './hubview'

const PANE = {
  plugin: 'session-cartographer',
  component: 'Pane',
  requestId: 'carto-flow',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

const T0 = 1_000_000
const entry = (s: number, station: Entry['station'], more: Partial<Entry> = {}): Entry => ({ id: `e${s}`, station, label: station, from: 'core', startedAt: T0 + s * 1000, endedAt: T0 + s * 1000 + 400, status: 'ok', ...more })
const names = { you: 'You', model: 'Model', memory: 'Memory', files: 'Files', shell: 'Shell', web: 'Network', browser: 'Browser', agents: 'Agents', skills: 'Skills', hooks: 'Hooks', screen: 'Your screen' }

test('the board is read the hub\'s way: what the agent told is not the person, and the person\'s own things are Your screen', () => {
  const entries = [
    entry(0, 'you', { from: 'inbound' }),
    entry(1, 'files'),
    entry(2, 'you'),
    entry(3, 'browser', { yours: true }),
    entry(4, 'shell', { yours: true }),
    entry(5, 'you', { status: 'err' }),
    entry(6, 'hooks', { from: 'inbound', wake: 'task' }),
  ]
  expect(hubActions(entries).map(a => a.station)).toEqual(['you', 'files', 'tells', 'screen', 'screen', 'tells', 'hooks'])
  // An interrupted turn is filed at You as an error; on the hub it is no station's fault.
  expect(hubActions(entries)[5]?.status).toBe('ok')
  expect(hubActions(entries)[6]?.wake).toBe('task')

  const board: Board = { entries, counts: { you: 3, files: 1, browser: 4, shell: 9, hooks: 1 }, told: 2, yours: { browser: 1, shell: 1 } }
  // lot-map's counts, with the two readings taken apart: 3 at You were 1 said and 2 told; 2 of Browser's and Shell's were the person's own.
  expect(hubTotals(board)).toEqual({ you: 1, tells: 2, files: 1, browser: 3, shell: 8, hooks: 1, screen: 2 })
  // The sum the hub draws is the sum lot-map counted: nothing is lost or counted twice.
  expect(Object.values(hubTotals(board)).reduce((a, b) => a + b, 0)).toBe(18)
  // A button stands for the rows its press lists.
  expect(buttonCount(board, 'you')).toBe(3)
  expect(buttonCount(board, 'screen')).toBe(2)
  expect(buttonCount(board, 'browser')).toBe(3)
  expect(entries.filter(e => isAt(e, 'screen')).length).toBe(2)
  expect(entries.filter(e => isAt(e, 'browser')).length).toBe(0)
  expect(entries.filter(e => isAt(e, 'you')).length).toBe(3)
  // A board from before these counts were kept draws as lot-map counted it.
  expect(hubTotals({ entries: [], counts: { you: 2, shell: 1 } })).toEqual({ you: 2, shell: 1 })
})

test('a station is held while it has calls: under the hub Your screen too, under lot-map\'s hub only its own ten', () => {
  const board: Board = { entries: [], counts: { shell: 3, browser: 2 }, yours: { browser: 1 }, shown: 'shell' }
  expect(shownStation(board, true)).toBe('shell')
  expect(shownStation(board, false)).toBe('shell')
  expect(shownStation({ ...board, shown: 'screen' }, true)).toBe('screen')
  expect(shownStation({ ...board, shown: 'screen' }, false)).toBeUndefined()
  // A station with nothing at it is not held open, under either.
  expect(shownStation({ ...board, shown: 'files' }, true)).toBeUndefined()
  expect(shownStation({ ...board, shown: 'files' }, false)).toBeUndefined()
})

test('the ribbon\'s slots are runs of calls at one station, and a held station always has one', () => {
  const entries = [
    entry(0, 'you', { from: 'inbound' }),
    entry(1, 'model'),
    entry(2, 'files'),
    entry(3, 'model'),
    entry(4, 'files'),
    entry(5, 'shell'),
    entry(6, 'browser', { yours: true }),
    entry(7, 'browser'),
    entry(8, 'you'),
  ]
  const board: Board = { entries, counts: {} }
  const runs = ribbonRuns(board, T0 + 60_000, 10)
  // The model's steps are no call and break no run: the two reads are one slot, named by the first of them.
  expect(runs.map(run => `${run.station} ${run.cells.length} ${run.key}`)).toEqual(['you 1 e0', 'files 2 e2', 'shell 1 e5', 'screen 1 e6', 'browser 1 e7', 'you 1 e8'])
  // A run that grows keeps its name, so the control under it is the same control.
  expect(ribbonRuns({ ...board, entries: [...entries, entry(9, 'you')] }, T0 + 60_000, 10).at(-1)?.key).toBe('e8')
  // Fewer slots than runs: the newest. A station held that is not among them takes the oldest slot.
  expect(ribbonRuns(board, T0 + 60_000, 3).map(run => run.station)).toEqual(['screen', 'browser', 'you'])
  expect(ribbonRuns(board, T0 + 60_000, 3, 'files').map(run => `${run.station} ${run.key}`)).toEqual(['files e2', 'browser e7', 'you e8'])
  // Held and already in view, nothing moves; held with none of its calls kept, it still has a slot to press.
  expect(ribbonRuns(board, T0 + 60_000, 3, 'you').map(run => run.station)).toEqual(['screen', 'browser', 'you'])
  expect(ribbonRuns(board, T0 + 60_000, 3, 'agents').map(run => `${run.station} ${run.cells.length}`)).toEqual(['agents 0', 'browser 1', 'you 1'])
  // Ten slots from 40 cells, five under: counts whose share of the width is a whole percentage.
  expect([44, 40, 39, 28, undefined].map(ribbonSlots)).toEqual([10, 10, 5, 5, 5])
  // Drawn, a slot is the same share of the width as its control's box, and the held station's runs are underlined.
  const svg = slotRibbonPicture(runs, 10, 440, 'you')
  expect(svg).toContain('viewBox="0 0 440 20"')
  expect(svg.split('class="held"').length - 1).toBe(2)
  expect(svg).toContain('<rect class="held" x="399" y="18" width="38" height="2"')
  expect(slotRibbonPicture(runs, 10, 440).includes('class="held"')).toBe(false)
  // The newest run's one call is inside the last slot (396 to 440), and the two reads share the slot they are in.
  const marks = [...svg.matchAll(/<rect x="([\d.]+)" y="[\d.]+" width="([\d.]+)" height="[\d.]+" fill="(#[0-9a-f]+)"\/>/g)].map(m => ({ x: Number(m[1]), w: Number(m[2]), fill: m[3] }))
  expect(marks.at(-1)!.x >= 396 && marks.at(-1)!.x + marks.at(-1)!.w <= 440).toBe(true)
  const reads = marks.filter(m => m.fill === '#b99558')
  expect(reads.length).toBe(2)
  expect(reads.every(m => m.x >= 220 && m.x + m.w <= 264)).toBe(true)
})

test('the pane\'s pictures are the Explorer\'s drawing at a pane\'s width', () => {
  const entries = [entry(0, 'you', { from: 'inbound' }), entry(1, 'files'), entry(2, 'shell'), entry(3, 'files'), entry(4, 'you')]
  const board: Board = { entries, counts: { you: 2, files: 2, shell: 1 }, told: 1, context: 82 }
  const hub = hubPicture(board, T0 + 5000, { names, coreName: 'CLAUDE', model: 'fable 5.2', motion: 'reduced' })
  expect(hub).toContain(`width="${PICTURE_WIDTH}"`)
  expect(hub).toContain('viewBox="0 0 460 474"')
  // Under 400 px the stations have no names. The core says the model, broken in two lines to fit at 16 px, and the
  // window being 82% full takes no line from it there: the ring and the line under the picture say that.
  // Too narrow for names: the model in the core, and each station's running count beside it.
  const words = [...hub.matchAll(/<text [^>]*>([^<]+)<\/text>/g)].map(m => m[1] ?? "")
  expect(words.slice(0, 2)).toEqual(['fable', '5.2'])
  expect(words.slice(2).every(w => /^\d+$/.test(w))).toBe(true)
  expect(hub.split('class="count"').length - 1).toBeGreaterThanOrEqual(3)
  // Narrower than 280 px a count would run into the next station, and there is none.
  expect(hubPicture(board, T0 + 5000, { names, coreName: 'CLAUDE', model: 'fable 5.2', motion: 'reduced', width: 260 })).not.toContain('class="count"')
  expect(Number(/font-size="([\d.]+)"/.exec(hub)?.[1]) / (460 / PICTURE_WIDTH)).toBeGreaterThanOrEqual(15.9)
  // Two-way You: its spoke is two standing lanes, and there is no place for what the agent tells.
  expect(hub.split('class="lane" d="M').length - 1).toBe(4)
  // The route: the person in, out to Files, Files to Shell, Shell to Files, and the agent telling. Five legs, five heads over five casings.
  expect(hub.split('class="casing" d="M').length - 1).toBe(10)
  // Every station has its place from the first call: ten circles and two squares with the core, used or not.
  expect(hub.split('<path d="M').length - 1).toBeGreaterThanOrEqual(11)
  expect(hubPicture({ entries: [], counts: {} }, T0, { names, coreName: 'CLAUDE', model: 'fable 5.2', motion: 'reduced' }).split('stroke-linejoin="round"/>').length - 1).toBe(11)
  // A pane that says it is wide gets the names, set at 16 px for the width it gave; one that does not say gets none.
  // The pane measured on 2026-11-14 said 44 cells and was 465 px across: it is drawn for 440, with names.
  expect(pictureWidth(44)).toBe(44 * CELL_PX)
  expect(pictureWidth(44)).toBeGreaterThanOrEqual(400)
  expect(pictureWidth(44)).toBeLessThanOrEqual(465)
  expect(pictureWidth(30)).toBe(300)
  expect(pictureWidth(200)).toBe(460)
  expect(pictureWidth(20)).toBe(240)
  expect(pictureWidth(undefined)).toBe(PICTURE_WIDTH)
  const named = hubPicture(board, T0 + 5000, { names, coreName: 'CLAUDE', model: 'fable 5.2', motion: 'reduced', width: pictureWidth(66) })
  expect(named).toContain('>Your screen<')
  // The model is the core's first line; the window is 82% full here, so that is its second in place of the agent's name.
  expect(named).toContain('>fable 5.2<')
  expect(named).toContain('>82% full<')
  expect(named).not.toContain('>CLAUDE<')
  // You's two counts stand beside their lanes as bare figures: the lane's arrow says which way each went.
  expect(named).not.toContain(' said<')
  expect(named).not.toContain(' told<')
  expect(named.match(/>1<\/text>/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  // A station nothing has happened at has its name and no figure.
  expect(named).not.toContain('>0<')
  const sizes = [...named.matchAll(/font-size="([\d.]+)"/g)].map(m => Number(m[1]) / (460 / pictureWidth(66)))
  expect(Math.min(...sizes)).toBeGreaterThanOrEqual(15.9)
  // The pressed station is ringed in the drawing.
  expect(hubPicture(board, T0 + 5000, { names, coreName: 'CLAUDE', model: 'fable 5.2', motion: 'reduced', pressed: 'shell' })).toContain('class="pressed"')

  const ribbon = ribbonPicture(board, T0 + 5000)
  expect(ribbon.shown).toBe(5)
  expect(ribbon.svg).toContain(`width="${PICTURE_WIDTH}" height="20"`)
  // The person's message is the one full-height white cell.
  expect(ribbon.svg.split('height="20" fill="#edf0f5"').length - 1).toBe(1)
})

test("the app's theme setting picks a side where it names one, and `auto` leaves it to the surface", () => {
  expect(['light', 'light-daltonized', 'light-ansi', 'dark', 'dark-daltonized', 'auto', undefined, 3].map(themeFromConfig)).toEqual(['light', 'light', 'light', 'dark', 'dark', 'auto', 'auto', 'auto'])
})

test('the pane follows the theme: auto draws the hub and the ribbon in both palettes, the light one shown on a light surface', () => {
  const board: Board = { entries: [entry(0, 'you', { from: 'inbound' }), entry(1, 'files'), entry(2, 'shell')], counts: { you: 1, files: 1, shell: 1 } }
  const options = { names: {}, coreName: 'CLAUDE', model: 'fable 5.2', motion: 'reduced' } as const
  const dark = hubPicture(board, T0 + 5000, options)
  // Left alone it is the dark drawing, as before.
  expect(dark).not.toContain('<g class="lt">')
  expect(dark).toContain('fill="#0a0a0f"')
  const light = hubPicture(board, T0 + 5000, { ...options, theme: 'light' })
  expect(light).not.toContain('#0a0a0f')
  expect(light).toContain('fill="#f5f2ea"')
  const auto = hubPicture(board, T0 + 5000, { ...options, theme: 'auto' })
  const [first, second] = auto.split('<g class="lt">')
  expect(first).toContain('<g class="dk">')
  expect(first).toContain('fill="#0a0a0f"')
  expect(first).not.toContain('#f5f2ea')
  expect(second).toContain('fill="#f5f2ea"')
  expect(second).not.toContain('#0a0a0f')
  // The light group shows only where the surface is light, and the picture keeps its size.
  expect(auto).toContain('@media (prefers-color-scheme: light){.dk{display:none}.lt{display:inline}}')
  expect(auto).toContain('viewBox="0 0 460 474"')
  // The ribbon is the same, in the light palette's family colours: the person's message is dark ink there.
  const cells = ribbonPicture(board, T0 + 5000, PICTURE_WIDTH, 'auto').svg.split('<g class="lt">')
  expect(cells[0]).toContain('fill="#edf0f5"')
  expect(cells[1]).toContain('fill="#1f2228"')
  expect(cells[1]).not.toContain('#edf0f5')
  expect(slotRibbonPicture([], 5, PICTURE_WIDTH, undefined, 'light')).toContain('fill="#f5f2ea"')
})

test('on the desktop the pane is the ribbon over the hub, and Your screen is a station with its own pages', async ($, on) => {
  let clock = T0
  on('clock.now', () => ({ value: clock }))
  on('tool.call', () => ({ result: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  // The Explorer is running: it answers its health check, naming the logs it reads.
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"status":"ok","files":{"changelog":true}}' } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }) as never)
  on('turn.complete', () => ({ text: '' }))

  await $.turn.start({ text: 'look at my tabs', turnId: 't1' } as never)
  clock += 1000
  await $.tool.call({ tool: 'mcp__claude-in-chrome__navigate', url: 'https://mail.example.com/inbox' })
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'https://docs.example.com/guide' })
  await $.tool.call({ tool: 'mcp__terminal__read_terminal' })
  await $.tool.call({ tool: 'mcp__ccd_session_mgmt__send_message', to: 'local_1', message: 'done?' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  clock += 1000
  await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const pictures = (await ui.findAll({ type: 'Svg' })).map(svg => ({ source: String(svg.props.source), alt: String(svg.props.alt) }))
  expect(pictures.length).toBe(2)
  expect(pictures[0]?.alt).toBe('The last 7 calls in 6 runs, oldest to newest')
  expect(pictures[0]?.source).toContain('height="20"')
  expect(pictures[1]?.source).toContain('viewBox="0 0 460 474"')
  // The test pane is 60 cells across: wide enough for names, and both pictures are drawn for that one width.
  expect(pictures[0]?.source).toContain('width="460" height="20"')
  expect(pictures[1]?.source).toContain('width="460"')
  expect(pictures[1]?.source).toContain('>Network<')
  // lot-map's hub is not drawn here: none of its animation is in the picture.
  expect(pictures[1]?.source).not.toContain('<animate')

  // The hub names every station and writes its count, and the ribbon is the calls in the stations' colours: the
  // pane has no row of station buttons and no key under the map (the owner: "drop the legends").
  expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('station-')).length).toBe(0)
  expect((await ui.findAll({ type: 'Text', text: /^■$/ })).length).toBe(0)
  // Both calls into the person's own things are Your screen's, in the picture and in the rows.
  expect(pictures[1]?.source).toContain('>Your screen<')
  expect(await ui.find({ type: 'Text', text: /Your screen +(mail\.example\.com|navigate)/ })).toBeDefined()
  // Nothing in the pane is dimmed on the desktop, where dim text measured 6.4:1.
  expect((await ui.findAll({ type: 'Text' })).filter(text => text.props.dimColor === true).length).toBe(0)
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.dimColor === true).length).toBe(0)
  // The picture takes no press, so it is an image with no link in it.
  const hub = (await ui.findAll({ type: 'Svg' })).at(-1)
  expect(hub?.props.isInteractive).toBeUndefined()
  expect(String(hub?.props.source)).not.toContain('<a ')
  // With the Explorer running, the name at the head of a row is a link to that station on this session's map
  // there, a call into the person's own things to Your screen; a row that went to a page links to it as well;
  // and the link to the map whole is the last thing in the pane, with its arrow.
  const links = await ui.findAll({ type: 'Link' })
  const hrefs = links.map(link => String(link.props.href))
  const station = (id: string): string => `http://localhost:2527/flow?session=sess-1&station=${id}`
  expect(hrefs.at(-1)).toBe('http://localhost:2527/flow?session=sess-1')
  expect(hrefs.filter(href => href.startsWith('https://'))).toEqual(['https://docs.example.com/guide', 'https://mail.example.com/inbox'])
  const named = links.filter(link => String(link.props.href).includes('&station=')).map(link => `${String(link.props.label)} ${String(link.props.href).split('&station=')[1]}`)
  expect(named).toContain('Your screen screen')
  expect(named).toContain('Browser browser')
  expect(named).toContain('Agents agents')
  expect(named).toContain('You you')
  expect(hrefs).toContain(station('screen'))
  // The link stands just before its row's own: the station, then where the row went.
  expect(hrefs[hrefs.indexOf('https://mail.example.com/inbox') - 1]).toBe(station('screen'))
  expect(String(links.at(-1)?.props.label)).toBe('↗ Explorer')
  // The pane is at least as tall as its room, with what is left over above that link, so the link is at the bottom edge.
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes[0]?.props.minHeight).toBe(40)
  expect(boxes.filter(b => b.props.key === 'rest' && b.props.flexGrow === 1).length).toBe(1)

  // Under the ribbon, as many equal boxes as it has slots, and in each box that has a run over it, one control.
  // The pane is 60 cells across: ten slots, a tenth of the width each. Six runs, so the first four boxes are empty.
  const slotBoxes = boxes.filter(b => String(b.props.key).startsWith('slot-'))
  expect(slotBoxes.map(b => b.props.width)).toEqual(Array.from({ length: 10 }, () => '10%'))
  const slotButtons = async () => (await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('ribbon-'))
  const controls = await slotButtons()
  expect(controls.map(b => String(b.props.label))).toEqual(['△', '△', '△', '△', '△', '△'])
  // The runs, oldest first: the message, the person's Chrome, the agent's browser, the person's terminal, another
  // session, then the plan update and the answer as one. Nothing is held: no bar on the ribbon, no ring on the hub.
  const ribbonSvg = async () => String((await ui.findAll({ type: 'Svg' }))[0]?.props.source)
  const hubSvg = async () => String((await ui.findAll({ type: 'Svg' })).at(-1)?.props.source)
  expect(await ribbonSvg()).not.toContain('class="held"')
  expect(await hubSvg()).not.toContain('class="pressed"')

  // Pressing the slot of the person's Chrome narrows the feed to Your screen: both of its runs are marked on the
  // ribbon and under it, the hub rings the station, the pages visited there are listed, and the Explorer's link
  // goes to that station.
  await ui.press({ key: String(controls[1]?.props.key) })
  expect((await slotButtons()).map(b => String(b.props.label))).toEqual(['△', '▲', '△', '▲', '△', '△'])
  // The picture is drawn twice, once a theme (the second group is the light one): count in the first.
  expect((await ribbonSvg()).split('<g class="lt">')[0]!.split('class="held"').length - 1).toBe(2)
  expect(await hubSvg()).toContain('class="pressed"')
  const held = (await ui.findAll({ type: 'Link' })).map(link => String(link.props.href))
  expect(held).toEqual(['https://mail.example.com/inbox', 'http://localhost:2527/flow?session=sess-1&station=screen'])
  // The controls are the same controls, in the same boxes: nothing moved for the press.
  expect((await slotButtons()).map(b => String(b.props.key))).toEqual(controls.map(b => String(b.props.key)))
  // Nothing is dimmed to show it.
  expect((await ui.findAll({ type: 'Button' })).filter(b => b.props.dimColor === true).length).toBe(0)

  // Another station's slot moves the hold there; a slot of the held station lets it go.
  await ui.press({ key: String(controls[2]?.props.key) })
  expect((await slotButtons()).map(b => String(b.props.label))).toEqual(['△', '△', '▲', '△', '△', '△'])
  expect((await ui.findAll({ type: 'Link' })).map(link => String(link.props.href))).toEqual(['https://docs.example.com/guide', 'http://localhost:2527/flow?session=sess-1&station=browser'])
  await ui.press({ key: String(controls[2]?.props.key) })
  expect((await slotButtons()).map(b => String(b.props.label))).toEqual(['△', '△', '△', '△', '△', '△'])
  expect(await ribbonSvg()).not.toContain('class="held"')
  expect((await ui.findAll({ type: 'Link' })).map(link => String(link.props.href)).at(-1)).toBe('http://localhost:2527/flow?session=sess-1')
  await ui.unmount()

  // A terminal keeps lot-map's stations: no Your screen, and the calls where lot-map files them.
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.findAll({ type: 'Svg' })).length).toBe(0)
  expect(await term.find({ type: 'Text', text: /Your screen/ })).toBeUndefined()
  await term.unmount()
})

test('with no Explorer running the pane offers no way to it: no link on a station\'s name, none under the feed, none on a changed file', async ($, on) => {
  // Ten minutes on from any other test's clock, so an answer another test got is too old to stand.
  let clock = T0 + 600_000
  on('clock.now', () => ({ value: clock }))
  on('tool.call', () => ({ result: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  // Nothing answers the health check.
  on('http.fetch', () => { throw new Error('connect ECONNREFUSED 127.0.0.1:2527') })
  await $.tool.call({ tool: 'Edit', file_path: '/Users/x/dev/app/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'WebFetch', url: 'https://docs.example.com/guide', prompt: 'how' })
  clock += 1000
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const hub = (await ui.findAll({ type: 'Svg' })).at(-1)
  expect(String(hub?.props.source)).toContain('>Shell<')
  // The page a row went to is still a link: that needs no Explorer. No station's name is one.
  expect((await ui.findAll({ type: 'Link' })).map(link => String(link.props.href))).toEqual(['https://docs.example.com/guide'])
  await ui.unmount()
})

test('a person who set the light theme keeps lot-map\'s hub, which has light colours', { options: { theme: 'light' } }, async ($, on) => {
  on('clock.now', () => ({ value: T0 }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const pictures = await ui.findAll({ type: 'Svg' })
  expect(pictures.length).toBe(1)
  expect(String(pictures[0]?.props.source)).toContain('viewBox="0 0 460 430"')
  await ui.unmount()
})
