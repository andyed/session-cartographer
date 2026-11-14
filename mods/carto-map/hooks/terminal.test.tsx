// The map's picture in a terminal: the painter that makes it, and the pane that shows it to a person who asked for it.
import { expect, mock, test } from 'claude-code/testing'

import type { Board, Entry } from '../types'
import { TRAIL_FADE_MS, TRAIL_HOLD_MS, drawMap, setupFrom } from './map'
import { ENDLESS_FOR_MS, FASTEST_MS, MAX_IMAGE_BYTES, endlessEvery, fromBase64, imageSource, nextChangeIn, paint, parseMap, valueAt } from './raster'
import { stringsFor } from './text'

const PANE = {
  plugin: 'carto-map',
  component: 'Pane',
  requestId: 'carto-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// Someone's own setup as it stands in settings: Russian labels and a memory of their own.
const OWN = {
  language: 'ru',
  coreName: 'ДОМ',
  memoryServers: ['recall'],
  memoryCommands: ['recall', 'check_recall'],
  memorySubcommands: ['add', 'memory'],
  memoryPaths: ['/.recall/'],
  memoryLabels: ['search=поиск', 'get_note=чтение записи'],
  hookRecords: true,
} as const

const entry = (station: Entry['station'], startedAt: number, more: Partial<Entry> = {}): Entry => ({
  id: `${station}${startedAt}`,
  station,
  label: station,
  from: 'core',
  startedAt,
  endedAt: startedAt + 10,
  status: 'ok',
  ...more,
})

/** The picture is there only for a person who asked for it. */
const PICTURE = { terminalView: 'picture' } as const

test('terminal options that make no sense count as not set', () => {
  expect(setupFrom({}).terminalView).toBe('text')
  expect(setupFrom({ terminalView: 'picture' }).terminalView).toBe('picture')
  expect(setupFrom({ terminalView: 'Picture' }).terminalView).toBe('text')
  expect(setupFrom({ terminalView: true }).terminalView).toBe('text')
  expect(setupFrom({}).cellShape).toBe(2.4)
  expect(setupFrom({ cellShape: 9 }).cellShape).toBe(2.4)
  expect(setupFrom({ cellShape: '' }).cellShape).toBe(2.4)
  expect(setupFrom({ cellShape: 'tall' }).cellShape).toBe(2.4)
  expect(setupFrom({ cellShape: '2.1' }).cellShape).toBe(2.1)
})

test('unless the person asks for the picture, a terminal shows the rows alone, as it always has, and nothing is painted', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let frames = 0
  on('ui.blit', () => {
    frames++
    return { value: {} }
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect((await ui.find({ type: 'Text', text: /b\/content\.py/ }))?.text).toContain('Files')
  expect(await ui.find({ type: 'Text', text: /Files 1/ })).toBeDefined()
  await clock.advance(2000)
  expect(frames).toBe(0)
  await ui.unmount()
})

// ---- the map as a picture, in a terminal ----------------------------------------------------------

/** A board with something of everything on it: calls running, in flight and coming back, faults, memory, subagents, a model change. */
const BUSY = (now: number): Board => ({
  entries: [
    entry('you', now - 30_000, { from: 'inbound' }),
    entry('files', now - 20_000),
    entry('memory', now - 400, { from: 'inbound' }),
    entry('web', now - 2_500, { status: 'err' }),
    entry('skills', now - 900, { status: 'block' }),
    entry('shell', now - 300, { status: 'run', endedAt: undefined }),
    entry('shell', now - 200, { status: 'run', endedAt: undefined, id: 'shell-2' }),
    entry('files', now - 50, { status: 'run', endedAt: undefined }),
    entry('agents', now - 65_000, { status: 'run', endedAt: undefined }),
    entry('browser', now - 100, { from: 'agents', agentId: 'a1' }),
    entry('you', now - 300, { mark: 'done' }),
  ],
  counts: { you: 3, files: 40, shell: 12, memory: 5, web: 2, agents: 1, model: 9, skills: 1, browser: 1 },
  pushed: 2,
  faults: { web: 1, skills: 1 },
  agents: ['a1', 'a2'],
  context: 92,
  model: 'claude-opus-5-5',
  step: 3,
  switchedAt: now - 2000,
})

/** A frame's RGBA at (x, y). */
const pixel = (f: { width: number; rgba: Uint8Array }, x: number, y: number): number[] => [...f.rgba.slice((y * f.width + x) * 4, (y * f.width + x) * 4 + 4)]

test('every drawing the map makes is one the painter can paint whole', () => {
  const now = 1_000_000
  const boards = [{ entries: [], counts: {} }, BUSY(now)]
  const setups = [
    {},
    { theme: 'dark' },
    { theme: 'light' },
    { background: 'transparent' },
    { layout: 'you-bottom' },
    { ...OWN, colors: 'accent=#7fb4ff,background=#101418' },
    { coreName: '<&"ДОМ"&>' },
    { motion: 'reduced' },
    { motion: 'reduced', layout: 'you-bottom', theme: 'light' },
  ]
  for (const board of boards) {
    for (const options of setups) {
      const scene = parseMap(drawMap(board, now, setupFrom(options)))
      expect(scene.unknown).toEqual([])
      expect([scene.width, scene.height]).toEqual([460, 430])
    }
  }
  // Something it does not know is said, not guessed at.
  expect(parseMap('<svg viewBox="0 0 10 10"><polygon points="0 0 1 1"/><circle r="1" fill="#fff" filter="x"/></svg>').unknown).toEqual(['<polygon>', 'circle filter'])
  // A root that tells screen readers it is an image is one it knows.
  expect(parseMap('<svg role="img" viewBox="0 0 10 10"></svg>').unknown).toEqual([])
})

test('a group turned once carries the shapes in it, as the subagents stand with reduced motion', () => {
  // A dot at the top, in a group turned a quarter round the middle, lands at the right.
  const frame = paint(parseMap('<svg viewBox="0 0 10 10"><g transform="rotate(90 5 5)"><circle cx="5" cy="1" r="1" fill="#ffffff"/></g></svg>'), 0, 4)
  expect(pixel(frame, 36, 20)[3]).toBeGreaterThan(0)
  expect(pixel(frame, 20, 4)[3]).toBe(0)
})

test('the painter keeps time as SVG does', () => {
  const near = (v: number): number => Math.round(v * 1000) / 1000
  const at = (animation: string, t: number, base = 0): number => {
    const shape = parseMap(`<svg viewBox="0 0 10 10"><circle r="1" fill="#ffffff" opacity="${base}">${animation}</circle></svg>`).shapes[0]
    if (shape === undefined) throw new Error('no shape')
    return valueAt(shape, 'opacity', base, t)
  }
  const held = '<animate attributeName="opacity" values="1;1;0" keyTimes="0;.5;1" begin="-0.500s" dur="2.000s" fill="freeze"/>'
  expect(at(held, 0)).toBe(1)
  expect(near(at(held, 1000))).toBe(0.5)
  expect(at(held, 5000)).toBe(0)
  // Not held, it goes back to the shape's own value; not begun, it has no say yet.
  expect(at('<animate attributeName="opacity" values=".2;.8" begin="0s" dur="1s"/>', 2000, 0.4)).toBe(0.4)
  expect(at('<animate attributeName="opacity" values=".2;.8" begin="1s" dur="1s"/>', 500, 0.4)).toBe(0.4)
  // Round and round, or a given number of times and then held at its end.
  expect(near(at('<animate attributeName="opacity" values="0;1" begin="0s" dur="1s" repeatCount="indefinite"/>', 10_250))).toBe(0.25)
  expect(near(at('<animate attributeName="opacity" values="0;1" begin="0s" dur="1s" repeatCount="2" fill="freeze"/>', 1500))).toBe(0.5)
  expect(at('<animate attributeName="opacity" values="0;1" begin="0s" dur="1s" repeatCount="2" fill="freeze"/>', 9000)).toBe(1)
  // The one that began later has the last word.
  const two = '<animate attributeName="opacity" values="0;.85" begin="0s" dur=".1s" fill="freeze"/><animate attributeName="opacity" values=".85;0" begin="2s" dur="1s" fill="freeze"/>'
  expect(near(at(two, 1000))).toBe(0.85)
  expect(near(at(two, 2500))).toBe(0.425)
})

test('the picture is painted again only while something moves, and the core breathes only while something runs', () => {
  const now = 1_000_000
  const rest = parseMap(drawMap({ entries: [], counts: {} }, now, setupFrom({})))
  // At rest only the core breathes, and that alone is no reason to paint unless endless animations count.
  expect(nextChangeIn(rest, 0)).toBeUndefined()
  expect(nextChangeIn(rest, 0, 500)).toBeGreaterThanOrEqual(500)
  // They count only while something runs: at thirty frames a second for ten minutes, then every five seconds.
  // A map at rest waits for the next change.
  expect(endlessEvery(0, true)).toBe(FASTEST_MS)
  expect(endlessEvery(ENDLESS_FOR_MS - 1, true)).toBe(FASTEST_MS)
  expect(endlessEvery(ENDLESS_FOR_MS, true)).toBe(5000)
  expect(endlessEvery(0, false)).toBeUndefined()
  expect(nextChangeIn(rest, 0, endlessEvery(0, false))).toBeUndefined()
  const busy = parseMap(drawMap(BUSY(now), now, setupFrom({})))
  expect(nextChangeIn(busy, 0)).toBe(FASTEST_MS)
  // What runs breathes and beats smoothly when asked to, long after everything else has settled.
  expect(nextChangeIn(busy, 30_000, FASTEST_MS)).toBe(FASTEST_MS)
  // A route leg waits forty seconds before it fades: the painter sleeps until then.
  const leg = parseMap(drawMap({ entries: [entry('files', now - 1000), entry('shell', now - 500)], counts: {} }, now, setupFrom({})))
  // A station's glow fades as smoothly as a pulse flies, long after the pulse has landed.
  expect(nextChangeIn(leg, 1500)).toBe(FASTEST_MS)
  expect(nextChangeIn(leg, 5000)).toBeGreaterThan(30_000)
  expect(nextChangeIn(leg, 5000)).toBeLessThan(TRAIL_HOLD_MS)
  expect(nextChangeIn(leg, TRAIL_HOLD_MS + TRAIL_FADE_MS)).toBeUndefined()
})

test('the painted map has its ground, its words and its lit stations where the drawing has them', () => {
  const now = 1_000_000
  const frame = (board: Board, options: Record<string, unknown>) => paint(parseMap(drawMap(board, now, setupFrom(options))), 0, 1)
  /** Whether any pixel in the box around (x, y) is like the color: red high, blue well below it, as the accent is. */
  const warm = (f: { width: number; rgba: Uint8Array }, x: number, y: number, reach: number): boolean => {
    for (let yy = y - reach; yy <= y + reach; yy++) for (let xx = x - reach; xx <= x + reach; xx++) {
      const [r = 0, , b = 0] = pixel(f, xx, yy)
      if (r > 190 && b < r - 60) return true
    }
    return false
  }

  const dark = frame({ entries: [], counts: {} }, { theme: 'dark' })
  expect([dark.width, dark.height]).toEqual([460, 430])
  expect(pixel(dark, 30, 30)).toEqual([0x0a, 0x0c, 0x11, 255])
  // The rounded corner is left clear.
  expect(pixel(dark, 0, 0)[3]).toBe(0)
  expect(pixel(frame({ entries: [], counts: {} }, { theme: 'light' }), 30, 30)).toEqual([0xf5, 0xf2, 0xea, 255])
  expect(pixel(frame({ entries: [], counts: {} }, { theme: 'dark', background: 'transparent' }), 30, 30)[3]).toBe(0)

  // "You" under the top station: light words on the dark ground.
  let lit = 0
  for (let y = 74; y <= 86; y++) for (let x = 215; x <= 245; x++) if ((pixel(dark, x, y)[0] ?? 0) > 120) lit++
  expect(lit).toBeGreaterThan(10)

  // Files runs, Browser does not: only Files wears the accent around its node.
  const running = frame({ entries: [entry('files', now - 5000, { status: 'run', endedAt: undefined })], counts: { files: 1 } }, { theme: 'dark' })
  expect(warm(running, 397, 263, 30)).toBe(true)
  expect(warm(running, 127, 346, 30)).toBe(false)
})

test('what never moves is painted once a drawing, and the frames come out as if every shape were painted each time', () => {
  const now = 1_000_000
  // An animation of nothing makes every shape one that moves, so the painter paints the drawing whole, frame after frame.
  const nothing = { kind: 'value', attr: 'nothing', values: [0], keyTimes: undefined, begin: 0, dur: 1, repeat: 1, freeze: false }
  const times = [0, 333, 1500, 45_000]
  for (const options of [{ theme: 'dark', background: 'transparent' }, { theme: 'dark' }, { theme: 'light' }]) {
    const scene = parseMap(drawMap(BUSY(now), now, setupFrom(options)))
    const whole = { ...scene, shapes: scene.shapes.map(s => ({ ...s, animations: [...s.animations, nothing] })) } as typeof scene
    // All of one drawing's frames, then the other's: the painter keeps the still shapes of one drawing at a time.
    const frames = times.map(t => paint(scene, t, 1).rgba.slice())
    for (const [k, t] of times.entries()) {
      const layered = frames[k] as Uint8Array
      const direct = paint(whole, t, 1).rgba
      // What shows: each color weighted by its opacity, and the opacity, within two steps of rounding out of 255.
      let worst = 0
      for (let i = 0; i < layered.length; i += 4) {
        const a = layered[i + 3] as number
        const b = direct[i + 3] as number
        worst = Math.max(worst, Math.abs(a - b))
        for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((layered[i + c] as number) * a - (direct[i + c] as number) * b) / 255)
      }
      expect(worst).toBeLessThanOrEqual(2)
    }
  }
})


// A reader for the PNGs the mod makes, written apart from the writer, straight from RFC 1951: one IDAT,
// blocks of deflate's fixed codes, rows unfiltered. Enough to read back what the terminal is sent.
const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]

