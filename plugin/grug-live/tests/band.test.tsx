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
  expect((await ui.find({ type: 'Box' }))?.props.margin).toBe(-1)
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
