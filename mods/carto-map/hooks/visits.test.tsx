import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'carto-map',
  component: 'Pane',
  requestId: 'carto-map',
  props: { title: 'Map', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('pressing Network or Browser lists the pages the session visited, and pressing again gives the feed back', async ($, on) => {
  let clock = 1_000_000
  on('clock.now', () => ({ value: clock }))
  on('tool.call', () => ({ result: {} }))
  on('session.id', () => ({ value: 'sess-1' }))

  await $.tool.call({ tool: 'WebFetch', url: 'https://user:secret@docs.example.com/guide/install?v=2', prompt: 'how' })
  clock += 5000
  await $.tool.call({ tool: 'mcp__Claude_Browser__navigate', url: 'http://127.0.0.1:2527/map' })
  await $.tool.call({ tool: 'mcp__Claude_Browser__browser_batch', actions: [{ name: 'navigate', input: { url: 'https://example.org/a' } }, { name: 'computer', input: { action: 'wait' } }, { name: 'navigate', input: { url: 'https://example.org/b' } }] })
  // Not a page: a command, and a search with no address.
  await $.tool.call({ tool: 'Bash', command: 'make', description: 'Build' })
  await $.tool.call({ tool: 'WebSearch', query: 'install guide' })
  clock += 3000

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const stationKeys = async () => (await ui.findAll({ type: 'Button' })).map(b => String(b.props.key)).filter(key => key.startsWith('station-'))
  // One press target per station the session used, and none for the rest.
  expect((await stationKeys()).sort()).toEqual(['station-browser', 'station-shell', 'station-web'])
  // Before a press the pane is the feed, and no page is listed.
  expect((await ui.findAll({ type: 'Link' })).length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /Build/ })).toBeDefined()
  // Control for the narrowing below: the search's row is in the whole feed.
  expect(await ui.find({ type: 'Text', text: /web search/i })).toBeDefined()

  await ui.press({ key: 'station-browser' })
  const browser = (await ui.findAll({ type: 'Link' })).map(link => String(link.props.href))
  // Newest first, each step of the batch its own page, then the way out to the Explorer.
  expect(browser).toEqual(['https://example.org/b', 'https://example.org/a', 'http://localhost:2527/map?session=sess-1&station=browser'])
  // The desktop makes no link of a plain-http address that is not localhost: that page is listed as text.
  expect(await ui.find({ type: 'Text', text: /^127\.0\.0\.1:2527\/map$/ })).toBeDefined()
  // The feed's rows give way to the pages.
  expect(await ui.find({ type: 'Text', text: /Build/ })).toBeUndefined()

  await ui.press({ key: 'station-web' })
  const web = (await ui.findAll({ type: 'Link' })).map(link => String(link.props.href))
  // The login in the address is gone; the search added no page.
  expect(web).toEqual(['https://docs.example.com/guide/install?v=2', 'http://localhost:2527/map?session=sess-1&station=web'])
  expect(web.join(' ')).not.toContain('secret')

  // A station with no pages shows its own rows and no other station's, and still offers the Explorer.
  await ui.press({ key: 'station-shell' })
  expect(await ui.find({ type: 'Text', text: /Build/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /web search/i })).toBeUndefined()
  expect((await ui.findAll({ type: 'Link' })).map(link => String(link.props.href))).toEqual(['http://localhost:2527/map?session=sess-1&station=shell'])

  // Pressed again, the station lets go and the whole feed is back.
  await ui.press({ key: 'station-shell' })
  expect((await ui.findAll({ type: 'Link' })).length).toBe(0)
  await ui.unmount()
})

test('the terminal pane is as lot-map drew it: no station buttons, no page list', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 }))
  on('tool.call', () => ({ result: {} }))
  await $.tool.call({ tool: 'WebFetch', url: 'https://docs.example.com/guide', prompt: 'how' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.findAll({ type: 'Button' })).filter(b => String(b.props.key).startsWith('station-')).length).toBe(0)
  await ui.unmount()
})