function unpng(file: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  expect([...file.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  expect([...file.subarray(24, 29)]).toEqual([8, 6, 0, 0, 0])
  let z: Uint8Array | undefined
  for (let p = 8; p < file.length; p += 12 + view.getUint32(p)) {
    if (String.fromCharCode(...file.subarray(p + 4, p + 8)) === 'IDAT') z = file.subarray(p + 8, p + 8 + view.getUint32(p))
  }
  if (z === undefined) throw new Error('no IDAT')

  const row = width * 4 + 1
  const raw = new Uint8Array(row * height)
  let n = 0
  let pos = 2 // past the zlib header
  let bit = 0
  const bits = (count: number): number => {
    let v = 0
    for (let i = 0; i < count; i++) {
      v |= ((((z as Uint8Array)[pos] as number) >> bit) & 1) << i
      if (++bit === 8) {
        bit = 0
        pos++
      }
    }
    return v
  }
  // Huffman codes come most significant bit first.
  const code = (count: number, v = 0): number => {
    for (let i = 0; i < count; i++) v = (v << 1) | bits(1)
    return v
  }
  let last = 0
  while (last === 0) {
    last = bits(1)
    expect(bits(2)).toBe(1)
    for (;;) {
      let c = code(7)
      let symbol: number
      if (c <= 0b0010111) symbol = 256 + c
      else {
        c = code(1, c)
        if (c >= 0x30 && c <= 0xbf) symbol = c - 0x30
        else if (c >= 0xc0 && c <= 0xc7) symbol = 280 + c - 0xc0
        else symbol = 144 + code(1, c) - 0x190
      }
      if (symbol === 256) break
      if (symbol < 256) {
        raw[n++] = symbol
        continue
      }
      const l = symbol - 257
      const length = (LENGTH_BASE[l] as number) + bits(LENGTH_EXTRA[l] as number)
      const d = code(5)
      const distance = (DISTANCE_BASE[d] as number) + bits(DISTANCE_EXTRA[d] as number)
      for (let k = 0; k < length; k++, n++) raw[n] = raw[n - distance] as number
    }
  }
  expect(n).toBe(raw.length)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * row]).toBe(0)
    rgba.set(raw.subarray(y * row + 1, (y + 1) * row), y * width * 4)
  }
  return { width, height, rgba }
}

