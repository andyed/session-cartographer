import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-cartographer',
  component: 'Pane',
  requestId: 'carto-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

// lot-map's hub, which a light theme keeps, has the row of station buttons. The hub drawn everywhere else names its
// stations and has none.
test('under lot-map\'s hub, pressing Network or Browser lists the pages the session visited, and pressing again gives the feed back', { options: { theme: 'light' } }, async ($, on) => {
  let clock = 1_000_000
  on('clock.now', () => ({ value: clock }))
  on('tool.call', () => ({ result: {} }))
  on('session.id', () => ({ value: 'sess-1' }))
  // The Explorer is running: it answers its health check, naming the logs it reads.
  on('http.fetch', () => ({ value: { status: 200, ok: true, headers: {}, text: '{"status":"ok","files":{"changelog":true}}' } }))

  await $.tool.call({ tool: 'WebFetch', url: 'https://user:secret@docs.example.com/guide/install?v=2', prompt: 'how' })
  clock += 5000
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://127.0.0.1:2527/map' })
  await $.tool.call({ tool: 'mcp__Claude_Browser__browser_batch', actions: [{ name: 'navigate', input: { url: 'https://example.org/a' } }, { name: 'computer', input: { action: 'wait' } }, { name: 'navigate', input: { url: 'https://example.org/b' } }] })
  // Not a page: a command, and a search with no address.
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build' })
  await $.tool.call({ tool: 'WebSearch', query: 'install guide', mode: 'standard' })
  // A file only read, then a file changed. The two fold into one row, which is the newer of them: the change.
  await $.tool.call({ tool: 'Read', file_path: '/Users/x/dev/app/src/c.ts' })
  await $.tool.call({ tool: 'Edit', file_path: '/Users/x/dev/app/src/a b.ts', old_string: 'a', new_string: 'b' })
  clock += 3000

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Every row's station name is a link to that station in the Explorer; this test is about the others: where a row
  // went, the pages listed, and the one link under them all.
  const others = async () => (await ui.findAll({ type: 'Link' })).filter(link => !(String(link.props.href).includes('&station=') && link.props.label !== '↗ Explorer')).map(link => String(link.props.href))
  // Control for that filter: the rows' own station links are there to be left out.
  const stationNames = async () => (await ui.findAll({ type: 'Link' })).filter(link => String(link.props.href).includes('&station=') && link.props.label !== '↗ Explorer').map(link => String(link.props.label))
  const stationKeys = async () => (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(key => key.startsWith('station-'))
  // One press target per station the session used, and none for the rest.
  expect((await stationKeys()).sort()).toEqual(['station-browser', 'station-files', 'station-shell', 'station-web'])
  // Before a press the pane is the feed. A row that went to a page links to it (the first page of a batch), and a
  // row that changed a file links to the Explorer's review of that file in this session; the link to the Explorer
  // is the last thing in the pane. A plain-http page that is not localhost, a command and a search are rows with no
  // link, and so is a file only read (control: a second mount below, with the read last, has no review link).
  // The feed is newest first.
  const whole = ['http://localhost:2527/memory?session=sess-1&file=%2FUsers%2Fx%2Fdev%2Fapp%2Fsrc%2Fa%20b.ts&review=changes', 'https://example.org/a', 'https://docs.example.com/guide/install?v=2', 'http://localhost:2527/map?session=sess-1']
  expect((await others())).toEqual(whole)
  expect([...new Set(await stationNames())].sort()).toEqual(['Browser', 'Files', 'Network', 'Shell'])
  expect(await ui.find({ type: 'Text', text: /Build/ })).toBeDefined()
  // Control for the narrowing below: the search's row is in the whole feed.
  expect(await ui.find({ type: 'Text', text: /web search/i })).toBeDefined()

  await ui.press({ key: 'station-browser' })
  const browser = (await others())
  // The pages newest first, each step of the batch its own; then the Explorer's link, now at this station.
  expect(browser).toEqual(['https://example.org/b', 'https://example.org/a', 'http://localhost:2527/map?session=sess-1&station=browser'])
  // The desktop makes no link of a plain-http address that is not localhost: that page is listed as text.
  expect(await ui.find({ type: 'Text', text: /^127\.0\.0\.1:2527\/map$/ })).toBeDefined()
  // The feed's rows give way to the pages.
  expect(await ui.find({ type: 'Text', text: /Build/ })).toBeUndefined()

  await ui.press({ key: 'station-web' })
  const web = (await others())
  // The login in the address is gone; the search added no page.
  expect(web).toEqual(['https://docs.example.com/guide/install?v=2', 'http://localhost:2527/map?session=sess-1&station=web'])
  expect(web.join(' ')).not.toContain('secret')

  // A station with no pages shows its own rows and no other station's, and still offers the Explorer.
  await ui.press({ key: 'station-shell' })
  expect(await ui.find({ type: 'Text', text: /Build/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /web search/i })).toBeUndefined()
  expect((await others())).toEqual(['http://localhost:2527/map?session=sess-1&station=shell'])

  // Pressed again, the station lets go and the whole feed is back.
  await ui.press({ key: 'station-shell' })
  expect((await others())).toEqual(whole)
  await ui.unmount()

  // Control: with a read the newest of the Files rows, the folded row is the read, and it is no link.
  await $.tool.call({ tool: 'Read', file_path: '/Users/x/dev/app/src/c.ts' })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await after.findAll({ type: 'Link' })).map(link => String(link.props.href)).filter(href => href.includes('/memory?')).length).toBe(0)
  await after.unmount()
})

test('the terminal pane is as lot-map drew it: no station buttons, no page list', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'WebFetch', url: 'https://docs.example.com/guide', prompt: 'how' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('station-')).length).toBe(0)
  await ui.unmount()
})

// The pane is one part of a plugin a person may want for its recall alone.
test('with the work map switched off, the plugin opens no pane and adds no command', { options: { workMap: false } }, async ($, on) => {
  let opened = 0
  let registered = 0
  on('ui.open', () => {
    opened++
    return { value: { isPlaced: true } }
  })
  on('command.register', () => {
    registered++
    return { value: { command: 'carto-map' } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Read', file_path: '/a/b/content.py' })

  expect(opened).toBe(0)
  expect(registered).toBe(0)
})
