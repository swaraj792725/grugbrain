import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { line } from '../hooks/register.tsx'

const status = {
  savedPct: 0.56,
  netUsd: 412,
  tokens: 160000,
  limit: 200000,
  alerts: ['cache expired while idle'],
  recent: 'Trimmed npm test output',
  grug: { act: 'smash', say: 'GRUG SMASH NOISY OUTPUT', short: 'SMASH NOISE', frames: ['🧔🦴   ≋≋≋', '🧔  💥 ≋'], svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' }
}

function world(on: On, lines: (string | undefined)[], toasts: string[]) {
  const clock = mock.clock(on)
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', async () => ({ value: JSON.stringify({ argv: ['node', 'cli.js', 'app-status'] }) }) as any)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(status), stderr: '' } }) as any)
  on('ui.status', ($, e) => {
    lines.push(e.text)
    return { value: undefined } as any
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  return clock
}

test('desktop: the band above the prompt is only grug\'s stage; the footer holds the details as plain text', async ($, on) => {
  const lines: (string | undefined)[] = []
  const toasts: string[] = []
  const clock = world(on, lines, toasts)
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  await clock.advance(1000)
  expect(lines).toEqual(['SMASH NOISE · 56% saved · $412/wk · ctx 160k'])
  expect(toasts).toEqual(['grug: cache expired while idle'])
  const ui = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props.alt).toBe('GRUG SMASH NOISY OUTPUT')
  expect(svg?.props.isInteractive).toBe(true)
  expect(svg?.props.height).toBe(48)
  const box = await ui.find({ type: 'Box' })
  expect(box?.props.marginX).toBe(-1)
  expect(box?.props.marginY).toBe(-2.5)
  expect(svg?.props.width).toBe(125 * 8)
  expect(await ui.find({ text: /SMASH|saved|engine/ })).toBeUndefined()
})

test('a survey keeps the band; the terminal draws no stage', async ($, on) => {
  const lines: (string | undefined)[] = []
  world(on, lines, [])
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true } as any)
  const survey = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: true, isWorking: false, maxRows: 10, bodyColumns: 120 } as any })
  expect(await survey.find({ type: 'Svg' })).toBeUndefined()
  expect(await survey.find({ text: 'engine' })).toBeDefined()
  const term = await $.ui.mount({ plugin: 'grug-live', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any })
  expect(await term.find({ text: 'engine' })).toBeDefined()
  expect(lines.at(-1)).toContain('SMASH NOISE')
})

test('a long footer line drops the weekly dollars first', async ($, on) => {
  expect(line({ savedPct: 0.5, netUsd: 1234, tokens: 900000, limit: 1000000, grug: { act: 'map', say: '', short: 'GRUG DRAW CAVE MAP', frames: [] } })).toBe('GRUG DRAW CAVE MAP · 50% saved · ctx 900k')
  expect(line({ savedPct: 0.5, netUsd: 0.4 })).toBe('grug on · 50% saved')
})

test('the band is there from the first frame: grug asleep in his cave until a status arrives', async ($, on) => {
  const runs: string[][] = []
  const sleep = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('fs.read', async ($, e) => ({ value: e.path.endsWith('stage-sleep.svg') ? sleep : JSON.stringify({ argv: ['node', 'cli.js', 'app-status'] }) }) as any)
  on('process.run', async ($, e) => {
    if (!e.argv.includes('live-ping')) runs.push([...e.argv])
    return { value: { exitCode: 1, stdout: '', stderr: 'grug busy' } } as any
  })
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  await $.session.start({ cwd: '/tmp', surface: 'desktop', isInteractive: true } as any)
  expect(runs[0]).toContain('--start')
  const ui = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any })
  const svg = await ui.find({ type: 'Svg' })
  expect(svg?.props.source).toBe(sleep)
  expect(svg?.props.alt).toBe('GRUG SLEEP IN CAVE')
})

test('the band asked for before session.start still draws grug asleep; a survey is told to doctor', async ($, on) => {
  const pings: string[] = []
  const sleep = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle r="4"/></svg>'
  on('fs.read', async ($, e) => ({ value: e.path.endsWith('stage-sleep.svg') ? sleep : JSON.stringify({ argv: ['node', 'cli.js', 'app-status'] }) }) as any)
  on('process.run', async ($, e) => {
    if (e.argv.includes('live-ping')) pings.push(e.argv.slice(e.argv.indexOf('live-ping') + 1).join(' '))
    return { value: { exitCode: 0, stdout: '', stderr: '' } } as any
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine</Text>
  })
  const props = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any
  const ui = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'AbovePrompt', props })
  expect((await ui.find({ type: 'Svg' }))?.props.source).toBe(sleep)
  const survey = await $.ui.mount({ plugin: 'grug-live', surface: 'desktop', component: 'AbovePrompt', props: { ...props, hasSurvey: true } })
  expect(await survey.find({ type: 'Svg' })).toBeUndefined()
  await new Promise(r => setTimeout(r, 20))
  expect(pings).toContain('skip survey')
})

test('a message from Claude chat starts a turn once the session is idle, and is taken once', async ($, on) => {
  const files = new Map<string, string>()
  const submitted: string[] = []
  const toasts: string[] = []
  const clock = mock.clock(on)
  const B = '/home/.grug/bridge'
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', async () => ({ value: 'sess-1' }) as any)
  on('fs.read', async ($, e) => {
    if (e.path.endsWith('grug.json')) return { value: JSON.stringify({ argv: ['node', 'cli.js', 'app-status'], bridge: B }) } as any
    return { value: files.get(e.path) ?? '' } as any
  })
  on('fs.write', async ($, e) => {
    files.set(e.path, e.text)
    return { value: undefined } as any
  })
  on('fs.exists', async ($, e) => ({ value: files.has(e.path) }) as any)
  on('fs.list', async ($, e) => ({
    value: [...files.keys()].filter(f => f.startsWith(e.path + '/')).map(f => ({ name: f.slice(e.path.length + 1), kind: 'file', size: 1, mtimeMs: 0, isLink: false }))
  }) as any)
  on('process.run', async () => ({ value: { exitCode: 0, stdout: '{}', stderr: '' } }) as any)
  on('ui.status', () => ({ value: undefined }) as any)
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined } as any
  })
  on('prompt.submit', async ($, e) => {
    submitted.push(e.text)
    return { text: e.text } as any
  })
  await $.session.start({ cwd: '/work/shop', surface: 'desktop', isInteractive: true } as any)
  expect(JSON.parse(files.get(`${B}/sessions/sess-1.json`)!)).toMatchObject({ sid: 'sess-1', cwd: '/work/shop', busy: false })
  files.set(`${B}/inbox/m1.json`, JSON.stringify({ id: 'm1', sid: 'sess-1', cwd: '/work/shop', text: 'run the tests', from: 'chat', at: 1 }))
  files.set(`${B}/inbox/m2.json`, JSON.stringify({ id: 'm2', sid: 'other', cwd: '/x', text: 'not mine', from: 'chat', at: 2 }))
  await clock.advance(5000)
  expect(submitted).toHaveLength(1)
  expect(submitted[0]).toContain('run the tests')
  expect(submitted[0]).toContain('id m1')
  expect(submitted[0]).not.toContain('not mine')
  expect(files.has(`${B}/delivered/m1.json`)).toBe(true)
  expect(files.has(`${B}/delivered/m2.json`)).toBe(false)
  expect(toasts).toContain('grug: message from Claude chat')
  await clock.advance(20000)
  expect(submitted).toHaveLength(1)
})