test('a frame goes to the terminal as a PNG that reads back to the same pixels', () => {
  let seed = 7
  const noise = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 255
  for (const [width, height] of [[37, 23], [300, 3], [2, 700]] as const) {
    // Noise between runs longer than a match can be, so every code is used.
    const rgba = new Uint8Array(width * height * 4).map((_, i) => (i % 997 < 400 ? 200 : noise()))
    const source = imageSource({ width, height, rgba })
    expect('png' in source).toBe(true)
    expect(unpng(fromBase64((source as { png: string }).png))).toEqual({ width, height, rgba })
  }
  // Too small for a PNG to pay: the pixels go as they are.
  expect(imageSource({ width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 4]) })).toEqual({ rgba: 'AQIDBA==', width: 1, height: 1 })
})

test('with terminalView picture, in a terminal the map is a picture above the rows, within what an Image takes', { options: { ...OWN, ...PICTURE } }, async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.key).toBe('map')
  // Sixty columns across, and as many rows as keep the map round on cells 2.4 times as tall as they are wide, as iTerm2's Monaco 12 draws them.
  expect(image?.props.columns).toBe(60)
  expect(image?.props.rows).toBe(23)
  // A PNG, a small part of the frame's 1.8 MB of pixels.
  const file = fromBase64((image?.props.source as { png: string }).png)
  expect(file.length).toBeLessThan(200 * 1024)
  expect(file.length).toBeLessThanOrEqual(MAX_IMAGE_BYTES)
  const { width, height, rgba } = unpng(file)
  expect([width, height]).toEqual([690, 645])
  // No ground of its own: where the map draws nothing, the terminal's background shows through.
  expect(pixel({ width, rgba }, 45, 45)[3]).toBe(0)
  expect(String(image?.props.alt)).toContain(stringsFor('ru').title)
  // The rows are still there under it, for a terminal that cannot show the picture as for one that can.
  expect((await ui.find({ type: 'Text', text: /b\/content\.py/ }))?.text).toContain('Файлы')
  await ui.unmount()

  // A pane too narrow to read the map in keeps to the rows.
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 20 } })
  expect(await narrow.find({ type: 'Image' })).toBeUndefined()
  expect((await narrow.find({ type: 'Text', text: /b\/content\.py/ }))?.text).toContain('Файлы')
  await narrow.unmount()
})

test('cells of another shape give the picture as many rows as keep the map round on them', { options: { ...OWN, ...PICTURE, cellShape: 2 } }, async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.columns).toBe(60)
  expect(image?.props.rows).toBe(28)
  await ui.unmount()
})

test('a background colour of the person\'s own gives the terminal picture its ground back', { options: { ...OWN, ...PICTURE, colors: ['background=#123456'] } }, async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const { width, rgba } = unpng(fromBase64(((await ui.find({ type: 'Image' }))?.props.source as { png: string }).png))
  expect(pixel({ width, rgba }, 45, 45)).toEqual([0x12, 0x34, 0x56, 255])
  await ui.unmount()
})

test('the picture moves while something moves, and stands still at rest', { options: PICTURE, timeoutMs: 15_000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const frames: { requestId: string; key: string }[] = []
  on('ui.blit', (_, e) => {
    frames.push({ requestId: e.requestId, key: e.key })
    return { value: {} }
  })
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'Read', file_path: '/a/b/c.py' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await clock.advance(100)
  const probed = frames.length
  expect(probed).toBeGreaterThan(0)
  expect(frames[0]).toMatchObject({ requestId: 'carto-map', key: 'map' })
  // The pulse flies out and back: thirty frames a second.
  await clock.advance(1000)
  expect(frames.length).toBeGreaterThanOrEqual(probed + 28)
  // Nothing runs, so once the station's glow has faded (3.2 s) the core's breath alone sends no frames.
  await clock.advance(3000)
  const landed = frames.length
  await clock.advance(1000)
  expect(frames.length).toBe(landed)
  await ui.unmount()
})

test('a terminal that shows no pictures gets the rows alone', { options: PICTURE }, async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('ui.blit', () => ({ value: { deny: 'the Image draws its alt there' } }))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  await clock.advance(100)
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Nothing yet/ })).toBeDefined()
  await ui.unmount()
})
